/**
 * Google Drive storage driver.
 *
 * The URL format below is the whole reason Drive is usable here at all. Drive
 * serves files over 100MB behind a "Google Drive can't scan this file for
 * viruses" HTML interstitial, which returns text/html with no CORS headers and
 * ignores Range — useless to a browser. Appending `confirm=t` bypasses that
 * permanently, and the resulting URL was verified to return:
 *
 *   206 Partial Content
 *   Accept-Ranges: bytes
 *   Content-Range: bytes 0-99/363959902
 *   Access-Control-Allow-Origin: *
 *   (OPTIONS preflight -> 200, Allow-Methods: GET,HEAD,OPTIONS, Range allowed)
 *
 * The token is static — no uuid, no cookie, no HTML scraping — so asset URLs
 * are constructible from a file ID alone and stay valid indefinitely.
 *
 * Known gap: Content-Range is NOT in Drive's Access-Control-Expose-Headers, so
 * browser JS cannot read it off a 206. We sidestep this by recording every
 * asset's byte length in the manifest at publish time, so the viewer never has
 * to discover a size at runtime.
 */

import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveAccessToken, DRIVE_SCOPE } from '../google-auth.mjs';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Must be a multiple of 256KB per the resumable upload protocol. */
const CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_ATTEMPTS = 5;

const MIME_BY_EXT = {
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.laz': 'application/octet-stream',
  '.las': 'application/octet-stream',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

/** The verified public, range-capable URL for a Drive file. */
export function drivePublicUrl(fileId) {
  return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function driveFetch(url, token, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

export function createDriveStorage({ rootFolderId, env = process.env } = {}) {
  let tokenPromise = null;

  const token = () => {
    tokenPromise ??= resolveAccessToken(env, DRIVE_SCOPE);
    return tokenPromise;
  };

  /**
   * Find a child folder by name, or create it. Publishing the same slug twice
   * should reuse the folder rather than pile up duplicates — Drive happily
   * allows many folders with identical names, so we must look first.
   */
  async function ensureFolder(name, parentId) {
    const auth = await token();
    const query = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      `mimeType = '${FOLDER_MIME}'`,
      parentId ? `'${parentId}' in parents` : null,
      'trashed = false',
    ]
      .filter(Boolean)
      .join(' and ');

    const search = await driveFetch(
      `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`,
      auth,
    );
    if (!search.ok) {
      throw new Error(`Drive folder lookup failed (${search.status}): ${await search.text()}`);
    }

    const { files } = await search.json();
    if (files?.length) return files[0].id;

    const created = await driveFetch(`${DRIVE_API}/files?fields=id`, auth, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    });
    if (!created.ok) {
      throw new Error(`Drive folder create failed (${created.status}): ${await created.text()}`);
    }
    return (await created.json()).id;
  }

  /** Grant "anyone with the link can read", which is what makes the URL public. */
  async function shareAnyone(fileId) {
    const auth = await token();
    const response = await driveFetch(`${DRIVE_API}/files/${fileId}/permissions`, auth, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });

    // 400 with "already exists" is fine on republish; anything else is not.
    if (!response.ok) {
      const body = await response.text();
      if (!body.includes('alreadyExists')) {
        throw new Error(`Drive share failed (${response.status}): ${body}`);
      }
    }
  }

  /** Start a resumable session and return its upload URI. */
  async function startSession(name, folderId, mimeType, totalBytes) {
    const auth = await token();
    const response = await driveFetch(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id`, auth, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-upload-content-type': mimeType,
        'x-upload-content-length': String(totalBytes),
      },
      body: JSON.stringify({ name, ...(folderId ? { parents: [folderId] } : {}) }),
    });

    if (!response.ok) {
      const body = await response.text();
      const hint = body.includes('storageQuotaExceeded')
        ? ' Your Drive is full — publishing keeps both originals and derivatives, ' +
          'so budget roughly 2x the raw task size.'
        : '';
      throw new Error(`Could not start Drive upload (${response.status}): ${body}.${hint}`);
    }

    const uri = response.headers.get('location');
    if (!uri) throw new Error('Drive did not return a resumable session URI.');
    return uri;
  }

  /**
   * Upload one file, chunked and resumable. Drive replies 308 between chunks
   * and includes a Range header telling us how much it actually committed —
   * we trust that over our own cursor so a partially-received chunk re-sends.
   */
  async function upload(localPath, { folderId, name, onProgress } = {}) {
    const remoteName = name ?? basename(localPath);
    const { size: totalBytes } = await stat(localPath);
    const mimeType = MIME_BY_EXT[extname(localPath).toLowerCase()] ?? 'application/octet-stream';

    const sessionUri = await startSession(remoteName, folderId, mimeType, totalBytes);
    const handle = await open(localPath, 'r');

    try {
      let offset = 0;
      let fileId = null;

      while (offset < totalBytes) {
        const length = Math.min(CHUNK_BYTES, totalBytes - offset);
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);

        let attempt = 0;
        for (;;) {
          attempt += 1;
          let response;
          try {
            response = await fetch(sessionUri, {
              method: 'PUT',
              headers: {
                'content-length': String(length),
                'content-range': `bytes ${offset}-${offset + length - 1}/${totalBytes}`,
              },
              body: buffer,
            });
          } catch (err) {
            if (attempt >= MAX_ATTEMPTS) throw err;
            await sleep(2 ** attempt * 500);
            continue;
          }

          if (response.status === 308) {
            // Resume Incomplete. "Range: bytes=0-N" is the last committed byte.
            const range = response.headers.get('range');
            offset = range ? Number(range.split('-')[1]) + 1 : offset + length;
            break;
          }

          if (response.ok) {
            fileId = (await response.json()).id;
            offset = totalBytes;
            break;
          }

          if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
            await sleep(2 ** attempt * 500);
            continue;
          }

          throw new Error(
            `Drive chunk upload failed (${response.status}): ${await response.text()}`,
          );
        }

        onProgress?.({ uploaded: offset, total: totalBytes, name: remoteName });
      }

      if (!fileId) throw new Error(`Drive never returned a file ID for ${remoteName}.`);
      await shareAnyone(fileId);

      return { id: fileId, url: drivePublicUrl(fileId), bytes: totalBytes, name: remoteName };
    } finally {
      await handle.close();
    }
  }

  async function getMetadata(fileId) {
    const auth = await token();
    const response = await driveFetch(
      `${DRIVE_API}/files/${fileId}?fields=id,name,size,mimeType`,
      auth,
    );
    if (!response.ok) {
      throw new Error(
        `Could not read Drive file ${fileId} (${response.status}): ${await response.text()}. ` +
          'Check the file ID, and that the account you authorised can see it.',
      );
    }
    return response.json();
  }

  /**
   * Ingest: stream a task backup out of Drive onto the runner's disk.
   *
   * This is authenticated (alt=media with a Bearer token), not the public
   * confirm=t URL — the source zip stays private, and server-side download
   * never meets the virus-scan interstitial that blocks the public endpoint.
   */
  async function download(fileId, destPath, { onProgress } = {}) {
    const auth = await token();
    const response = await driveFetch(`${DRIVE_API}/files/${fileId}?alt=media`, auth);

    if (!response.ok) {
      throw new Error(
        `Drive download failed (${response.status}): ${await response.text()}`,
      );
    }

    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;

    const source = Readable.fromWeb(response.body);
    source.on('data', (chunk) => {
      received += chunk.length;
      onProgress?.({ received, total });
    });

    const handle = await open(destPath, 'w');
    try {
      await pipeline(source, handle.createWriteStream());
    } finally {
      await handle.close();
    }

    return { path: destPath, bytes: received };
  }

  return {
    name: 'drive',
    rootFolderId,
    ensureFolder,
    upload,
    download,
    getMetadata,
    publicUrl: drivePublicUrl,
    async ensureProjectFolder(slug) {
      return ensureFolder(slug, rootFolderId);
    },
  };
}
