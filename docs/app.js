/* WebODM Backup Hub — dashboard
 *
 * Reads a single static manifest.json. It deliberately makes NO calls to
 * api.github.com: unauthenticated requests are capped at 60/hour per IP, which
 * a public dashboard would burn through immediately. The manifest is
 * regenerated on upload and by .github/workflows/rebuild-manifest.yml.
 *
 * Downloads are plain <a download> links. Release assets are served with
 * `Access-Control-Allow-Origin: https://render.githubusercontent.com`, so
 * fetch() against them fails — but link navigation is not subject to CORS.
 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(+d) ? '—' : d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const state = {
  manifest: null, tasks: [], map: null,
  layers: new Map(), pins: new Map(), footprints: new Map(),
};

// ------------------------------------------------------------------- boot

init();

async function init() {
  try {
    const res = await fetch('manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    state.manifest = await res.json();
  } catch {
    $('#loadError').classList.remove('hidden');
    $('#stats').classList.add('hidden');
    $('#mapCard').classList.add('hidden');
    return;
  }

  const m = state.manifest;
  state.tasks = m.projects.flatMap((p) => p.tasks);

  $('#repoLink').textContent = m.repo ?? '';
  $('#repoLink').href = `https://github.com/${m.repo}`;
  $('#generated').textContent = m.generatedAt
    ? `Index updated ${fmtDate(m.generatedAt)}`
    : '';

  renderStats(m.stats);

  $('#projectFilter').insertAdjacentHTML(
    'beforeend',
    m.projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')
  );

  if (!state.tasks.length) {
    $('#empty').classList.remove('hidden');
    $('#mapCard').classList.add('hidden');
    return;
  }

  initMap();
  render();

  $('#q').addEventListener('input', render);
  $('#projectFilter').addEventListener('change', render);
  $('#sort').addEventListener('change', render);
  $('#mapToggle').addEventListener('click', toggleMap);
  document.addEventListener('click', closeDropdowns);
}

function renderStats(s = {}) {
  const cells = [
    [s.tasks ?? 0, 'Tasks archived'],
    [s.projects ?? 0, 'Projects'],
    [fmtBytes(s.totalBytes ?? 0), 'Total stored'],
    [(s.images ?? 0).toLocaleString(), 'Images processed'],
  ];
  $('#stats').innerHTML =
    `<div class="stats-inner">${cells
      .map(([v, k]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${k}</div></div>`)
      .join('')}</div>`;
}

// -------------------------------------------------------------------- map

function initMap() {
  const withBox = state.tasks.filter((t) => Array.isArray(t.bbox) && t.bbox.length === 4);
  if (!withBox.length) {
    $('#mapCard').classList.add('hidden');
    return;
  }

  state.map = L.map('map', { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.map);

  // Rectangles come straight from the manifest, so the overview map costs zero
  // extra requests. The precise polygon is fetched only when a task is opened.
  const group = [];
  for (const t of withBox) {
    const [minX, minY, maxX, maxY] = t.bbox;
    const popup = `<b>${esc(t.name)}</b><br>${esc(t.project)} · ${fmtBytes(t.totalBytes)}`;

    const rect = L.rectangle([[minY, minX], [maxY, maxX]], {
      color: '#2c7be5', weight: 2, fillOpacity: 0.12,
    }).addTo(state.map).bindPopup(popup);
    rect.on('click', () => openTask(t.id));

    // A survey block is often under a kilometre across. Once the map is fitted
    // to sites tens of kilometres apart, its footprint collapses to a speck
    // that cannot be seen or clicked — so each task also gets a fixed-size
    // marker that stays usable at any zoom.
    const pin = L.circleMarker([(minY + maxY) / 2, (minX + maxX) / 2], {
      radius: 6, color: '#fff', weight: 2, fillColor: '#2c7be5', fillOpacity: 1,
    })
      .addTo(state.map)
      .bindPopup(popup)
      .bindTooltip(t.name, { direction: 'top', offset: [0, -8] });
    pin.on('click', () => openTask(t.id));

    state.layers.set(t.id, rect);
    state.pins.set(t.id, pin);
    group.push(rect);
  }

  state.map.fitBounds(L.featureGroup(group).getBounds(), { padding: [24, 24] });
  $('#mapHint').textContent =
    `${withBox.length} of ${state.tasks.length} tasks are georeferenced. Click a footprint to open its task.`;
}

function toggleMap() {
  const card = $('#mapCard'), btn = $('#mapToggle');
  const hidden = card.classList.toggle('hidden');
  btn.textContent = hidden ? 'Show map' : 'Hide map';
  btn.setAttribute('aria-expanded', String(!hidden));
  if (!hidden) setTimeout(() => state.map?.invalidateSize(), 60);
}

/** Swap the rough bbox for the real footprint once a task is opened. */
async function loadFootprint(task) {
  if (!task.footprint || state.footprints.has(task.id) || !state.map) return;
  state.footprints.set(task.id, true);
  try {
    const res = await fetch(task.footprint, { cache: 'force-cache' });
    if (!res.ok) return;
    const gj = await res.json();

    state.layers.get(task.id)?.remove();
    const layer = L.geoJSON(gj, {
      style: { color: '#2c7be5', weight: 2, fillOpacity: 0.12 },
      pointToLayer: (_f, latlng) =>
        L.circleMarker(latlng, { radius: 1.6, color: '#e0a13c', weight: 0, fillOpacity: 0.75 }),
    })
      .addTo(state.map)
      .bindPopup(`<b>${esc(task.name)}</b><br>${esc(task.project)}`);
    state.layers.set(task.id, layer);
  } catch {
    /* footprint is decorative — never block the UI on it */
  }
}

// ----------------------------------------------------------------- render

function currentView() {
  const q = $('#q').value.trim().toLowerCase();
  const proj = $('#projectFilter').value;
  const sort = $('#sort').value;

  let tasks = state.tasks.filter((t) => {
    if (proj && t.project !== proj) return false;
    if (!q) return true;
    return [t.name, t.project, ...(t.tags || []), ...(t.options || []).map((o) => o.name)]
      .join(' ')
      .toLowerCase()
      .includes(q);
  });

  const key = (t) => t.createdAt || t.uploadedAt || '';
  tasks.sort((a, b) => {
    if (sort === 'size') return b.totalBytes - a.totalBytes;
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'date-asc') return key(a).localeCompare(key(b));
    return key(b).localeCompare(key(a));
  });
  return tasks;
}

function render() {
  const tasks = currentView();
  const byProject = new Map();
  for (const t of tasks) {
    if (!byProject.has(t.project)) byProject.set(t.project, []);
    byProject.get(t.project).push(t);
  }

  $('#results').innerHTML = byProject.size
    ? [...byProject.entries()].map(([name, items]) => projectHtml(name, items)).join('')
    : `<div class="empty"><h2>No matching tasks</h2><p>Try a different search or filter.</p></div>`;

  wire();
}

function projectHtml(name, tasks) {
  const bytes = tasks.reduce((s, t) => s + t.totalBytes, 0);
  return `
  <section class="project open" data-project="${esc(name)}">
    <button class="project-head" aria-expanded="true">
      <svg class="chev" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <path fill="currentColor" d="M9 6l6 6-6 6z"/></svg>
      <h2>${esc(name)}</h2>
      <span class="sub">${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${fmtBytes(bytes)}</span>
    </button>
    <div class="project-body">${tasks.map(taskHtml).join('')}</div>
  </section>`;
}

function taskHtml(t) {
  const meta = [
    fmtDate(t.createdAt || t.uploadedAt),
    t.imageCount ? `${t.imageCount.toLocaleString()} images` : null,
    fmtBytes(t.totalBytes),
    t.processingTime ? fmtDuration(t.processingTime) : null,
  ].filter(Boolean);

  return `
  <article class="task" data-id="${esc(t.id)}">
    <div class="task-head">
      <div class="task-title">
        <div class="n">${esc(t.name)}</div>
        <div class="m">${meta.map((x) => `<span>${esc(x)}</span>`).join('')}</div>
      </div>
      ${t.backup.split
        ? `<span class="badge split">${t.backup.parts.length} parts</span>`
        : `<span class="badge">${esc(t.status || 'archived')}</span>`}
      <div class="actions">
        <div class="dd">
          <button class="dd-btn ghost">Download Assets ▾</button>
          <div class="dd-menu">${menuHtml(t)}</div>
        </div>
        <button class="ghost details-btn">Details</button>
      </div>
    </div>
    <div class="task-detail">${detailHtml(t)}</div>
  </article>`;
}

function menuHtml(t) {
  const link = (href, label, size) =>
    `<a href="${esc(href)}" download>${esc(label)}<span class="sz">${fmtBytes(size)}</span></a>`;

  let html = `<div class="dd-label">Full backup</div>`;
  html += t.backup.parts.map((p, i) =>
    link(p.url, t.backup.split ? `Part ${i + 1} of ${t.backup.parts.length}` : 'backup.zip', p.size)
  ).join('');

  if (t.backup.split) {
    html += `<div class="bundled">All parts required — see Details to rejoin.</div>`;
  }

  if (t.assets.length) {
    html += `<div class="dd-sep"></div><div class="dd-label">Individual assets</div>`;
    html += t.assets.map((a) => link(a.url, a.label || a.name, a.size)).join('');
  }

  if (t.bundled?.length) {
    html += `<div class="dd-sep"></div><div class="dd-label">Inside the backup</div>`;
    html += t.bundled.map((b) => `<div class="bundled">${esc(b.label || b.name)}</div>`).join('');
  }
  return html;
}

function detailHtml(t) {
  const cells = [
    ['Project', t.project],
    ['Captured', fmtDate(t.createdAt)],
    ['Archived', fmtDate(t.uploadedAt)],
    ['Images', t.imageCount?.toLocaleString() ?? '—'],
    ['Processing time', fmtDuration(t.processingTime)],
    ['Total size', fmtBytes(t.totalBytes)],
  ];

  let html = `<div class="detail-grid">${cells
    .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`)
    .join('')}</div>`;

  if (t.tags?.length) {
    html += `<div class="tags">${t.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>`;
  }

  if (t.backup.split) html += rejoinHtml(t);

  html += `<p style="margin-top:14px;font-size:12.5px">
    <a href="${esc(t.releaseUrl)}" target="_blank" rel="noopener">View release on GitHub →</a></p>`;
  return html;
}

/**
 * Parts are raw byte ranges of the original zip, so plain concatenation in the
 * right order reproduces it exactly. Rejoining in the browser is not an option:
 * fetching the assets cross-origin is blocked, and a multi-GB Blob would not
 * survive memory anyway.
 */
function rejoinHtml(t) {
  const names = t.backup.parts.map((p) => p.name);
  const cmds = {
    powershell:
      `$out=[IO.File]::Create("backup.zip"); ` +
      `Get-ChildItem backup.zip.part* | Sort-Object Name | ForEach-Object { ` +
      `$s=[IO.File]::OpenRead($_.FullName); $s.CopyTo($out); $s.Close() }; $out.Close()`,
    cmd: `copy /b ${names.join('+')} backup.zip`,
    unix: `cat backup.zip.part* > backup.zip`,
  };
  const isWin = navigator.userAgent.includes('Windows');
  const active = isWin ? 'powershell' : 'unix';

  return `
  <div class="rejoin" data-cmds='${esc(JSON.stringify(cmds))}'>
    <h4>This backup is split into ${names.length} parts</h4>
    <p>Download every part into the same folder, then rejoin them:</p>
    <div class="os-tabs">
      <button data-os="powershell" aria-pressed="${active === 'powershell'}">PowerShell</button>
      <button data-os="cmd" aria-pressed="false">CMD</button>
      <button data-os="unix" aria-pressed="${active === 'unix'}">macOS / Linux</button>
    </div>
    <div class="rejoin-cmd">
      <code>${esc(cmds[active])}</code>
      <button class="copy-btn">Copy</button>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ events

function wire() {
  $$('.project-head').forEach((b) =>
    b.addEventListener('click', () => {
      const p = b.closest('.project');
      const open = p.classList.toggle('open');
      b.setAttribute('aria-expanded', String(open));
    })
  );

  $$('.details-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const task = b.closest('.task');
      task.classList.toggle('open');
      if (task.classList.contains('open')) {
        const t = state.tasks.find((x) => x.id === task.dataset.id);
        if (t) {
          loadFootprint(t);
          focusTask(t);
        }
      }
    })
  );

  $$('.dd-btn').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = b.closest('.dd');
      const wasOpen = dd.classList.contains('open');
      closeDropdowns();
      dd.classList.toggle('open', !wasOpen);
    })
  );

  $$('.os-tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      const box = b.closest('.rejoin');
      const cmds = JSON.parse(box.dataset.cmds);
      $$('button', b.parentElement).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      $('code', box).textContent = cmds[b.dataset.os];
    })
  );

  $$('.copy-btn').forEach((b) =>
    b.addEventListener('click', async () => {
      await navigator.clipboard.writeText($('code', b.closest('.rejoin')).textContent);
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = 'Copy'), 1400);
    })
  );
}

function closeDropdowns() {
  $$('.dd.open').forEach((d) => d.classList.remove('open'));
}

/** Pan the map to a task when its details open, without over-zooming a tiny site. */
function focusTask(t) {
  if (!state.map || !Array.isArray(t.bbox) || $('#mapCard').classList.contains('hidden')) return;
  const [minX, minY, maxX, maxY] = t.bbox;
  state.map.flyToBounds([[minY, minX], [maxY, maxX]], { maxZoom: 16, padding: [40, 40], duration: 0.6 });
}

/** Scroll to and expand a task — used when a map footprint is clicked. */
function openTask(id) {
  const el = $(`.task[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.closest('.project')?.classList.add('open');
  el.classList.add('open');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
