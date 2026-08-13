import { stat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PART_SIZE, EXTRACT_ASSETS, BUNDLED_ASSETS } from './config.js';
import { planParts } from './split.js';
import { extractEntries, parseBackupJson, listEntries } from './zip.js';
import { buildFootprint } from './preview.js';
import { buildManifest, encodeBody, humanBody, formatBytes } from './manifest.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const TMP = path.join(ROOT, 'uploader', '.tmp');

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60) || 'task'
  );
}

/**
 * Inspect a backup without uploading anything, so the UI can show what it
 * found and let the user confirm before a multi-GB transfer begins.
 */
export async function inspect(zipPath) {
  const { size } = await stat(zipPath);
  const scratch = path.join(TMP, 'inspect-' + Date.now());

  try {
    const found = await extractEntries(zipPath, ['backup.json', 'odm_report/shots.geojson'], scratch);
    const backup = parseBackupJson(found.get('backup.json')?.buffer);
    const footprint = buildFootprint({
      crop: backup?.crop,
      shotsBuffer: found.get('odm_report/shots.geojson')?.buffer,
    });

    const entries = await listEntries(zipPath);
    const has = (p) => entries.some((e) => e.path === p || e.path.endsWith('/' + p));

    return {
      size,
      sizeLabel: formatBytes(size),
      willSplit: size > PART_SIZE,
      partCount: Math.ceil(size / PART_SIZE),
      // A raw ODM all.zip has no backup.json; fall back to the filename so the
      // upload still works instead of hard-failing.
      recognised: Boolean(backup),
      name: backup?.name || path.basename(zipPath, '.zip'),
      createdAt: backup?.createdAt ?? null,
      processingTime: backup?.processingTime ?? null,
      options: backup?.options ?? [],
      tags: backup?.tags ?? [],
      imageCount: footprint?.imageCount ?? null,
      hasFootprint: Boolean(footprint),
      available: [...EXTRACT_ASSETS, ...BUNDLED_ASSETS]
        .filter((a) => has(a.inZip))
        .map((a) => ({ name: a.as ?? a.inZip.split('/').pop(), label: a.label })),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Full upload. `emit(event)` streams progress to the browser over SSE.
 */
export async function upload({ gh, config, zipPath, project, taskName, emit }) {
  const log = (message, extra = {}) => emit({ type: 'log', message, ...extra });
  const { size } = await stat(zipPath);

  const name = taskName?.trim() || path.basename(zipPath, '.zip');
  const projectName = project?.trim() || 'Unsorted';
  const tag = `task-${slugify(projectName)}-${slugify(name)}`;
  const scratch = path.join(TMP, tag);

  try {
    await mkdir(scratch, { recursive: true });

    // ---- 1. read metadata + pull out the individually-downloadable assets
    log('Reading backup contents…');
    const wanted = EXTRACT_ASSETS.map((a) => a.inZip);
    const found = await extractEntries(zipPath, wanted, scratch);
    const backup = parseBackupJson(found.get('backup.json')?.buffer);

    if (!backup) {
      log('No backup.json found — this may be a raw ODM archive. Using filename metadata.', {
        level: 'warn',
      });
    }

    const footprint = buildFootprint({
      crop: backup?.crop,
      shotsBuffer: found.get('odm_report/shots.geojson')?.buffer,
    });
    if (!footprint) log('No georeferencing found; this task will have no map preview.', { level: 'warn' });

    const entries = await listEntries(zipPath);
    const bundled = BUNDLED_ASSETS.filter((a) =>
      entries.some((e) => e.path === a.inZip || e.path.endsWith('/' + a.inZip))
    ).map((a) => ({ name: a.inZip.split('/').pop(), label: a.label }));

    // ---- 2. create (or reuse) the release
    const meta = {
      kind: 'webodm-task',
      project: projectName,
      name,
      createdAt: backup?.createdAt ?? null,
      processingTime: backup?.processingTime ?? null,
      options: backup?.options ?? [],
      tags: backup?.tags ?? [],
      imageCount: footprint?.imageCount ?? null,
      bundled,
      footprint: footprint ? `previews/${tag}.geojson` : null,
      bbox: footprint?.bbox ?? null,
      center: footprint?.center ?? null,
      status: 'archived',
    };

    const split = size > PART_SIZE;
    const body = encodeBody(
      meta,
      humanBody({
        project: projectName,
        name,
        createdAt: meta.createdAt,
        imageCount: meta.imageCount,
        totalBytes: size,
        split,
      })
    );

    let release = await gh.getReleaseByTag(tag);
    if (release) {
      log(`Existing release ${tag} found — resuming.`);
      await gh.updateRelease(release.id, { name, body });
      release = await gh.getReleaseByTag(tag);
    } else {
      log(`Creating release ${tag}…`);
      release = await gh.createRelease({ tag, name, body });
    }

    const existing = new Map((release.assets ?? []).map((a) => [a.name, a]));

    // ---- 3. plan the uploads
    //
    // Parts are byte ranges of the original file, never written to disk, so a
    // 6 GB backup uploads without needing 6 GB of scratch space.
    const jobs = planParts(size).map((p) => ({ ...p, filePath: zipPath }));

    for (const asset of EXTRACT_ASSETS) {
      const hit = found.get(asset.inZip);
      if (!hit || hit.size === 0) continue;
      jobs.push({ name: asset.as, filePath: hit.file, start: 0, end: hit.size - 1, size: hit.size });
    }

    const totalBytes = jobs.reduce((s, j) => s + j.size, 0);
    emit({ type: 'plan', jobs: jobs.map((j) => ({ name: j.name, size: j.size })), totalBytes, split, tag });

    // ---- 4. upload
    let done = 0;
    for (const job of jobs) {
      const already = existing.get(job.name);
      if (already && already.size === job.size) {
        log(`Skipping ${job.name} — already uploaded (${formatBytes(job.size)}).`);
        done += job.size;
        emit({ type: 'progress', asset: job.name, assetSent: job.size, assetTotal: job.size, done, totalBytes });
        continue;
      }
      // A half-finished asset from an interrupted run must go before retrying.
      if (already) {
        log(`Replacing incomplete ${job.name}…`);
        await gh.deleteAsset(already.id);
      }

      log(`Uploading ${job.name} (${formatBytes(job.size)})…`);
      let last = 0;
      await gh.uploadAsset({
        releaseId: release.id,
        name: job.name,
        filePath: job.filePath,
        start: job.start,
        end: job.end,
        onProgress: (sent) => {
          // Throttle: one event per ~2 MB keeps the SSE stream light.
          if (sent - last < 2 * 1024 * 1024 && sent !== job.size) return;
          last = sent;
          emit({
            type: 'progress',
            asset: job.name,
            assetSent: sent,
            assetTotal: job.size,
            done: done + sent,
            totalBytes,
          });
        },
      });
      done += job.size;
    }

    // ---- 5. commit the footprint + regenerated manifest in one commit
    log('Updating dashboard manifest…');
    const releases = await gh.listReleases();
    const manifest = buildManifest(releases, { slug: config.slug });

    const files = [{ path: 'docs/manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' }];
    if (footprint) {
      files.push({
        path: `docs/previews/${tag}.geojson`,
        content: JSON.stringify(footprint.geojson) + '\n',
      });
    }
    await gh.commitFiles(files, `Archive task: ${projectName} / ${name}`);

    emit({
      type: 'done',
      tag,
      releaseUrl: release.html_url,
      pagesUrl: config.pagesUrl,
      split,
      parts: jobs.filter((j) => j.name.startsWith('backup.zip')).map((j) => j.name),
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Rebuild manifest.json from the releases alone. Used by the CLI + Action. */
export async function rebuildManifest({ gh, config }) {
  const releases = await gh.listReleases();
  const manifest = buildManifest(releases, { slug: config.slug });
  await gh.commitFiles(
    [{ path: 'docs/manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' }],
    'Rebuild manifest from releases'
  );
  return manifest;
}
