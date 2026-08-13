#!/usr/bin/env node
/**
 * Bundle the viewer into dist/.
 *
 * Everything is bundled rather than pulled from a CDN at runtime: this is
 * client-facing work, and a third-party CDN outage should not be able to take
 * a client's map down. It also keeps the page working under a strict CSP.
 */

import { cp, mkdir, rm, access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as esbuild from 'esbuild';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const serve = process.argv.includes('--serve');

const exists = async (p) => access(p).then(() => true, () => false);

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const buildOptions = {
  entryPoints: [join(ROOT, 'viewer', 'src', 'main.js')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  splitting: true,
  outdir: join(DIST, 'assets'),
  minify: !serve,
  sourcemap: serve,
  logLevel: 'info',
  loader: { '.png': 'dataurl', '.svg': 'dataurl' },
};

async function copyStatic() {
  await cp(join(ROOT, 'viewer', 'index.html'), join(DIST, 'index.html'));
  await cp(join(ROOT, 'viewer', 'styles.css'), join(DIST, 'styles.css'));

  // Published manifests. Encrypted, so shipping them to a public site is fine.
  if (await exists(join(ROOT, 'projects'))) {
    await cp(join(ROOT, 'projects'), join(DIST, 'projects'), { recursive: true });
  }

  // Tells Pages not to run the output through Jekyll, which would otherwise
  // silently drop files and directories beginning with an underscore.
  await writeFile(join(DIST, '.nojekyll'), '');
}

if (serve) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  await copyStatic();
  const { host, port } = await ctx.serve({ servedir: DIST, port: 5173 });
  console.log(`\n  Viewer dev server: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n`);
} else {
  await esbuild.build(buildOptions);
  await copyStatic();
  console.log('\n  Built viewer -> dist/\n');
}
