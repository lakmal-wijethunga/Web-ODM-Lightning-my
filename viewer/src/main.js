/**
 * Viewer entry point: route -> fetch encrypted manifest -> unlock -> render.
 *
 * The manifest is the only thing this app knows about a project, and it is
 * fetched as ciphertext. Until the password is supplied nothing identifying is
 * in the DOM, in the document title, or in memory.
 */

import { decryptManifest } from '../../shared/crypto.mjs';
import { formatBytes } from './format.js';

const $ = (id) => document.getElementById(id);

const els = {
  gate: $('gate'),
  gateForm: $('gate-form'),
  gateError: $('gate-error'),
  gateSubmit: $('gate-submit'),
  password: $('password'),
  status: $('status'),
  statusText: $('status-text'),
  app: $('app'),
  title: $('project-title'),
  meta: $('project-meta'),
  logo: $('brand-logo'),
  downloads: $('download-list'),
};

/** Panels are dynamically imported so the 3D renderer never loads on a phone
 *  that only ever opens the 2D tab. */
const loaders = {
  map2d: () => import('./map2d.js'),
  cloud3d: () => import('./cloud3d.js'),
  downloads: null,
};

const initialised = new Set();
let manifest = null;

function show(section) {
  for (const key of ['gate', 'status', 'app']) els[key].hidden = key !== section;
}

function fail(message) {
  show('status');
  els.status.querySelector('.spinner').hidden = true;
  els.statusText.textContent = message;
}

const slugFromHash = () => (location.hash.match(/^#\/([A-Za-z0-9_-]+)/) ?? [])[1] ?? null;

/** sessionStorage keeps a reload from re-prompting. It dies with the tab, and
 *  is per-origin — an acceptable trade for the convenience. */
const cacheKey = (slug) => `webodm-share:${slug}`;

async function loadEnvelope(slug) {
  const response = await fetch(`projects/${slug}/manifest.enc`, { cache: 'no-cache' });
  if (response.status === 404) throw new Error('No survey exists at this link.');
  if (!response.ok) throw new Error(`Could not load this survey (${response.status}).`);
  return response.json();
}

function applyBranding(data) {
  if (data.brand?.color) {
    document.documentElement.style.setProperty('--brand', data.brand.color);
  }
  if (data.brand?.logoUrl) {
    els.logo.src = data.brand.logoUrl;
    els.logo.alt = data.brand.organisation ?? '';
    els.logo.hidden = false;
  }

  els.title.textContent = data.title ?? 'Survey';
  document.title = data.title ? `${data.title} — Survey viewer` : 'Survey viewer';

  const meta = [data.client, data.capturedOn && `Captured ${data.capturedOn}`].filter(Boolean);
  els.meta.textContent = meta.join(' · ');
}

function renderDownloads(data) {
  els.downloads.replaceChildren();

  if (!data.downloads?.length) {
    const li = document.createElement('li');
    li.className = 'download';
    li.textContent = 'No files were published for download with this survey.';
    els.downloads.append(li);
    return;
  }

  for (const file of data.downloads) {
    const li = document.createElement('li');
    li.className = 'download';

    const text = document.createElement('div');
    text.className = 'download__text';

    const name = document.createElement('span');
    name.className = 'download__name';
    name.textContent = file.label ?? file.name;

    const meta = document.createElement('span');
    meta.className = 'download__meta';
    meta.textContent = [file.name, formatBytes(file.bytes)].filter(Boolean).join(' · ');

    text.append(name, meta);

    const link = document.createElement('a');
    link.className = 'btn';
    link.href = file.url;
    link.textContent = 'Download';
    // Cross-origin storage; no referrer and no opener handle needed.
    link.rel = 'noopener noreferrer';

    li.append(text, link);
    els.downloads.append(li);
  }
}

async function activateTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.dataset.panel !== name;
  }

  const loader = loaders[name];
  if (!loader || initialised.has(name)) {
    // OpenLayers and three both need a resize nudge after being un-hidden,
    // because they measured a zero-sized container while the panel was hidden.
    window.dispatchEvent(new Event('resize'));
    return;
  }

  initialised.add(name);
  try {
    const module = await loader();
    await module.init(manifest);
  } catch (err) {
    console.error(`Failed to initialise ${name}:`, err);
    initialised.delete(name);
  }
}

function start(data) {
  manifest = data;
  applyBranding(data);
  renderDownloads(data);

  // Hide the 3D tab entirely when the task had no point cloud.
  if (!data.layers?.pointcloud) {
    document.querySelector('.tab[data-tab="cloud3d"]')?.remove();
  }

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  }

  show('app');
  activateTab('map2d');
}

async function unlock(slug, envelope, password, { fromCache = false } = {}) {
  const data = await decryptManifest(envelope, password);
  sessionStorage.setItem(cacheKey(slug), password);
  if (!fromCache) els.gateForm.reset();
  start(data);
}

async function main() {
  const slug = slugFromHash();
  if (!slug) {
    fail('This link is incomplete. Ask for the full survey link.');
    return;
  }

  show('status');
  els.statusText.textContent = 'Loading…';

  let envelope;
  try {
    envelope = await loadEnvelope(slug);
  } catch (err) {
    fail(err.message);
    return;
  }

  // Try a cached password first so a refresh does not re-prompt.
  const cached = sessionStorage.getItem(cacheKey(slug));
  if (cached) {
    try {
      await unlock(slug, envelope, cached, { fromCache: true });
      return;
    } catch {
      sessionStorage.removeItem(cacheKey(slug));
    }
  }

  show('gate');
  els.password.focus();

  els.gateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    els.gateError.hidden = true;
    els.gateSubmit.disabled = true;
    els.gateSubmit.textContent = 'Unlocking…';

    try {
      await unlock(slug, envelope, els.password.value);
    } catch (err) {
      // Key derivation is deliberately slow, so re-enable only after it fails.
      els.gateError.textContent =
        err.name === 'WrongPasswordError' ? 'Incorrect password.' : err.message;
      els.gateError.hidden = false;
      els.password.select();
    } finally {
      els.gateSubmit.disabled = false;
      els.gateSubmit.textContent = 'Unlock';
    }
  });
}

window.addEventListener('hashchange', () => location.reload());
main();
