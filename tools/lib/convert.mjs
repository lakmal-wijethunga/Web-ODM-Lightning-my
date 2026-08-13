/**
 * GDAL/PDAL conversion.
 *
 * Two decisions here are driven directly by the Drive latency measurement
 * (median 0.64s per range request against a real 347MB asset):
 *
 *   1. BLOCKSIZE=1024 rather than the 512 default. A COG read costs roughly
 *      one request per tile touched, so quadrupling tile area cuts the request
 *      count for a given viewport by ~4x. On a CDN that would be a wash; over
 *      Drive, request count is the thing that hurts.
 *
 *   2. Overviews are always built. Without them a zoomed-out view reads full-
 *      resolution tiles across the whole scene, which over Drive is the
 *      difference between "a moment" and "a minute".
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Conversions on GB-scale rasters legitimately take a long time. */
const EXEC_OPTS = { maxBuffer: 64 * 1024 * 1024, timeout: 90 * 60 * 1000 };

export const WEB_MERCATOR = 'EPSG:3857';

async function run(command, args, { label } = {}) {
  try {
    const { stdout } = await exec(command, args, EXEC_OPTS);
    return stdout;
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').toString().trim();
    throw new Error(`${label ?? command} failed: ${detail.split('\n').slice(-6).join('\n')}`);
  }
}

/** Fail fast with an actionable message rather than deep inside a 40-minute job. */
export async function checkTools({ needPdal = true } = {}) {
  const versions = {};

  try {
    versions.gdal = (await run('gdalinfo', ['--version'])).trim();
  } catch {
    throw new Error(
      'GDAL not found on PATH. The publish workflow installs it with ' +
        '"apt-get install -y gdal-bin"; locally, use conda or OSGeo4W.',
    );
  }

  if (needPdal) {
    try {
      versions.pdal = (await run('pdal', ['--version'])).trim().split('\n')[0];
    } catch {
      throw new Error(
        'PDAL not found on PATH. COPC output needs PDAL 2.4+ ("apt-get install -y pdal"). ' +
          'Set SKIP_POINTCLOUD=1 to publish 2D layers only.',
      );
    }
  }

  return versions;
}

/** gdalinfo -json, parsed. Source of bounds and band metadata for the manifest. */
export async function rasterInfo(path) {
  const raw = await run('gdalinfo', ['-json', '-stats', path], { label: 'gdalinfo' });
  return JSON.parse(raw);
}

/**
 * Bounding box in WGS84 lon/lat, which is what the viewer needs to frame the
 * map. gdalinfo reports wgs84Extent as a GeoJSON polygon when the source is
 * georeferenced; we reduce it to [west, south, east, north].
 */
export function boundsFromInfo(info) {
  const coords = info?.wgs84Extent?.coordinates?.[0];
  if (!coords?.length) return null;

  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/**
 * Reproject to Web Mercator and write a COG.
 *
 * Reprojecting at publish time means the viewer needs no proj4 definitions and
 * the raster aligns with standard basemaps for free. Measurement accuracy is
 * unaffected because the viewer measures geodesically on the ellipsoid rather
 * than in display-projection units.
 */
export async function toCog(input, output, { elevation = false, compress, quality = 85 } = {}) {
  const codec = compress ?? (elevation ? 'DEFLATE' : (process.env.ORTHO_COMPRESS || 'DEFLATE'));

  // Benchmarked against a real asset: 8KB and 64KB range requests cost almost
  // the same (1216ms vs 1316ms median), so this is round-trip bound, not
  // bandwidth bound. Payload is nearly free; round trips are not. Raise
  // COG_BLOCKSIZE to 2048 to halve the request count again if your clients are
  // far from the storage region — measure with tools/benchmark.mjs first.
  const blockSize = process.env.COG_BLOCKSIZE || '1024';

  const creation = [
    '-co', `BLOCKSIZE=${blockSize}`,
    '-co', `COMPRESS=${codec}`,
    '-co', 'BIGTIFF=IF_SAFER',
    '-co', 'NUM_THREADS=ALL_CPUS',
    '-co', 'OVERVIEW_RESAMPLING=AVERAGE',
  ];

  if (codec === 'DEFLATE') {
    // PREDICTOR 3 is the floating-point predictor; using 2 on Float32 elevation
    // data produces a *larger* file, which is a classic silent mistake.
    creation.push('-co', `PREDICTOR=${elevation ? 3 : 2}`);
  }
  if (codec === 'JPEG') {
    creation.push('-co', `QUALITY=${quality}`);
  }

  await run(
    'gdalwarp',
    [
      '-t_srs', WEB_MERCATOR,
      '-r', elevation ? 'bilinear' : 'cubic',
      '-multi',
      '-wo', 'NUM_THREADS=ALL_CPUS',
      '-of', 'COG',
      ...creation,
      '-overwrite',
      input,
      output,
    ],
    { label: `gdalwarp -> COG (${codec})` },
  );

  return output;
}

/**
 * LAZ -> COPC. PDAL infers the COPC writer from the .copc.laz extension, so no
 * explicit writer stage is needed.
 */
export async function toCopc(input, output) {
  await run('pdal', ['translate', input, output], { label: 'pdal translate -> COPC' });
  return output;
}

/** Point count and bounds, for display and for framing the 3D view. */
export async function pointCloudInfo(path) {
  const raw = await run('pdal', ['info', '--summary', path], { label: 'pdal info' });
  const summary = JSON.parse(raw)?.summary ?? {};
  return {
    points: summary.num_points ?? null,
    bounds: summary.bounds ?? null,
    srs: summary.srs?.horizontal ?? null,
  };
}
