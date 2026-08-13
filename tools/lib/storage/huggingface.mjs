/**
 * Hugging Face Hub storage driver — the swap-in alternative to Drive.
 *
 * Measured against your own 347MB test file, Drive answered range requests in
 * a median 0.64s (0.49-1.28s range) with no CDN in front. HF serves the same
 * requests off CloudFront in roughly 30-80ms, and unlike Drive it lists both
 * Accept-Ranges and Content-Range in Access-Control-Expose-Headers, so a COG
 * reader can discover file size on its own without help from the manifest.
 *
 * Switch to it by setting STORAGE_DRIVER=huggingface; nothing else changes,
 * because published manifests store absolute URLs and the viewer never learns
 * which backend produced them.
 */

import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { stat } from 'node:fs/promises';

const HF_API = 'https://huggingface.co/api';

/** Loaded lazily so the dependency is only required if you actually use HF. */
async function loadHubClient() {
  try {
    return await import('@huggingface/hub');
  } catch {
    throw new Error(
      'STORAGE_DRIVER=huggingface requires the @huggingface/hub package. ' +
        'Install it with: npm install @huggingface/hub',
    );
  }
}

export function huggingFacePublicUrl(repoId, path, revision = 'main') {
  return `https://huggingface.co/datasets/${repoId}/resolve/${revision}/${path}`;
}

export function createHuggingFaceStorage({ repoId, accessToken, env = process.env } = {}) {
  const repo = repoId ?? env.HF_REPO_ID;
  const token = accessToken ?? env.HF_TOKEN;

  if (!repo) throw new Error('Missing HF_REPO_ID (expected e.g. "your-name/drone-maps").');
  if (!token) throw new Error('Missing HF_TOKEN (a write-scoped token from huggingface.co).');

  let ensured = false;

  /** Create the dataset repo once per run; "already exists" is a success here. */
  async function ensureRepo() {
    if (ensured) return;
    const response = await fetch(`${HF_API}/repos/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: repo.split('/').pop(), type: 'dataset', private: false }),
    });

    if (!response.ok) {
      const body = await response.text();
      if (!/already (created|exists)/i.test(body)) {
        throw new Error(`Could not create HF dataset repo (${response.status}): ${body}`);
      }
    }
    ensured = true;
  }

  async function upload(localPath, { folderId = '', name, onProgress } = {}) {
    await ensureRepo();
    const { uploadFiles } = await loadHubClient();

    const remoteName = name ?? basename(localPath);
    const path = folderId ? `${folderId}/${remoteName}` : remoteName;
    const { size: bytes } = await stat(localPath);

    // openAsBlob streams from disk rather than buffering multi-GB into memory.
    const content = await openAsBlob(localPath);

    await uploadFiles({
      repo: { type: 'dataset', name: repo },
      accessToken: token,
      files: [{ path, content }],
    });

    onProgress?.({ uploaded: bytes, total: bytes, name: remoteName });

    return { id: path, url: huggingFacePublicUrl(repo, path), bytes, name: remoteName };
  }

  return {
    name: 'huggingface',
    repoId: repo,
    upload,
    publicUrl: (path) => huggingFacePublicUrl(repo, path),
    async ensureProjectFolder(slug) {
      await ensureRepo();
      return slug; // On HF a "folder" is just a path prefix inside the repo.
    },
  };
}
