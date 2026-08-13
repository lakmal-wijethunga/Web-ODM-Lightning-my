#!/usr/bin/env node
/**
 * Rebuild docs/manifest.json from the repository's releases.
 *
 * The releases are the source of truth — every one carries its metadata in its
 * body — so the manifest can always be regenerated. Run this after editing or
 * deleting a release by hand. The GitHub Action calls the same code path.
 */
import { loadConfig } from '../lib/config.js';
import { GitHub } from '../lib/github.js';
import { rebuildManifest } from '../lib/pipeline.js';
import { formatBytes } from '../lib/manifest.js';

try {
  const config = loadConfig();
  const gh = new GitHub(config);
  const manifest = await rebuildManifest({ gh, config });

  console.log(
    `Rebuilt manifest for ${config.slug}:\n` +
      `  ${manifest.stats.projects} projects, ${manifest.stats.tasks} tasks, ` +
      `${formatBytes(manifest.stats.totalBytes)} archived.`
  );
} catch (err) {
  console.error('\n' + err.message);
  process.exit(1);
}
