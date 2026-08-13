/**
 * 2D orthophoto viewer.
 *
 * OpenLayers is used rather than Leaflet or MapLibre because its GeoTIFF
 * source reads Cloud Optimized GeoTIFFs natively over HTTP range requests —
 * no plugin, no custom protocol — and because ol/sphere gives geodesic
 * measurement for free.
 *
 * Assets are reprojected to EPSG:3857 at publish time, so the view projection
 * already matches and no proj4 definitions are needed at runtime.
 */

import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import WebGLTileLayer from 'ol/layer/WebGLTile.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import GeoTIFF from 'ol/source/GeoTIFF.js';
import OSM from 'ol/source/OSM.js';
import Draw from 'ol/interaction/Draw.js';
import Overlay from 'ol/Overlay.js';
import { Style, Fill, Stroke, Circle as CircleStyle } from 'ol/style.js';
import { getLength, getArea } from 'ol/sphere.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { formatBytes } from './format.js';

const LAYER_LABELS = {
  orthophoto: 'Orthophoto',
  dsm: 'Surface model (DSM)',
  dtm: 'Terrain model (DTM)',
};

let map = null;
let elevationLayer = null;

/**
 * Build a COG-backed layer.
 *
 * normalize:false is essential for the DEMs: it keeps the original Float32
 * elevations instead of rescaling them to 0..1, which is what makes
 * getData() usable for the elevation readout. For the orthophoto it simply
 * preserves the byte values.
 */
function cogLayer(spec, { visible, elevation = false }) {
  const source = new GeoTIFF({
    sources: [{ url: spec.url }],
    normalize: !elevation,
    interpolate: !elevation,
    convertToRGB: 'auto',
  });

  const layer = new WebGLTileLayer({ source, visible });

  if (elevation) {
    // DEMs are carried purely as a data probe by default; showing raw Float32
    // elevation as colour is meaningless without a ramp, so it starts hidden.
    layer.setOpacity(1);
  }

  source.on('error', (event) => {
    console.error('COG source error', event);
  });

  return layer;
}

function buildLayerControls(container, entries) {
  container.replaceChildren();

  for (const { key, layer, spec } of entries) {
    const wrapper = document.createElement('div');
    wrapper.className = 'layer';

    const row = document.createElement('div');
    row.className = 'layer__row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = layer.getVisible();
    checkbox.id = `layer-${key}`;

    const name = document.createElement('label');
    name.className = 'layer__name';
    name.htmlFor = checkbox.id;
    name.textContent = LAYER_LABELS[key] ?? key;

    const size = document.createElement('span');
    size.className = 'layer__size';
    size.textContent = formatBytes(spec.bytes);

    row.append(checkbox, name, size);

    const opacity = document.createElement('input');
    opacity.type = 'range';
    opacity.min = '0';
    opacity.max = '1';
    opacity.step = '0.05';
    opacity.value = String(layer.getOpacity());
    opacity.setAttribute('aria-label', `${LAYER_LABELS[key] ?? key} opacity`);

    checkbox.addEventListener('change', () => layer.setVisible(checkbox.checked));
    opacity.addEventListener('input', () => layer.setOpacity(Number(opacity.value)));

    wrapper.append(row, opacity);
    container.append(wrapper);
  }
}

/** Geodesic formatting — metres until a kilometre, then km. */
function formatLength(line) {
  const metres = getLength(line); // defaults to the WGS84 ellipsoid
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${metres.toFixed(1)} m`;
}

function formatArea(polygon) {
  const sqm = getArea(polygon);
  if (sqm >= 1_000_000) return `${(sqm / 1_000_000).toFixed(2)} km²`;
  if (sqm >= 10_000) return `${(sqm / 10_000).toFixed(2)} ha`;
  return `${sqm.toFixed(1)} m²`;
}

function setupMeasure(mapInstance, source) {
  let draw = null;
  let tooltip = null;
  let tooltipEl = null;

  const makeTooltip = () => {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'ol-tooltip';
    tooltip = new Overlay({
      element: tooltipEl,
      offset: [0, -14],
      positioning: 'bottom-center',
      stopEvent: false,
      insertFirst: false,
    });
    mapInstance.addOverlay(tooltip);
  };

  const stop = () => {
    if (draw) {
      mapInstance.removeInteraction(draw);
      draw = null;
    }
    for (const button of document.querySelectorAll('[data-measure]')) {
      button.classList.remove('is-active');
    }
  };

  const start = (mode) => {
    stop();
    const type = mode === 'area' ? 'Polygon' : 'LineString';
    draw = new Draw({ source, type });
    mapInstance.addInteraction(draw);

    let listener = null;

    draw.on('drawstart', (event) => {
      makeTooltip();
      const geometry = event.feature.getGeometry();
      listener = geometry.on('change', () => {
        const text = type === 'Polygon' ? formatArea(geometry) : formatLength(geometry);
        tooltipEl.textContent = text;
        tooltip.setPosition(
          type === 'Polygon'
            ? geometry.getInteriorPoint().getCoordinates()
            : geometry.getLastCoordinate(),
        );
      });
    });

    draw.on('drawend', () => {
      tooltipEl.className = 'ol-tooltip ol-tooltip--static';
      tooltip.setOffset([0, -8]);
      if (listener) listener.target.un('change', listener.listener);
      tooltip = null;
      tooltipEl = null;
      stop();
    });
  };

  document.querySelectorAll('[data-measure]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.measure;

      if (mode === 'clear') {
        source.clear();
        for (const overlay of [...mapInstance.getOverlays().getArray()]) {
          mapInstance.removeOverlay(overlay);
        }
        stop();
        return;
      }

      if (button.classList.contains('is-active')) {
        stop();
        return;
      }

      stop();
      button.classList.add('is-active');
      start(mode);
    });
  });
}

/** Live coordinate + elevation under the pointer. */
function setupReadout(mapInstance) {
  const readout = document.getElementById('readout');
  const coordsEl = document.getElementById('readout-coords');
  const elevEl = document.getElementById('readout-elev');

  const update = (event) => {
    if (event.dragging) return;
    readout.hidden = false;

    const [lon, lat] = toLonLat(event.coordinate);
    coordsEl.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

    if (!elevationLayer) {
      elevEl.textContent = '';
      return;
    }

    // getData returns the source band values at this screen pixel. It is null
    // until the covering tile has actually loaded, which over Drive can lag a
    // moment behind the pointer — so we simply show nothing rather than 0.
    const data = elevationLayer.getData(event.pixel);
    const value = data?.[0];
    elevEl.textContent =
      Number.isFinite(value) && Math.abs(value) < 1e6 ? `${value.toFixed(2)} m` : '';
  };

  mapInstance.on('pointermove', update);
  mapInstance.getViewport().addEventListener('pointerleave', () => {
    readout.hidden = true;
  });
}

export async function init(manifest) {
  const layers = manifest.layers ?? {};

  const basemap = new TileLayer({ source: new OSM(), zIndex: 0 });

  const entries = [];
  for (const key of ['orthophoto', 'dsm', 'dtm']) {
    const spec = layers[key];
    if (!spec?.url) continue;

    const isElevation = key !== 'orthophoto';
    const layer = cogLayer(spec, { visible: key === 'orthophoto', elevation: isElevation });
    layer.setZIndex(key === 'orthophoto' ? 1 : 2);
    entries.push({ key, layer, spec });

    // The DSM is the elevation probe; fall back to the DTM if there is no DSM.
    if (key === 'dsm' || (key === 'dtm' && !elevationLayer)) elevationLayer = layer;
  }

  const measureSource = new VectorSource();
  const measureLayer = new VectorLayer({
    source: measureSource,
    zIndex: 10,
    style: new Style({
      fill: new Fill({ color: 'rgba(37, 99, 235, 0.18)' }),
      stroke: new Stroke({ color: '#2563eb', width: 2.5 }),
      image: new CircleStyle({
        radius: 5,
        fill: new Fill({ color: '#2563eb' }),
        stroke: new Stroke({ color: '#fff', width: 1.5 }),
      }),
    }),
  });

  map = new Map({
    target: 'map',
    layers: [basemap, ...entries.map((e) => e.layer), measureLayer],
    view: new View({ center: fromLonLat([0, 0]), zoom: 2, maxZoom: 26 }),
  });

  // Frame the survey. Publish-time bounds avoid waiting on the COG header,
  // which over Drive is a visible delay.
  const bounds = manifest.bounds ?? layers.orthophoto?.bounds;
  if (bounds) {
    const [west, south, east, north] = bounds;
    map.getView().fit([...fromLonLat([west, south]), ...fromLonLat([east, north])], {
      padding: [40, 40, 40, 40],
      duration: 0,
    });
  } else {
    // No bounds recorded: let the COG's own extent drive the view.
    const source = entries[0]?.layer.getSource();
    source?.getView().then((viewConfig) => map.setView(new View(viewConfig)));
  }

  buildLayerControls(document.getElementById('layer-list'), entries);
  setupMeasure(map, measureSource);
  setupReadout(map);

  // Mobile: the layer sheet is toggled; desktop CSS keeps it always visible.
  const toggle = document.getElementById('layers-toggle');
  const panel = document.getElementById('layers');
  toggle?.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });
  if (window.matchMedia('(min-width: 720px)').matches) panel.hidden = false;

  window.addEventListener('resize', () => map.updateSize());
  setTimeout(() => map.updateSize(), 0);
}
