import { execFileSync } from 'node:child_process';

/**
 * GitHub caps a single release asset at 2 GiB. We split at 1.9 GiB to leave
 * headroom — the cap is enforced on the raw byte count, and running right up
 * to it has been reported to fail intermittently.
 */
export const PART_SIZE = 1900 * 1024 * 1024;

/** Files we lift out of the backup so they get their own download link. */
export const EXTRACT_ASSETS = [
  { inZip: 'backup.json', as: 'backup.json', label: 'Task metadata' },
  { inZip: 'odm_report/report.pdf', as: 'report.pdf', label: 'Quality report (PDF)' },
  { inZip: 'odm_report/shots.geojson', as: 'shots.geojson', label: 'Camera shots (GeoJSON)' },
  { inZip: 'cameras.json', as: 'cameras.json', label: 'Camera parameters' },
  { inZip: 'odm_orthophoto/odm_orthophoto.tif', as: 'orthophoto.tif', label: 'Orthophoto (GeoTIFF)' },
];

/** Assets that stay inside the backup zip; surfaced in the UI for reference. */
export const BUNDLED_ASSETS = [
  { inZip: 'odm_dem/dsm.tif', label: 'Surface model (DSM)' },
  { inZip: 'odm_dem/dtm.tif', label: 'Terrain model (DTM)' },
  { inZip: 'odm_georeferencing/odm_georeferenced_model.laz', label: 'Point cloud (LAZ)' },
  { inZip: 'odm_texturing/odm_textured_model_geo.glb', label: 'Textured model (GLB)' },
];

function detectRepo() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // git@github.com:owner/repo.git  |  https://github.com/owner/repo.git
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {
    /* not a git repo, or no origin — fall through to the error below */
  }
  return null;
}

export function loadConfig({ requireToken = true } = {}) {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (requireToken && !token) {
    throw new Error(
      'GITHUB_TOKEN is not set.\n\n' +
        '  1. cp uploader/.env.example uploader/.env\n' +
        '  2. Create a fine-grained token scoped to this repo with\n' +
        '     Contents: Read and write —\n' +
        '     https://github.com/settings/personal-access-tokens/new\n' +
        '  3. Paste it into uploader/.env as GITHUB_TOKEN=...\n'
    );
  }

  const slug = process.env.GITHUB_REPO?.trim() || detectRepo();
  if (!slug || !slug.includes('/')) {
    throw new Error(
      'Could not determine the target repository. Set GITHUB_REPO=owner/repo in uploader/.env.'
    );
  }

  const [owner, repo] = slug.split('/');
  return {
    token,
    owner,
    repo,
    slug,
    port: Number(process.env.PORT) || 4000,
    pagesUrl: `https://${owner}.github.io/${repo}/`,
  };
}
