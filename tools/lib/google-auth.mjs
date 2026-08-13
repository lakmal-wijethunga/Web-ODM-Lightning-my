/**
 * Google service-account auth using nothing but node:crypto and fetch.
 *
 * The googleapis SDK would pull ~40MB of transitive dependencies to do what
 * amounts to signing one JWT, and every extra dependency is another thing that
 * can break a publish run months from now. The whole flow is ~50 lines.
 */

import { createSign } from 'node:crypto';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/**
 * drive.file limits us to files this app itself created, which is the smallest
 * scope that still permits upload + sharing. It also keeps the OAuth consent
 * screen out of Google's "restricted scope" review, which full drive access
 * would drag us into.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Tokens last an hour; cache per service account so a publish reuses one. */
const tokenCache = new Map();

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/**
 * Parse a service account key from either a raw JSON string or base64. GitHub
 * secrets mangle multi-line values often enough that base64 is the safer way
 * to carry the PEM private key, so we accept both.
 */
export function parseServiceAccount(raw) {
  if (!raw) {
    throw new Error(
      'Missing service account key. Set the GDRIVE_SERVICE_ACCOUNT secret ' +
        '(see docs/SETUP.md).',
    );
  }

  let text = raw.trim();
  if (!text.startsWith('{')) {
    // Not JSON, so assume base64-wrapped JSON.
    text = Buffer.from(text, 'base64').toString('utf8').trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      'Service account key is neither valid JSON nor base64-encoded JSON.',
    );
  }

  for (const field of ['client_email', 'private_key']) {
    if (!parsed[field]) {
      throw new Error(`Service account key is missing required field "${field}".`);
    }
  }

  // Secrets pasted through web UIs frequently arrive with literal \n instead of
  // real newlines, which makes the PEM unparseable in a very confusing way.
  parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  return parsed;
}

/**
 * OAuth installed-app refresh-token flow — the path that actually works for a
 * consumer Gmail account, and the default for this project.
 *
 * Service accounts are the obvious-looking choice and they are a trap here:
 * they have no Drive storage quota of their own, so uploading into a folder
 * you merely shared with them fails with "Service Accounts do not have storage
 * quota". The usual fix is a Shared Drive, which requires Google Workspace.
 * Authenticating as yourself bills the bytes to your own Drive quota instead,
 * which is both what you want and what a Gmail account can actually do.
 */
export async function getAccessTokenFromRefreshToken({ clientId, clientSecret, refreshToken }) {
  const cacheKey = `refresh:${clientId}:${refreshToken?.slice(-12)}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  for (const [name, value] of Object.entries({ clientId, clientSecret, refreshToken })) {
    if (!value) throw new Error(`Missing Google OAuth "${name}" (see docs/SETUP.md).`);
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    // invalid_grant almost always means the refresh token was revoked, which
    // happens silently if the OAuth app is left in "Testing" publishing status.
    const hint = body.includes('invalid_grant')
      ? ' Your refresh token has expired or been revoked — re-run "npm run auth:google". ' +
        'If the OAuth consent screen is still in Testing mode, tokens expire after 7 days; ' +
        'publish the app to remove that limit.'
      : '';
    throw new Error(`Google refresh-token exchange failed (${response.status}): ${body}.${hint}`);
  }

  const { access_token: token, expires_in: expiresIn } = await response.json();
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

/**
 * Pick whichever credential set is configured, preferring the refresh token.
 * Keeps the service-account branch available for anyone on Workspace who wants
 * to point this at a Shared Drive instead.
 */
export async function resolveAccessToken(env = process.env, scope = DRIVE_SCOPE) {
  if (env.GOOGLE_REFRESH_TOKEN) {
    return getAccessTokenFromRefreshToken({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
    });
  }

  if (env.GDRIVE_SERVICE_ACCOUNT) {
    return getAccessToken(parseServiceAccount(env.GDRIVE_SERVICE_ACCOUNT), scope);
  }

  throw new Error(
    'No Google credentials found. Set GOOGLE_REFRESH_TOKEN (plus GOOGLE_CLIENT_ID ' +
      'and GOOGLE_CLIENT_SECRET), or GDRIVE_SERVICE_ACCOUNT if you are on Workspace ' +
      'with a Shared Drive. See docs/SETUP.md.',
  );
}

export async function getAccessToken(serviceAccount, scope) {
  const cacheKey = `${serviceAccount.client_email}:${scope}`;
  const cached = tokenCache.get(cacheKey);
  // Refresh a minute early so a long upload never dies on a token that expired
  // between the check and the request.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope,
      aud: TOKEN_ENDPOINT,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signingInput = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);

  let signature;
  try {
    signature = signer.sign(serviceAccount.private_key).toString('base64url');
  } catch (err) {
    throw new Error(
      `Could not sign with the service account private key: ${err.message}. ` +
        'The PEM is probably corrupted — try base64-encoding the whole JSON key.',
    );
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: GRANT_TYPE,
      assertion: `${signingInput}.${signature}`,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google token request failed (${response.status}): ${body}`);
  }

  const { access_token: token, expires_in: expiresIn } = await response.json();
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}
