# WebODM Backup Hub

A WebODM Lightning–style dashboard for **archiving WebODM task backups in GitHub**, for free.

WebODM Lightning keeps processed results on a temporary URL for 10 days unless you pay for a
plan. This gives those backups a permanent home: GitHub Releases stores the files, GitHub Pages
serves the dashboard, and a local drag-and-drop app puts new backups in.

It archives and browses backups. It does **not** process imagery — keep using WebODM for that.

**Dashboard:** https://lakmal-wijethunga.github.io/Web-ODM-Lightning-my/

---

## Why it is built this way

Four measured constraints shaped the whole design:

| Constraint | Consequence |
|---|---|
| Repo files hard-block at **100 MiB**; Git LFS bills past 1 GB | Backups cannot live in the repo |
| Releases allow **2 GiB per asset, 1000 assets**, with *no* total-size or bandwidth cap | Releases are the store |
| `api.github.com` is CORS-open but capped at **60 requests/hour per IP** | The dashboard reads a static manifest, never the API |
| `uploads.github.com` returns **no CORS headers** | Uploading from a web page is impossible — it runs locally in Node |

Release asset downloads also carry `Access-Control-Allow-Origin: https://render.githubusercontent.com`,
so `fetch()` against them fails while a plain `<a download>` link works. That is why downloads are
links, and why split backups are rejoined with a shell command instead of in the browser.

```
Release  task-<project>-<name>          ← one per task, and the source of truth
  body   metadata JSON in an HTML comment
  assets backup.zip  (or backup.zip.part01..NN when over 1.9 GiB)
         orthophoto.tif  report.pdf  shots.geojson  cameras.json  backup.json
                     │
      uploader emits │ docs/manifest.json + docs/previews/<tag>.geojson
                     ▼
              GitHub Pages  →  same-origin, zero API calls
```

---

## Setup

**1. Install**

```bash
npm install
```

**2. Create a token**

Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new):

- **Repository access** → Only select repositories → this repo
- **Permissions** → Repository permissions → **Contents: Read and write**

That is the only permission needed. Avoid a classic `repo`-scoped token — it would grant write
access to every repository you own.

```bash
cp uploader/.env.example uploader/.env   # then paste the token in
```

`uploader/.env` is gitignored. The token stays on your machine and is never part of the published
site.

**3. Enable Pages**

Settings → Pages → Source: **Deploy from a branch** → `main` / `/docs`. No build step.

---

## Archiving a backup

In WebODM: expand a task → **Download Assets → Backup**. Then:

```bash
npm run upload
```

A page opens at `localhost:4000`. Click to pick the backup with the native file dialog — the file
is read where it sits, with nothing copied. (Dragging works too, but a browser cannot reveal a
file's path, so the bytes must be staged to `.tmp/` first; that copy is deleted after a successful
upload. For very large backups, prefer the picker.)

The uploader then:

1. Reads `backup.json` from inside the zip — task name, capture date, processing time, options,
   tags. Only the project name is typed by hand.
2. Derives the map footprint and image count from `odm_report/shots.geojson`.
3. Extracts `orthophoto.tif`, `report.pdf`, `shots.geojson` and `cameras.json` as their own
   downloads.
4. Splits anything over 1.9 GiB into parts — streamed as byte ranges of the original, so a 6 GB
   backup needs **no extra disk**.
5. Commits the regenerated manifest and footprint in one atomic commit.

Interrupted uploads resume: re-select the same file and already-uploaded assets are skipped.

---

## Downloading a split backup

Download every part into one folder, then rejoin. The dashboard shows the exact command with a
copy button; parts are raw byte ranges, so concatenation restores the original exactly.

```powershell
# PowerShell
$out=[IO.File]::Create("backup.zip")
Get-ChildItem backup.zip.part* | Sort-Object Name | ForEach-Object {
  $s=[IO.File]::OpenRead($_.FullName); $s.CopyTo($out); $s.Close() }
$out.Close()
```

```bash
# macOS / Linux
cat backup.zip.part* > backup.zip
```

---

## Everything is public

This repo is public, so **anyone with the URL can download your orthophotos and point clouds.**
Do not archive client work you are not free to publish. Deleting a release later is not a reliable
undo — assets may already be cached or mirrored.

---

## Maintenance

```bash
npm test            # verifies split/rejoin is byte-identical, plus manifest logic
npm run manifest    # rebuild docs/manifest.json from the releases
```

Releases carry their own metadata, so the manifest is always reproducible from them.
`.github/workflows/rebuild-manifest.yml` reruns it automatically whenever a release is published,
edited, or deleted — including edits made through the GitHub web UI.

## Layout

```
docs/                 dashboard (GitHub Pages serves this folder)
  manifest.json       generated index — the only file the page fetches
  previews/           per-task footprint GeoJSON
uploader/             local-only; never deployed
  lib/                zip reading, splitting, GitHub API, footprints, manifest
  bin/selftest.js     split/rejoin byte-correctness checks
.github/workflows/    manifest rebuild
```
