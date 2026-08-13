import https from 'node:https';
import { createReadStream } from 'node:fs';

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

export class GitHub {
  constructor({ token, owner, repo }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this._defaultBranch = null;
  }

  get base() {
    return `${API}/repos/${this.owner}/${this.repo}`;
  }

  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'webodm-backup-hub',
      ...extra,
    };
  }

  async api(method, url, body) {
    const res = await fetch(url.startsWith('http') ? url : this.base + url, {
      method,
      headers: this.headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      let hint = '';
      if (res.status === 401) hint = '\nThe token is invalid or expired.';
      if (res.status === 403 && text.includes('rate limit')) hint = '\nRate limited — wait and retry.';
      if (res.status === 403) hint ||= '\nThe token likely lacks Contents: Read and write on this repo.';
      throw new Error(`GitHub ${method} ${url} -> ${res.status}${hint}\n${text.slice(0, 500)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async defaultBranch() {
    if (!this._defaultBranch) {
      const repo = await this.api('GET', '');
      if (!repo) throw new Error(`Repository ${this.owner}/${this.repo} not found, or the token cannot see it.`);
      this._defaultBranch = repo.default_branch;
    }
    return this._defaultBranch;
  }

  // ---------------------------------------------------------------- releases

  listReleases() {
    return this.api('GET', '/releases?per_page=100');
  }

  getReleaseByTag(tag) {
    return this.api('GET', `/releases/tags/${encodeURIComponent(tag)}`);
  }

  createRelease({ tag, name, body }) {
    return this.api('POST', '/releases', {
      tag_name: tag,
      name,
      body,
      draft: false,
      prerelease: false,
    });
  }

  updateRelease(id, patch) {
    return this.api('PATCH', `/releases/${id}`, patch);
  }

  deleteAsset(id) {
    return this.api('DELETE', `/releases/assets/${id}`);
  }

  /**
   * Stream a byte range of a local file to a release asset.
   *
   * Uploading a *range* rather than a pre-split temp file is what keeps disk
   * usage flat: a 6 GB backup becomes four assets without ever writing a
   * second copy to disk.
   *
   * Uses node:https rather than fetch because GitHub rejects the upload
   * outright without an exact Content-Length, and a raw request lets us count
   * bytes for progress as they go out.
   */
  uploadAsset({ releaseId, name, filePath, start = 0, end, onProgress }) {
    const size = end - start + 1;
    const url = new URL(`${UPLOADS}/repos/${this.owner}/${this.repo}/releases/${releaseId}/assets`);
    url.searchParams.set('name', name);

    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: 'POST',
          headers: this.headers({
            'Content-Type': 'application/octet-stream',
            'Content-Length': size,
          }),
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(text));
            } else {
              reject(new Error(`Upload of ${name} failed (${res.statusCode}): ${text.slice(0, 400)}`));
            }
          });
        }
      );

      req.on('error', reject);

      let sent = 0;
      const src = createReadStream(filePath, { start, end });
      src.on('error', (err) => {
        req.destroy();
        reject(err);
      });
      src.on('data', (chunk) => {
        sent += chunk.length;
        onProgress?.(sent, size);
      });
      src.pipe(req);
    });
  }

  // ------------------------------------------------------------- git objects

  /**
   * Commit several files at once via the Git Data API.
   *
   * The Contents API writes one file per commit, which would leave the
   * manifest and its preview files in separate commits — and briefly
   * inconsistent. Building a tree gives one atomic commit instead.
   *
   * @param {Array<{path: string, content: string}>} files  UTF-8 content
   */
  async commitFiles(files, message) {
    if (!files.length) return null;

    const branch = await this.defaultBranch();
    const ref = await this.api('GET', `/git/ref/heads/${branch}`);
    if (!ref) throw new Error(`Branch ${branch} has no commits yet. Push an initial commit first.`);

    const headSha = ref.object.sha;
    const headCommit = await this.api('GET', `/git/commits/${headSha}`);

    const blobs = await Promise.all(
      files.map(async (f) => {
        const blob = await this.api('POST', '/git/blobs', {
          content: Buffer.from(f.content, 'utf8').toString('base64'),
          encoding: 'base64',
        });
        return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
      })
    );

    const tree = await this.api('POST', '/git/trees', {
      base_tree: headCommit.tree.sha,
      tree: blobs,
    });

    const commit = await this.api('POST', '/git/commits', {
      message,
      tree: tree.sha,
      parents: [headSha],
    });

    await this.api('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha });
    return commit;
  }
}
