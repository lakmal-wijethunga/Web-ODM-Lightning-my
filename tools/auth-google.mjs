#!/usr/bin/env node
/**
 * One-time helper: obtain a Google OAuth refresh token for Drive.
 *
 * Run this once on your own machine. It starts a throwaway localhost server,
 * sends you to Google's consent screen, catches the redirect, and prints the
 * refresh token to paste into GitHub secrets. The token is long-lived, so the
 * publish workflow can then run unattended.
 *
 *   node tools/auth-google.mjs --id <CLIENT_ID> --secret <CLIENT_SECRET>
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { DRIVE_SCOPE } from './lib/google-auth.mjs';

const PORT = 53682; // arbitrary high port, must match the OAuth client's redirect URI
const REDIRECT_URI = `http://localhost:${PORT}`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function openBrowser(url) {
  const command =
    process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(command, [url], { shell: true, detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* fall back to the printed URL */
  }
}

const args = parseArgs(process.argv.slice(2));
const clientId = args.id ?? process.env.GOOGLE_CLIENT_ID;
const clientSecret = args.secret ?? process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    '\nUsage: node tools/auth-google.mjs --id <CLIENT_ID> --secret <CLIENT_SECRET>\n\n' +
      'Create these in Google Cloud Console > APIs & Services > Credentials,\n' +
      'as an OAuth client of type "Desktop app". See docs/SETUP.md.\n',
  );
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    // Without prompt=consent Google omits refresh_token on repeat authorisations,
    // which is the single most common way this flow appears to "silently fail".
    prompt: 'consent',
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  const reply = (message) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">
      <p>${message}</p><p>You can close this tab.</p></body>`);
  };

  if (error) {
    reply(`Authorisation failed: ${error}`);
    console.error(`\n✗ Authorisation failed: ${error}\n`);
    server.close();
    process.exitCode = 1;
    return;
  }
  if (!code) {
    res.writeHead(404).end();
    return;
  }

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const json = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(json));

    if (!json.refresh_token) {
      throw new Error(
        'Google returned no refresh_token. Revoke this app at ' +
          'https://myaccount.google.com/permissions and run again.',
      );
    }

    reply('Authorised. Your refresh token has been printed to the terminal.');
    console.log('\n✓ Add these to your repo secrets (Settings > Secrets and variables > Actions):\n');
    console.log(`  GOOGLE_CLIENT_ID      ${clientId}`);
    console.log(`  GOOGLE_CLIENT_SECRET  ${clientSecret}`);
    console.log(`  GOOGLE_REFRESH_TOKEN  ${json.refresh_token}\n`);
  } catch (err) {
    reply('Token exchange failed — see the terminal.');
    console.error(`\n✗ Token exchange failed: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log(`\n  Opening Google consent screen…`);
  console.log(`  If it does not open, visit:\n\n  ${authUrl}\n`);
  openBrowser(authUrl);
});
