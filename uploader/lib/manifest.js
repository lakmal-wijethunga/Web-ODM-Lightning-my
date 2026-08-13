import { EXTRACT_ASSETS, BUNDLED_ASSETS } from './config.js';

/**
 * Each release carries its own metadata inside its body, wrapped in an HTML
 * comment so it stays invisible on the GitHub release page. That makes the
 * releases themselves the source of truth: manifest.json can always be
 * rebuilt from the API alone (see .github/workflows/rebuild-manifest.yml),
 * even if it is deleted or a release is edited by hand.
 */
const OPEN = '<!-- webodm-hub';
const CLOSE = '-->';

export function encodeBody(meta, human) {
  return `${human}\n\n${OPEN}\n${JSON.stringify(meta, null, 2)}\n${CLOSE}\n`;
}

export function decodeBody(body) {
  if (!body) return null;
  const start = body.indexOf(OPEN);
  if (start === -1) return null;
  const end = body.indexOf(CLOSE, start);
  if (end === -1) return null;
  try {
    return JSON.parse(body.slice(start + OPEN.length, end).trim());
  } catch {
    return null;
  }
}

export function humanBody({ project, name, createdAt, imageCount, totalBytes, split }) {
  const lines = [
    `**Project:** ${project}`,
    `**Task:** ${name}`,
    createdAt ? `**Captured:** ${new Date(createdAt).toISOString().slice(0, 10)}` : null,
    imageCount ? `**Images:** ${imageCount}` : null,
    `**Size:** ${formatBytes(totalBytes)}`,
    '',
    'WebODM task backup archived by [webodm-backup-hub](../../).',
    split
      ? '\n> This backup exceeds GitHub\'s 2 GiB per-file limit and is split into parts.\n' +
        '> Download every part, then rejoin them before opening — see the dashboard for the exact command.'
      : null,
  ];
  return lines.filter(Boolean).join('\n');
}

export function formatBytes(n) {
  if (!n && n !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const labelFor = (name) =>
  EXTRACT_ASSETS.find((a) => a.as === name)?.label ??
  BUNDLED_ASSETS.find((a) => a.inZip.split('/').pop() === name)?.label ??
  name;

/** Turn the raw Releases API payload into the shape the dashboard renders. */
export function buildManifest(releases, { slug }) {
  const tasks = [];

  for (const release of releases) {
    if (release.draft) continue;
    const meta = decodeBody(release.body);
    if (!meta || meta.kind !== 'webodm-task') continue;

    const assets = release.assets ?? [];
    const partRe = /\.part(\d+)$/;

    const parts = assets
      .filter((a) => partRe.test(a.name))
      .sort((a, b) => Number(a.name.match(partRe)[1]) - Number(b.name.match(partRe)[1]))
      .map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));

    const whole = assets.find((a) => a.name === 'backup.zip');
    const backupParts = parts.length
      ? parts
      : whole
        ? [{ name: whole.name, url: whole.browser_download_url, size: whole.size }]
        : [];

    const extras = assets
      .filter((a) => !partRe.test(a.name) && a.name !== 'backup.zip')
      .map((a) => ({
        name: a.name,
        label: labelFor(a.name),
        url: a.browser_download_url,
        size: a.size,
      }))
      // Keep the dropdown in a predictable, WebODM-ish order.
      .sort((a, b) => {
        const order = EXTRACT_ASSETS.map((e) => e.as);
        return order.indexOf(a.name) - order.indexOf(b.name);
      });

    const totalBytes = assets.reduce((sum, a) => sum + (a.size || 0), 0);

    tasks.push({
      id: release.tag_name,
      tag: release.tag_name,
      name: meta.name || release.name || release.tag_name,
      project: meta.project || 'Unsorted',
      createdAt: meta.createdAt ?? null,
      uploadedAt: release.published_at ?? release.created_at ?? null,
      processingTime: meta.processingTime ?? null,
      imageCount: meta.imageCount ?? null,
      options: meta.options ?? [],
      tags: meta.tags ?? [],
      status: meta.status ?? 'archived',
      releaseUrl: release.html_url,
      backup: {
        parts: backupParts,
        split: parts.length > 1,
        totalBytes: backupParts.reduce((s, p) => s + p.size, 0),
      },
      assets: extras,
      bundled: meta.bundled ?? [],
      footprint: meta.footprint ?? null,
      bbox: meta.bbox ?? null,
      center: meta.center ?? null,
      totalBytes,
    });
  }

  // Newest first, by capture date where known.
  tasks.sort((a, b) => {
    const av = a.createdAt || a.uploadedAt || '';
    const bv = b.createdAt || b.uploadedAt || '';
    return bv.localeCompare(av);
  });

  const byProject = new Map();
  for (const t of tasks) {
    if (!byProject.has(t.project)) byProject.set(t.project, []);
    byProject.get(t.project).push(t);
  }

  const projects = [...byProject.entries()]
    .map(([name, items]) => ({
      name,
      taskCount: items.length,
      totalBytes: items.reduce((s, t) => s + t.totalBytes, 0),
      tasks: items,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    repo: slug,
    stats: {
      projects: projects.length,
      tasks: tasks.length,
      totalBytes: tasks.reduce((s, t) => s + t.totalBytes, 0),
      images: tasks.reduce((s, t) => s + (t.imageCount || 0), 0),
    },
    projects,
  };
}
