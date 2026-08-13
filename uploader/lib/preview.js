/**
 * Builds the small GeoJSON footprint the dashboard draws on its map.
 *
 * These files are committed to the repo rather than attached to the release on
 * purpose: release assets are served with
 * `Access-Control-Allow-Origin: https://render.githubusercontent.com`, so the
 * dashboard cannot fetch() them. Committed files are same-origin on Pages and
 * fetch cleanly. They are a few KB each.
 */

/** Andrew's monotone chain — O(n log n), and short enough to not warrant a dep. */
function convexHull(points) {
  if (points.length < 3) return points.slice();
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (src) => {
    const out = [];
    for (const p of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };

  return [...build(pts), ...build(pts.reverse())];
}

function isLonLat([lon, lat]) {
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
}

/** Pull every coordinate pair out of arbitrarily nested GeoJSON geometry. */
function collectCoords(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    if (typeof node[0] === 'number' && typeof node[1] === 'number') out.push([node[0], node[1]]);
    else node.forEach((n) => collectCoords(n, out));
    return out;
  }
  if (node.type === 'FeatureCollection') node.features?.forEach((f) => collectCoords(f, out));
  else if (node.type === 'Feature') collectCoords(node.geometry, out);
  else if (node.coordinates) collectCoords(node.coordinates, out);
  return out;
}

function bboxOf(coords) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function parse(buffer) {
  if (!buffer) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * @returns {{geojson: object, bbox: number[], center: number[], imageCount: number|null, source: string}|null}
 *   null when the backup carries no usable georeferencing (e.g. a task
 *   processed without GPS), in which case the dashboard just omits the map.
 */
export function buildFootprint({ crop, shotsBuffer }) {
  const shots = parse(shotsBuffer);

  // Camera positions give both the footprint and a free, accurate image count.
  const shotCoords = (collectCoords(shots) || []).filter(isLonLat);
  const imageCount = shots?.type === 'FeatureCollection' ? shots.features?.length ?? null : null;

  // Prefer the task's own crop polygon — it is the real processing boundary.
  const cropCoords = (collectCoords(crop) || []).filter(isLonLat);

  let ring, source;
  if (cropCoords.length >= 3) {
    ring = convexHull(cropCoords);
    source = 'crop';
  } else if (shotCoords.length >= 3) {
    ring = convexHull(shotCoords);
    source = 'shots';
  } else {
    return null;
  }

  if (ring.length < 3) return null;
  const closed = [...ring, ring[0]];
  const bbox = bboxOf(ring);

  return {
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { source },
          geometry: { type: 'Polygon', coordinates: [closed] },
        },
        ...(shotCoords.length
          ? [
              {
                type: 'Feature',
                properties: { source: 'shots', count: shotCoords.length },
                geometry: { type: 'MultiPoint', coordinates: shotCoords },
              },
            ]
          : []),
      ],
    },
    bbox,
    center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
    imageCount,
    source,
  };
}
