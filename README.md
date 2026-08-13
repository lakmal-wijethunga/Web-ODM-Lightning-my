# WebODM Share

A self-hosted replacement for WebODM Lightning's sharing feature. You process
drone maps locally in WebODM Desktop; this publishes them as private,
streamable links your clients open in a browser — no login, no install, no
per-seat pricing.

**[Setup guide →](docs/SETUP.md)**

---

## How it works

GitHub Pages is static hosting with a 100 MB file cap and ~1 GB repo limit, so
survey data cannot live there. It doesn't. Pages hosts only the viewer and a
small encrypted manifest per project; the heavy assets stream from object
storage over HTTP range requests.

```
  You (Windows)              GitHub Actions (ubuntu)            Client browser
  ─────────────              ───────────────────────            ──────────────
  WebODM task .zip
        │ drag & drop
        ▼
  ┌─────────────┐  authed    ┌──────────────────────┐
  │ Drive inbox │──download─►│ GDAL: ortho/DEM→COG  │
  └─────────────┘            │ PDAL: LAZ → COPC     │
        ▲                    └──────────┬───────────┘
        │ workflow_dispatch              │ upload
        │ (file id + title)              ▼
                              ┌────────────────────┐ range+CORS ┌──────────────┐
                              │ Drive (or HF Hub)  │◄───────────│ Pages viewer │
                              └────────────────────┘  streaming └──────▲───────┘
                                        │ encrypted manifest            │
                                        └───────────────────────────────┘
```

Drive is used for **ingest** because that plays to its strength: one big
authenticated server-side download per publish. It also serves assets by
default, though that is the swappable part.

## Viewer

- **2D** — orthophoto over OpenStreetMap, layer toggles, per-layer opacity,
  geodesic distance/area measurement, live elevation readout from the DSM.
- **3D** — COPC point cloud streamed from a single file, progressively loaded
  within a device-aware point budget.
- **Files** — original full-resolution assets for download.
- Mobile-friendly, dark-mode aware, branded per project from the manifest.

## Privacy

Share links carry a 64-bit random slug and the manifest is **AES-256-GCM
encrypted** with a password (PBKDF2-SHA256, 310k iterations). The repo is
public, so only ciphertext is committed: scraping it yields slugs and nothing
else.

Be clear about the limit — this is **not access control**. Assets sit at
unguessable but unauthenticated URLs, so anyone who has ever had the password
retains working links. Revoking means re-uploading. For real revocation, put
storage behind signed URLs.

## Measured performance

Benchmarked against a real 347 MB asset, not estimated:

| Backend | Median range request | p90 | Est. pan/zoom |
| --- | --- | --- | --- |
| Google Drive | 1316 ms | 1531 ms | ~3.5 s |
| Hugging Face | 936 ms | 1328 ms | ~2.5 s |

8 KB and 64 KB requests cost almost the same (1216 vs 1316 ms), so this is
**round-trip bound, not bandwidth bound**. Payload size is nearly free; round
trips are not. Hence `BLOCKSIZE=1024` COGs (a quarter the requests of the
512 default) and always-built overviews. Raise `COG_BLOCKSIZE` to `2048` to
halve request count again.

Re-measure any time with `npm run benchmark`.

## Layout

```
shared/crypto.mjs        AES-GCM manifest encryption (Node + browser)
tools/
  publish.mjs            ingest → convert → upload → manifest
  auth-google.mjs        one-time OAuth refresh-token helper
  benchmark.mjs          real-world latency measurement
  build-viewer.mjs       esbuild bundle → dist/
  lib/storage/           drive.mjs (active) · huggingface.mjs (swap-in)
viewer/src/              main.js · map2d.js · cloud3d.js
projects/<slug>/         manifest.enc — the only per-project commit
.github/workflows/       publish.yml · pages.yml
```

## Commands

```bash
npm run auth:google -- --id <id> --secret <secret>   # one-time
npm run dev                                          # viewer at :5173
npm run build                                        # → dist/
npm run benchmark -- --slug <slug> --password <pw>
npm run publish -- --zip <local.zip> --title "Site" --password <pw>
```

## Requirements

Publishing runs in GitHub Actions and needs nothing installed locally. To run
`npm run publish` on your own machine you need **GDAL 3.1+** (COG driver) and
**PDAL 2.4+** (COPC writer) on `PATH`.
