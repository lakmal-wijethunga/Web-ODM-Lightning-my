import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { readFile, mkdir, stat, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './lib/config.js';
import { GitHub } from './lib/github.js';
import { inspect, upload } from './lib/pipeline.js';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PUBLIC = path.join(ROOT, 'uploader', 'public');
const TMP = path.join(ROOT, 'uploader', '.tmp');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error('\n' + err.message);
  process.exit(1);
}
const gh = new GitHub(config);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const json = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });

/**
 * Open the OS file picker so the user can select a backup that stays exactly
 * where it is. A browser drag-and-drop can only hand us bytes, never a path,
 * which would mean copying several GB to a temp file first. This avoids that
 * entirely — the pipeline reads the original file in place.
 */
function nativeFilePicker() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$d = New-Object System.Windows.Forms.OpenFileDialog;',
      "$d.Filter = 'WebODM backup (*.zip)|*.zip|All files (*.*)|*.*';",
      "$d.Title = 'Select a WebODM task backup';",
      "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }",
    ].join(' ');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-NonInteractive', '-Command', ps],
      { timeout: 300000 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null)
    );
  });
}

/**
 * Delete a drag-and-drop staging copy once it is safely uploaded.
 *
 * Deliberately narrow: it only removes files this server wrote into .tmp/ with
 * the `staged-` prefix. A backup chosen through the native picker is the user's
 * own file sitting in their own folder, and must never be touched.
 */
async function discardStaged(zipPath, emit) {
  const resolved = path.resolve(zipPath);
  const inTmp = resolved.startsWith(path.resolve(TMP) + path.sep);
  if (!inTmp || !path.basename(resolved).startsWith('staged-')) return;
  try {
    await rm(resolved, { force: true });
    emit({ type: 'log', message: 'Removed the local staging copy.' });
  } catch {
    /* leaving a temp file behind is not worth failing an upload over */
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.port}`);

  try {
    // ---------------------------------------------------------------- API
    if (url.pathname === '/api/config') {
      return json(res, 200, {
        repo: config.slug,
        pagesUrl: config.pagesUrl,
        canPickNatively: process.platform === 'win32',
      });
    }

    if (url.pathname === '/api/browse' && req.method === 'POST') {
      const file = await nativeFilePicker();
      if (!file) return json(res, 200, { cancelled: true });
      return json(res, 200, { path: file });
    }

    if (url.pathname === '/api/inspect' && req.method === 'POST') {
      const { path: zipPath } = await readJsonBody(req);
      await stat(zipPath); // throws a clear ENOENT if the path is wrong
      return json(res, 200, await inspect(zipPath));
    }

    // Drag-and-drop fallback: the browser can only give us bytes, so stage
    // them to disk before handing the pipeline a real path.
    if (url.pathname === '/api/stage' && req.method === 'POST') {
      await mkdir(TMP, { recursive: true });
      const name = url.searchParams.get('name') || 'staged.zip';
      const dest = path.join(TMP, `staged-${Date.now()}-${path.basename(name)}`);
      await pipeline(req, createWriteStream(dest));
      return json(res, 200, { path: dest, staged: true });
    }

    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const { path: zipPath, project, name } = await readJsonBody(req);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

      try {
        await upload({ gh, config, zipPath, project, taskName: name, emit });
        await discardStaged(zipPath, emit);
      } catch (err) {
        console.error(err);
        // Keep any staged copy on failure so a retry can resume from it.
        emit({ type: 'error', message: err.message });
      }
      return res.end();
    }

    // ------------------------------------------------------------- static
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(PUBLIC)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    } else {
      console.error(err);
      json(res, 500, { error: err.message });
    }
  }
});

server.listen(config.port, '127.0.0.1', async () => {
  const url = `http://localhost:${config.port}`;
  console.log(`
  WebODM Backup Hub — uploader
  ----------------------------
  repo       ${config.slug}
  dashboard  ${config.pagesUrl}

  Open ${url}
`);

  // Verify the token before the user drags in a 5 GB file.
  try {
    const repo = await gh.api('GET', '');
    if (!repo) console.warn('  ! Repository not visible to this token. Check GITHUB_TOKEN scope.\n');
  } catch (err) {
    console.warn(`  ! Token check failed: ${err.message}\n`);
  }

  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
});
