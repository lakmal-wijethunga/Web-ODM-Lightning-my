/**
 * Storage driver registry.
 *
 * Every driver returns absolute URLs from upload(), and those URLs are what
 * land in the manifest. That is what keeps the viewer completely unaware of
 * which backend is in use, and what makes switching backends a config change
 * rather than a rewrite.
 *
 * Driver contract:
 *   name                        string identifier
 *   ensureProjectFolder(slug)   -> opaque folder handle passed back as folderId
 *   upload(localPath, opts)     -> { id, url, bytes, name }
 *   publicUrl(idOrPath)         -> absolute, range-capable, CORS-enabled URL
 */

import { createDriveStorage } from './drive.mjs';
import { createHuggingFaceStorage } from './huggingface.mjs';

const DRIVERS = {
  drive: (env) => createDriveStorage({ rootFolderId: env.GDRIVE_ROOT_FOLDER_ID, env }),
  huggingface: (env) => createHuggingFaceStorage({ env }),
};

export function createStorage(env = process.env) {
  const requested = env.STORAGE_DRIVER ?? 'drive';
  const factory = DRIVERS[requested];

  if (!factory) {
    throw new Error(
      `Unknown STORAGE_DRIVER "${requested}". Available: ${Object.keys(DRIVERS).join(', ')}.`,
    );
  }

  return factory(env);
}

export { createDriveStorage, createHuggingFaceStorage };
