#!/usr/bin/env node
/**
 * Verifies that splitting a backup and rejoining it reproduces the original
 * file byte for byte.
 *
 * This is the one failure mode with no recovery: a bad byte range uploads
 * cleanly, reports success, and leaves a corrupt archive that only surfaces
 * months later when someone needs it. So it is checked against the real
 * planParts() + createReadStream() path the uploader uses, then rejoined with
 * the same shell command the dashboard tells people to run.
 *
 *   node uploader/bin/selftest.js
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { planParts } from '../lib/split.js';
import { listEntries } from '../lib/zip.js';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const sha = async (f) =>
  crypto.createHash('sha256').update(await readFile(f)).digest('hex');

/** Write one planned part by streaming the byte range, exactly as uploadAsset does. */
const writePart = (src, dest, part) =>
  pipeline(createReadStream(src, { start: part.start, end: part.end }), createWriteStream(dest));

/**
 * Rejoin using the exact commands the dashboard shows downloaders.
 *
 * The commands go into script files rather than through `cmd /c "…"`: Node's
 * Windows argument escaping mangles the `+` separators and quotes in
 * `copy /b`, which would make this test fail for reasons that have nothing to
 * do with the split being correct.
 */
async function rejoinWith(shell, dir, outDir, parts, dest) {
  if (shell === 'cmd') {
    const bat = path.join(dir, 'rejoin.bat');
    await writeFile(bat, `@echo off\r\ncopy /b ${parts.map((p) => p.name).join('+')} "${dest}"\r\n`);
    execFileSync('cmd', ['/c', bat], { cwd: outDir, stdio: 'ignore' });
  } else if (shell === 'powershell') {
    const ps1 = path.join(dir, 'rejoin.ps1');
    await writeFile(
      ps1,
      `$out=[IO.File]::Create("${dest.replace(/\\/g, '\\\\')}")\r\n` +
        `Get-ChildItem backup.zip.part* | Sort-Object Name | ForEach-Object { ` +
        `$s=[IO.File]::OpenRead($_.FullName); $s.CopyTo($out); $s.Close() }\r\n$out.Close()\r\n`
    );
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      cwd: outDir,
      stdio: 'ignore',
    });
  } else {
    execFileSync('sh', ['-c', `cat "${outDir}"/backup.zip.part* > "${dest}"`]);
  }
}

async function roundTrip(dir, bytes, partSize, label) {
  const src = path.join(dir, `${label}.bin`);
  await writeFile(src, crypto.randomBytes(bytes));

  const parts = planParts(bytes, partSize);
  const outDir = path.join(dir, label);
  await mkdir(outDir, { recursive: true });
  for (const p of parts) await writePart(src, path.join(outDir, p.name), p);

  // Sizes must tile the file exactly, with no gap and no overlap.
  const total = parts.reduce((s, p) => s + p.size, 0);
  check(`${label}: parts sum to original size`, total === bytes, `${total} vs ${bytes}`);

  const expected = await sha(src);

  // A single part is never split, so there is no rejoin command to exercise.
  const shells = parts.length === 1 ? [] : process.platform === 'win32' ? ['cmd', 'powershell'] : ['unix'];

  for (const shell of shells) {
    const joined = path.join(dir, `${label}.${shell}.bin`);
    await rejoinWith(shell, dir, outDir, parts, joined);
    const got = await sha(joined);
    check(
      `${label}: ${shell} rejoin is byte-identical`,
      got === expected,
      got === expected ? `${parts.length} parts` : `${expected.slice(0, 12)}… vs ${got.slice(0, 12)}…`
    );
  }
  return { src, parts };
}

console.log('\n== planParts() boundaries ==');
check('single part below limit', planParts(1000, 4096).length === 1);
check('single part names backup.zip', planParts(1000, 4096)[0].name === 'backup.zip');
check('exact multiple splits evenly', planParts(8192, 4096).length === 2);
check('one byte over splits into two', planParts(4097, 4096).length === 2);
check('last part carries remainder', planParts(4097, 4096)[1].size === 1);
check('ranges are contiguous', (() => {
  const p = planParts(10_000, 3000);
  return p.every((x, i) => (i === 0 ? x.start === 0 : x.start === p[i - 1].end + 1));
})());
check('names zero-padded for glob order', planParts(40_000, 4096)[0].name.endsWith('part01'));
check('rejects empty file', (() => { try { planParts(0); return false; } catch { return true; } })());
check('rejects absurd part counts', (() => {
  try { planParts(101 * 4096, 4096); return false; } catch { return true; }
})());

const dir = await mkdtemp(path.join(tmpdir(), 'odm-selftest-'));
try {
  console.log('\n== split / rejoin round-trip ==');
  await roundTrip(dir, 5 * 1024 * 1024 + 12345, 1024 * 1024, 'uneven');
  await roundTrip(dir, 4 * 1024 * 1024, 1024 * 1024, 'exact-multiple');
  await roundTrip(dir, 700 * 1024, 1024 * 1024, 'single-part');

  // A rejoined zip must still be a readable archive, not just matching bytes.
  console.log('\n== rejoined archive still opens ==');
  const zipSrc = path.join(dir, 'fake-backup.zip');
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `$d='${path.join(dir, 'zipsrc')}'; New-Item -ItemType Directory -Force $d | Out-Null; ` +
    `1..40 | ForEach-Object { $b=New-Object byte[] 40000; ` +
    `(New-Object Random).NextBytes($b); [IO.File]::WriteAllBytes("$d\\f$_.bin",$b) }; ` +
    `Compress-Archive -Path "$d\\*" -DestinationPath '${zipSrc}' -Force`], { stdio: 'ignore' });

  const { size } = await stat(zipSrc);
  const parts = planParts(size, Math.ceil(size / 3));
  const zipOut = path.join(dir, 'zipparts');
  await mkdir(zipOut, { recursive: true });
  for (const p of parts) await writePart(zipSrc, path.join(zipOut, p.name), p);

  const rejoinedZip = path.join(dir, 'rejoined.zip');
  await rejoinWith(process.platform === 'win32' ? 'cmd' : 'unix', dir, zipOut, parts, rejoinedZip);

  check('rejoined zip hashes match', (await sha(zipSrc)) === (await sha(rejoinedZip)));
  const entries = await listEntries(rejoinedZip);
  check('rejoined zip lists all entries', entries.length === 40, `${entries.length} entries`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll self-tests passed.\n');
process.exit(failures ? 1 : 0);
