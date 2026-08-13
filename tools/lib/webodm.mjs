/**
 * Locating assets inside an extracted WebODM task backup.
 *
 * Layout varies more than the docs suggest: a task exported from WebODM
 * Desktop may or may not have a wrapping top-level directory, DEMs are absent
 * unless DSM/DTM were enabled, and the point cloud may already be COPC (newer
 * ODM) or only plain LAZ. So rather than hardcoding paths we walk the tree
 * once and match on the relative path tail.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * kind      role in the viewer
 * match     matched against the POSIX-normalised relative path
 * required  publish fails without it
 */
export const ASSET_SPECS = [
  {
    kind: 'orthophoto',
    label: 'Orthophoto',
    match: /odm_orthophoto\/odm_orthophoto\.tif$/i,
    required: true,
  },
  { kind: 'dsm', label: 'Surface model (DSM)', match: /odm_dem\/dsm\.tif$/i, required: false },
  { kind: 'dtm', label: 'Terrain model (DTM)', match: /odm_dem\/dtm\.tif$/i, required: false },
  {
    kind: 'pointcloud_copc',
    label: 'Point cloud (COPC)',
    match: /(^|\/)(.*\.copc\.laz)$/i,
    required: false,
  },
  {
    kind: 'pointcloud_laz',
    label: 'Point cloud',
    match: /odm_georeferencing\/odm_georeferenced_model\.laz$/i,
    required: false,
  },
  { kind: 'report', label: 'Processing report', match: /odm_report\/report\.pdf$/i, required: false },
  { kind: 'shots', label: 'Camera shots', match: /odm_report\/shots\.geojson$/i, required: false },
];

/** Directories that are large and never useful to us — skipping them saves real time. */
const SKIP_DIRS = new Set([
  'entwine_pointcloud', // superseded by COPC; thousands of files
  'opensfm', // intermediate SfM state
  'images', // raw input imagery, often tens of GB
  'thumbs',
]);

async function* walk(dir, root = dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — nothing useful in it
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      yield* walk(full, root);
    } else if (entry.isFile()) {
      yield { full, rel: relative(root, full).split(sep).join('/') };
    }
  }
}

/**
 * Returns a map of kind -> { path, rel, bytes }. When both a COPC and a plain
 * LAZ are present the COPC wins and conversion is skipped entirely, which is
 * the single biggest time saver on a modern ODM export.
 */
export async function discoverAssets(rootDir) {
  const found = new Map();

  for await (const file of walk(rootDir)) {
    for (const spec of ASSET_SPECS) {
      if (!spec.match.test(file.rel)) continue;
      if (found.has(spec.kind)) continue;

      const { size } = await stat(file.full);
      found.set(spec.kind, { kind: spec.kind, label: spec.label, path: file.full, rel: file.rel, bytes: size });
    }
  }

  const missing = ASSET_SPECS.filter((s) => s.required && !found.has(s.kind));
  if (missing.length) {
    throw new Error(
      `This does not look like a WebODM task backup — could not find: ` +
        `${missing.map((m) => m.label).join(', ')}. ` +
        `Make sure you exported the full task assets, not just the orthophoto.`,
    );
  }

  return found;
}

/** Human-readable byte size for log output. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
