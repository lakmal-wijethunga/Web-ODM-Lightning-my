/**
 * Manifest encryption, shared verbatim between the Node publisher and the
 * browser viewer. Both expose the same WebCrypto API on globalThis.crypto,
 * so this file is imported by tools/publish.mjs and by viewer/src/ alike.
 *
 * THREAT MODEL — what this actually buys, stated plainly:
 *
 *   It DOES hide asset URLs from anyone browsing the public Pages repo. The
 *   only thing committed per project is ciphertext, so scraping the repo
 *   yields slugs and nothing else. Without the password you cannot learn
 *   where the imagery lives.
 *
 *   It DOES NOT provide access control. The assets themselves live at
 *   unguessable but *unauthenticated* URLs. Anyone who has ever had the
 *   password keeps working asset links forever, and revoking access means
 *   re-uploading the assets to fresh URLs and re-publishing. If you need real
 *   revocation, move storage behind signed URLs (see docs/SETUP.md).
 */

const ENVELOPE_VERSION = 1;
const KDF_ITERATIONS = 310_000; // OWASP floor for PBKDF2-HMAC-SHA256
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96-bit nonce — the size AES-GCM is specified for

/** Base64 helpers that behave identically in Node and browsers. */
function toBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000; // chunked to avoid blowing the argument limit on big inputs
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a manifest object into a self-describing envelope. The envelope
 * carries its own KDF parameters so an older viewer can still open a manifest
 * published after the parameters are hardened.
 */
export async function encryptManifest(manifest, password) {
  if (!password) throw new Error('A password is required to encrypt a manifest.');

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, KDF_ITERATIONS);

  const plaintext = new TextEncoder().encode(JSON.stringify(manifest));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return {
    v: ENVELOPE_VERSION,
    kdf: 'PBKDF2-SHA256',
    iterations: KDF_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Reverse of encryptManifest. Throws WrongPasswordError when the AES-GCM
 * authentication tag fails, which is the only signal we get — and is exactly
 * the signal we want, since a tampered manifest fails the same way.
 */
export async function decryptManifest(envelope, password) {
  if (envelope?.v !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported manifest envelope version: ${envelope?.v}`);
  }

  const key = await deriveKey(
    password,
    fromBase64(envelope.salt),
    envelope.iterations ?? KDF_ITERATIONS,
  );

  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
      key,
      fromBase64(envelope.data),
    );
  } catch {
    // WebCrypto throws a bare OperationError here; translate it into something
    // the viewer can branch on to show "wrong password" rather than a crash.
    const err = new Error('Incorrect password, or the manifest has been altered.');
    err.name = 'WrongPasswordError';
    throw err;
  }

  return JSON.parse(new TextDecoder().decode(plaintext));
}
