import yauzl from 'yauzl';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

/**
 * Reading a WebODM backup means reading the zip's central directory, which sits
 * at the *end* of the archive. yauzl seeks to it directly rather than streaming
 * the whole file, so opening a 10 GB backup costs the same as a 10 MB one.
 */
function open(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) =>
      err ? reject(err) : resolve(zip)
    );
  });
}

/** Normalise so we can match regardless of a wrapping top-level folder. */
function normalise(entryPath) {
  return entryPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matches(entryPath, wanted) {
  const p = normalise(entryPath);
  return p === wanted || p.endsWith('/' + wanted);
}

/** List every entry as { path, size }. */
export async function listEntries(zipPath) {
  const zip = await open(zipPath);
  const entries = [];
  return new Promise((resolve, reject) => {
    zip.on('entry', (e) => {
      if (!/\/$/.test(e.fileName)) {
        entries.push({ path: normalise(e.fileName), size: e.uncompressedSize });
      }
      zip.readEntry();
    });
    zip.on('end', () => {
      zip.close();
      resolve(entries);
    });
    zip.on('error', (err) => {
      zip.close();
      reject(err);
    });
    zip.readEntry();
  });
}

/**
 * Extract the named paths to `outDir`. Small files are also returned as buffers
 * so callers can parse them without a second read.
 *
 * @param {string[]} wanted   paths inside the zip, e.g. 'odm_report/report.pdf'
 * @returns {Promise<Map<string, {file: string, size: number, buffer?: Buffer}>>}
 */
export async function extractEntries(zipPath, wanted, outDir, { bufferLimit = 8 * 1024 * 1024 } = {}) {
  await mkdir(outDir, { recursive: true });
  const zip = await open(zipPath);
  const found = new Map();
  const pending = [];

  return new Promise((resolve, reject) => {
    zip.on('entry', (entry) => {
      const hit = wanted.find((w) => matches(entry.fileName, w));
      if (!hit) return zip.readEntry();

      const outName = hit.split('/').pop();
      const outPath = path.join(outDir, outName);

      pending.push(
        new Promise((res, rej) => {
          zip.openReadStream(entry, async (err, stream) => {
            if (err) return rej(err);
            try {
              // Tee into a buffer only when the file is small enough to be worth it.
              const chunks = [];
              const small = entry.uncompressedSize <= bufferLimit;
              if (small) stream.on('data', (c) => chunks.push(c));

              await pipeline(stream, createWriteStream(outPath));
              found.set(hit, {
                file: outPath,
                size: entry.uncompressedSize,
                buffer: small ? Buffer.concat(chunks) : undefined,
              });
              res();
            } catch (e) {
              rej(e);
            }
          });
        })
      );
      zip.readEntry();
    });

    zip.on('end', async () => {
      try {
        await Promise.all(pending);
        zip.close();
        resolve(found);
      } catch (e) {
        zip.close();
        reject(e);
      }
    });
    zip.on('error', (err) => {
      zip.close();
      reject(err);
    });
    zip.readEntry();
  });
}

/**
 * Parse the root backup.json WebODM writes into every backup.
 * Returns null for archives that lack it (e.g. a raw ODM all.zip), letting the
 * caller fall back to filename-derived metadata instead of failing.
 */
export function parseBackupJson(buffer) {
  if (!buffer) return null;
  try {
    const data = JSON.parse(buffer.toString('utf8'));
    return {
      name: data.name ?? null,
      createdAt: data.created_at ?? null,
      processingTime: data.processing_time ?? null,
      options: Array.isArray(data.options) ? data.options : [],
      tags: Array.isArray(data.tags) ? data.tags : [],
      crop: data.crop ?? null,
      public: data.public ?? false,
      resizeTo: data.resize_to ?? null,
    };
  } catch {
    return null;
  }
}
