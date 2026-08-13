#!/usr/bin/env node
/**
 * Measure what a client actually experiences.
 *
 * The 2D viewer's responsiveness is dominated by per-range-request latency,
 * not bandwidth: a COG read costs roughly one HTTP request per tile touched.
 * This reproduces that access pattern — many scattered small reads — and
 * reports the distribution, so the Drive-vs-CDN decision is made on numbers
 * from your own data rather than on vibes.
 *
 * Usage:
 *   node tools/benchmark.mjs <url> [--requests 24] [--size 65536]
 *   node tools/benchmark.mjs --slug <slug> --password <pw>
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decryptManifest } from '../shared/crypto.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function totalSize(url) {
  const response = await fetch(url, { method: 'HEAD' });
  if (!response.ok) throw new Error(`HEAD failed (${response.status}) for ${url}`);

  const length = Number(response.headers.get('content-length'));
  return {
    bytes: Number.isFinite(length) ? length : 0,
    acceptRanges: response.headers.get('accept-ranges'),
    exposed: response.headers.get('access-control-expose-headers') ?? '',
  };
}

async function timeRange(url, start, end) {
  const began = performance.now();
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!response.ok && response.status !== 206) {
    throw new Error(`Range request failed (${response.status})`);
  }
  // Drain the body so we measure through to usable bytes, not just headers.
  await response.arrayBuffer();
  return { ms: performance.now() - began, status: response.status };
}

async function benchmark(url, { requests, chunkBytes }) {
  console.log(`\n  ${url.slice(0, 96)}${url.length > 96 ? '…' : ''}`);

  const head = await totalSize(url);
  if (!head.bytes) {
    console.log('  ! HEAD returned no Content-Length — cannot pick random offsets.');
    return null;
  }

  const exposesRange = /content-range/i.test(head.exposed);
  console.log(
    `  size ${(head.bytes / 1024 / 1024).toFixed(1)} MB   ` +
      `accept-ranges: ${head.acceptRanges ?? 'none'}   ` +
      `exposes Content-Range to JS: ${exposesRange ? 'yes' : 'no'}`,
  );

  const samples = [];
  let partial = 0;

  for (let i = 0; i < requests; i += 1) {
    const start = Math.floor(Math.random() * Math.max(1, head.bytes - chunkBytes));
    const { ms, status } = await timeRange(url, start, start + chunkBytes - 1);
    samples.push(ms);
    if (status === 206) partial += 1;
    process.stdout.write(`  sampling ${i + 1}/${requests}\r`);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

  console.log(' '.repeat(30));
  console.log(`  206 responses     ${partial}/${requests}`);
  console.log(`  median            ${percentile(sorted, 50).toFixed(0)} ms`);
  console.log(`  mean              ${mean.toFixed(0)} ms`);
  console.log(`  p90               ${percentile(sorted, 90).toFixed(0)} ms`);
  console.log(`  min / max         ${sorted[0].toFixed(0)} / ${sorted.at(-1).toFixed(0)} ms`);

  // A viewport typically touches ~12-20 tiles; browsers open ~6 connections.
  const estimate = (percentile(sorted, 50) * 16) / 6;
  console.log(`  est. pan/zoom     ~${(estimate / 1000).toFixed(1)} s  (16 tiles, 6 parallel)`);

  return { median: percentile(sorted, 50), estimate };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const requests = Number(args.requests ?? 24);
  const chunkBytes = Number(args.size ?? 65536);

  let urls = [];

  if (args.slug) {
    if (!args.password) throw new Error('--slug also needs --password to decrypt the manifest.');
    const raw = await readFile(join(REPO_ROOT, 'projects', args.slug, 'manifest.enc'), 'utf8');
    const manifest = await decryptManifest(JSON.parse(raw), args.password);

    urls = Object.entries(manifest.layers ?? {})
      .filter(([, spec]) => spec?.url)
      .map(([kind, spec]) => ({ label: kind, url: spec.url }));

    console.log(`\nBenchmarking "${manifest.title}" (${urls.length} layers)`);
  } else if (args._[0]) {
    urls = [{ label: 'url', url: args._[0] }];
  } else {
    console.log(
      '\nUsage:\n' +
        '  node tools/benchmark.mjs <url>\n' +
        '  node tools/benchmark.mjs --slug <slug> --password <pw>\n\n' +
        'Options:\n' +
        '  --requests N   number of range requests (default 24)\n' +
        '  --size N       bytes per request (default 65536)\n',
    );
    return;
  }

  const results = [];
  for (const entry of urls) {
    console.log(`\n── ${entry.label} ${'─'.repeat(Math.max(0, 40 - entry.label.length))}`);
    const result = await benchmark(entry.url, { requests, chunkBytes });
    if (result) results.push({ ...result, label: entry.label });
  }

  if (results.length) {
    const worst = Math.max(...results.map((r) => r.estimate));
    console.log(
      `\n  Verdict: ${
        worst < 500
          ? 'excellent — CDN-class latency.'
          : worst < 1500
            ? 'good — interaction will feel responsive.'
            : worst < 3500
              ? 'usable but sluggish. Consider STORAGE_DRIVER=huggingface.'
              : 'poor. Switch to a CDN-backed backend (STORAGE_DRIVER=huggingface).'
      }\n`,
    );
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exitCode = 1;
});
