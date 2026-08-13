#!/usr/bin/env node
/**
 * Publish a WebODM task backup as a private, streamable client link.
 *
 *   1. Ingest   pull the .zip from Drive (or use a local one for testing)
 *   2. Convert  orthophoto/DEMs -> COG, point cloud -> COPC
 *   3. Upload   derivatives + originals to the configured storage driver
 *   4. Manifest encrypt asset URLs with the viewer password and commit it
 *
 * Only the encrypted manifest ever lands in this repo. Nothing about a project
 * is discoverable from the repo without its password.
 */

import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { join, resolve, basename } from 'node:path';

import { encryptManifest } from '../shared/crypto.mjs';
import { createStorage, createDriveStorage } from './lib/storage/index.mjs';
import { discoverAssets, formatBytes } from './lib/webodm.mjs';
import {
  checkTools,
  toCog,
  toCopc,
  rasterInfo,
  boundsFromInfo,
  pointCloudInfo,
} from './lib/convert.mjs';

const exec = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORK_DIR = join(REPO_ROOT, '.work');

const log = (msg) => console.log(`  ${msg}`);
const step = (msg) => console.log(`\n▸ ${msg}`);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

/** 64 bits of randomness — enough that share links cannot be enumerated. */
const generateSlug = () => randomBytes(8).toString('hex');

async function extractZip(zipPath, destDir) {
  await mkdir(destDir, { recursive: true });

  if (process.platform === 'win32') {
    // Expand-Archive is slow on multi-GB inputs but avoids requiring a
    // separate unzip binary for local testing on Windows.
    await exec(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`],
      { maxBuffer: 32 * 1024 * 1024, timeout: 60 * 60 * 1000 },
    );
  } else {
    await exec('unzip', ['-q', '-o', zipPath, '-d', destDir], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60 * 60 * 1000,
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;

  const slug = args.slug || env.SLUG || generateSlug();
  const title = args.title || env.TITLE || 'Untitled survey';
  const password = args.password || env.VIEWER_PASSWORD;
  const sourceFileId = args['drive-file-id'] || env.SOURCE_DRIVE_FILE_ID;
  const localZip = args.zip || env.SOURCE_ZIP;
  const includeOriginals = (env.INCLUDE_ORIGINALS ?? '1') !== '0';
  const skipPointCloud = env.SKIP_POINTCLOUD === '1';

  if (!password) {
    throw new Error('A viewer password is required (--password or VIEWER_PASSWORD).');
  }
  if (!sourceFileId && !localZip) {
    throw new Error('Provide --drive-file-id <id> or --zip <path>.');
  }

  console.log(`\nPublishing "${title}"  [slug: ${slug}]`);

  step('Checking toolchain');
  const versions = await checkTools({ needPdal: !skipPointCloud });
  log(Object.entries(versions).map(([k, v]) => `${k}: ${v}`).join('   '));

  const storage = createStorage(env);
  log(`storage driver: ${storage.name}`);

  const taskDir = join(WORK_DIR, slug);
  const extractDir = join(taskDir, 'extracted');
  const outDir = join(taskDir, 'out');
  await rm(taskDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // ---- 1. Ingest -----------------------------------------------------------
  step('Fetching task backup');
  let zipPath;
  if (localZip) {
    zipPath = resolve(localZip);
    const { size } = await stat(zipPath);
    log(`${basename(zipPath)} (${formatBytes(size)}) from disk`);
  } else {
    // Ingest always goes through Drive even when serving elsewhere: the source
    // zip lives in your Drive regardless of which backend serves the output.
    const drive = createDriveStorage({ env });
    const meta = await drive.getMetadata(sourceFileId);
    zipPath = join(taskDir, meta.name || 'task.zip');
    await mkdir(taskDir, { recursive: true });

    log(`${meta.name} (${formatBytes(Number(meta.size ?? 0))})`);
    let lastPct = -1;
    await drive.download(sourceFileId, zipPath, {
      onProgress: ({ received, total }) => {
        const pct = total ? Math.floor((received / total) * 100) : 0;
        if (pct >= lastPct + 10) {
          lastPct = pct;
          process.stdout.write(`    downloaded ${pct}%\r`);
        }
      },
    });
    console.log('');
  }

  step('Extracting');
  await extractZip(zipPath, extractDir);

  const assets = await discoverAssets(extractDir);
  for (const asset of assets.values()) {
    log(`found ${asset.label.padEnd(22)} ${formatBytes(asset.bytes)}`);
  }

  // ---- 2. Convert ----------------------------------------------------------
  step('Converting to web formats');
  const derived = [];

  const ortho = assets.get('orthophoto');
  const orthoCog = join(outDir, 'orthophoto.tif');
  log('orthophoto -> COG (1024px tiles, reprojected to Web Mercator)');
  await toCog(ortho.path, orthoCog, { elevation: false });
  const orthoInfo = await rasterInfo(orthoCog);
  derived.push({ kind: 'orthophoto', path: orthoCog, info: orthoInfo });

  for (const kind of ['dsm', 'dtm']) {
    const dem = assets.get(kind);
    if (!dem) continue;
    const out = join(outDir, `${kind}.tif`);
    log(`${kind} -> COG (Float32, lossless)`);
    await toCog(dem.path, out, { elevation: true });
    derived.push({ kind, path: out, info: await rasterInfo(out) });
  }

  let cloud = null;
  if (!skipPointCloud) {
    const existingCopc = assets.get('pointcloud_copc');
    const rawLaz = assets.get('pointcloud_laz');

    if (existingCopc) {
      log('point cloud already COPC — skipping conversion');
      cloud = { path: existingCopc.path, info: await pointCloudInfo(existingCopc.path) };
    } else if (rawLaz) {
      const out = join(outDir, 'pointcloud.copc.laz');
      log('point cloud -> COPC');
      await toCopc(rawLaz.path, out);
      cloud = { path: out, info: await pointCloudInfo(out) };
    } else {
      log('no point cloud in this task — 3D tab will be hidden');
    }
  }

  // ---- 3. Upload -----------------------------------------------------------
  step('Uploading');
  const folderId = await storage.ensureProjectFolder(slug);

  const onProgress = ({ uploaded, total, name }) => {
    const pct = total ? Math.floor((uploaded / total) * 100) : 100;
    process.stdout.write(`    ${name} ${pct}%\r`);
  };

  const layers = {};
  for (const item of derived) {
    const uploaded = await storage.upload(item.path, { folderId, onProgress });
    console.log('');
    layers[item.kind] = {
      url: uploaded.url,
      bytes: uploaded.bytes,
      format: 'cog',
      bounds: boundsFromInfo(item.info),
      bands: item.info?.bands?.length ?? null,
    };
    log(`${item.kind.padEnd(12)} ${formatBytes(uploaded.bytes)}`);
  }

  if (cloud) {
    const uploaded = await storage.upload(cloud.path, {
      folderId,
      name: 'pointcloud.copc.laz',
      onProgress,
    });
    console.log('');
    layers.pointcloud = {
      url: uploaded.url,
      bytes: uploaded.bytes,
      format: 'copc',
      points: cloud.info.points,
      bounds: cloud.info.bounds,
    };
    log(`pointcloud   ${formatBytes(uploaded.bytes)} (${cloud.info.points ?? '?'} points)`);
  }

  const downloads = [];
  if (includeOriginals) {
    step('Uploading original assets for client download');
    for (const asset of assets.values()) {
      const uploaded = await storage.upload(asset.path, {
        folderId: `${folderId}`,
        name: `original-${basename(asset.rel)}`,
        onProgress,
      });
      console.log('');
      downloads.push({
        label: asset.label,
        name: basename(asset.rel),
        url: uploaded.url,
        bytes: uploaded.bytes,
      });
    }
  }

  // ---- 4. Manifest ---------------------------------------------------------
  step('Writing encrypted manifest');
  const manifest = {
    version: 1,
    slug,
    title,
    client: args.client || env.CLIENT || null,
    capturedOn: args['captured-on'] || env.CAPTURED_ON || null,
    publishedAt: new Date().toISOString(),
    brand: {
      color: env.BRAND_COLOR || '#2563eb',
      logoUrl: env.BRAND_LOGO_URL || null,
      organisation: env.BRAND_ORG || null,
    },
    bounds: layers.orthophoto?.bounds ?? null,
    layers,
    downloads,
  };

  const envelope = await encryptManifest(manifest, password);
  const projectDir = join(REPO_ROOT, 'projects', slug);
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'manifest.enc'), JSON.stringify(envelope), 'utf8');
  log(`projects/${slug}/manifest.enc`);

  if (env.KEEP_WORK !== '1') {
    await rm(taskDir, { recursive: true, force: true });
  }

  const base = env.SITE_BASE_URL || 'https://<user>.github.io/<repo>';
  console.log(`\n✓ Published\n\n    ${base}/#/${slug}\n\n  Password: (the one you supplied)\n`);
}

main().catch((err) => {
  console.error(`\n✗ Publish failed\n\n  ${err.message}\n`);
  process.exitCode = 1;
});
