/**
 * COPC point cloud viewer.
 *
 * COPC was chosen over Potree's native format because it is a *single* file
 * read via HTTP range requests. Potree octrees are thousands of small files,
 * which would mean thousands of Drive uploads per project and thousands of
 * file IDs in the manifest.
 *
 * Loading is progressive and budgeted rather than a full screen-space-error
 * LOD: nodes are fetched shallowest-first until a point budget is reached.
 * Over a high-latency backend that behaves better than aggressive LOD anyway,
 * because it minimises the number of round trips.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Copc, Getter } from 'copc';

/** Mobile GPUs and Drive latency both argue for a smaller budget on phones. */
const POINT_BUDGET = window.matchMedia('(min-width: 720px)').matches ? 4_000_000 : 1_200_000;
const MAX_CONCURRENT = 4;

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let frameHandle = null;

const setStatus = (text) => {
  const el = document.getElementById('cloud-status');
  if (el) el.textContent = text;
};

/**
 * Breadth-first walk of the COPC hierarchy, collecting nodes until the point
 * budget is spent. Shallower nodes cover the whole scene at low density, so
 * this yields a complete-looking cloud early rather than a detailed fragment.
 */
function selectNodes(nodes, budget) {
  const entries = Object.entries(nodes)
    .map(([key, node]) => ({ key, node, depth: Number(key.split('-')[0]) }))
    .sort((a, b) => a.depth - b.depth);

  const selected = [];
  let total = 0;
  for (const entry of entries) {
    const count = entry.node.pointCount ?? 0;
    if (total + count > budget && selected.length) break;
    selected.push(entry);
    total += count;
  }
  return { selected, total };
}

/** Fetch node point data and convert it into a three.js Points object. */
async function buildNode(getter, copc, node, origin) {
  const view = await Copc.loadPointDataView(getter, copc, node);
  const count = view.pointCount;
  if (!count) return null;

  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');

  // ODM writes RGB, but a cloud without colour is legal — fall back to a
  // height ramp so the model is still readable.
  let getR = null;
  let getG = null;
  let getB = null;
  try {
    getR = view.getter('Red');
    getG = view.getter('Green');
    getB = view.getter('Blue');
  } catch {
    /* no colour dimensions present */
  }

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  let minZ = Infinity;
  let maxZ = -Infinity;
  if (!getR) {
    for (let i = 0; i < count; i += 1) {
      const z = getZ(i);
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  const span = maxZ - minZ || 1;

  for (let i = 0; i < count; i += 1) {
    const j = i * 3;
    // Subtract the scene origin: raw UTM coordinates are in the millions and
    // would destroy Float32 precision, producing visible vertex jitter.
    positions[j] = getX(i) - origin.x;
    positions[j + 1] = getZ(i) - origin.z; // Z-up source -> Y-up scene
    positions[j + 2] = -(getY(i) - origin.y);

    if (getR) {
      // LAS colour is 16-bit; ODM writes full-range values.
      colors[j] = getR(i) / 65535;
      colors[j + 1] = getG(i) / 65535;
      colors[j + 2] = getB(i) / 65535;
    } else {
      const t = (getZ(i) - minZ) / span;
      colors[j] = 0.25 + t * 0.75;
      colors[j + 1] = 0.4 + t * 0.4;
      colors[j + 2] = 0.9 - t * 0.5;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 1.4,
    sizeAttenuation: false,
    vertexColors: true,
  });

  return new THREE.Points(geometry, material);
}

/** Simple concurrency-limited map — keeps Drive from being hit with 200 parallel requests. */
async function pooled(items, limit, worker) {
  const queue = [...items];
  const running = new Set();
  const results = [];

  while (queue.length || running.size) {
    while (running.size < limit && queue.length) {
      const item = queue.shift();
      const task = worker(item)
        .then((r) => results.push(r))
        .catch((err) => console.warn('node load failed', err))
        .finally(() => running.delete(task));
      running.add(task);
    }
    if (running.size) await Promise.race(running);
  }

  return results;
}

function setupScene(container) {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(
    getComputedStyle(document.body).backgroundColor || '#0e1116',
  );

  camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / container.clientHeight || 1,
    0.1,
    100_000,
  );

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.append(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const render = () => {
    frameHandle = requestAnimationFrame(render);
    controls.update();
    renderer.render(scene, camera);
  };
  render();

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', resize);
  setTimeout(resize, 0);
}

export async function init(manifest) {
  const spec = manifest.layers?.pointcloud;
  const container = document.getElementById('cloud');
  if (!spec?.url || !container) return;

  setupScene(container);
  setStatus('Reading point cloud header…');

  try {
    const getter = Getter.http(spec.url);
    const copc = await Copc.create(getter);

    const [minX, minY, minZ, maxX, maxY, maxZ] = [
      ...copc.header.min,
      ...copc.header.max,
    ];
    const origin = {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      z: (minZ + maxZ) / 2,
    };

    setStatus('Loading octree…');
    const { nodes } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
    const { selected, total } = selectNodes(nodes, POINT_BUDGET);

    // Frame the cloud before points arrive so the view is never disorienting.
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 100;
    camera.position.set(extent * 0.6, extent * 0.5, extent * 0.6);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();

    let loaded = 0;
    await pooled(selected, MAX_CONCURRENT, async ({ node }) => {
      const points = await buildNode(getter, copc, node, origin);
      if (points) {
        scene.add(points);
        loaded += node.pointCount ?? 0;
        setStatus(`${loaded.toLocaleString()} of ${total.toLocaleString()} points`);
      }
    });

    const shown = spec.points && total < spec.points ? ' (decimated for display)' : '';
    setStatus(`${loaded.toLocaleString()} points${shown}`);
  } catch (err) {
    console.error(err);
    setStatus(`Could not load the point cloud: ${err.message}`);
  }
}

export function dispose() {
  if (frameHandle) cancelAnimationFrame(frameHandle);
  renderer?.dispose();
}
