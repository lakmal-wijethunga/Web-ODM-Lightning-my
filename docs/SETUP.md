# Setup

One-time configuration. Budget about 20 minutes, most of it in the Google Cloud
console.

---

## 1. Google Cloud: OAuth credentials

Publishing uploads to **your** Drive, authenticated as you.

> **Why not a service account?** Service accounts get no Drive storage quota of
> their own. Uploading into a folder you merely shared with one fails with
> `Service Accounts do not have storage quota`. The usual workaround is a Shared
> Drive, which requires Google Workspace — not available on a Gmail account.
> Authenticating as yourself bills the bytes to your own Drive quota, which is
> both correct and actually possible here.

1. Open <https://console.cloud.google.com/> and create a project.
2. **APIs & Services → Library →** enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - Add your own Google account under **Test users**
   - **Publish the app.** Left in *Testing*, refresh tokens expire after
     **7 days** and every publish will start failing with `invalid_grant`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Copy the **Client ID** and **Client secret**
5. Get a refresh token:

   ```bash
   npm run auth:google -- --id <CLIENT_ID> --secret <CLIENT_SECRET>
   ```

   A browser opens, you approve, and the terminal prints all three values.

---

## 2. Drive folders

Create two folders in your Drive:

| Folder | Purpose |
| --- | --- |
| `WebODM Inbox` | Where you drop task `.zip` backups |
| `WebODM Published` | Where converted assets are written |

Open `WebODM Published`, and copy its folder ID from the URL:

```
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
                                       └────────── this ──────────┘
```

> **Storage budget.** Publishing keeps derivatives *and* originals, so plan for
> roughly **2× your raw task size**. A free Google account has 15 GB total; at
> the 10–50 GB you estimated you will need Google One (100 GB is about
> USD 20/year).

---

## 3. GitHub configuration

Repository **Settings → Secrets and variables → Actions**.

### Secrets (masked in logs)

| Secret | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | from step 1 |
| `GOOGLE_CLIENT_SECRET` | from step 1 |
| `GOOGLE_REFRESH_TOKEN` | from step 1 |
| `GDRIVE_ROOT_FOLDER_ID` | `WebODM Published` folder ID |
| `VIEWER_PASSWORD` | the password you give clients |

> **This repository is public** (required for free Pages + unlimited Actions),
> which means **its Actions logs and run parameters are public too**. That is
> why the viewer password is a *secret* and never a workflow input — GitHub
> masks secrets in logs, but inputs are visible to anyone.
>
> For per-project passwords, create additional secrets (`PASSWORD_ACME`,
> `PASSWORD_CITYCOUNCIL`, …) and pass the **secret name** in the
> `password_secret` input when you run the workflow.

### Variables (not secret)

| Variable | Default | Purpose |
| --- | --- | --- |
| `STORAGE_DRIVER` | `drive` | `drive` or `huggingface` |
| `BRAND_COLOR` | `#2563eb` | Accent colour |
| `BRAND_LOGO_URL` | — | Logo shown in the viewer header |
| `BRAND_ORG` | — | Organisation name |
| `COG_BLOCKSIZE` | `1024` | Raise to `2048` to halve request count |

### Enable Pages

**Settings → Pages → Source: GitHub Actions.**

---

## 4. Publish

1. Upload a WebODM task `.zip` to `WebODM Inbox`.
2. Copy its file ID from the share link
   (`https://drive.google.com/file/d/<FILE_ID>/view`).
3. **Actions → Publish task → Run workflow**, fill in the file ID and title.

The run summary prints the share link:

```
https://<you>.github.io/<repo>/#/8f3a9c2e1b7d4a6f
```

Send that plus the password to your client.

---

## 5. Measuring, and switching backends

Latency, not bandwidth, governs how the viewer feels. Measure yours:

```bash
npm run benchmark -- --slug <slug> --password <password>
```

Measured from this machine against a real 347 MB asset:

| Backend | Median range request | Est. pan/zoom |
| --- | --- | --- |
| Google Drive | 1316 ms | ~3.5 s |
| Hugging Face | 936 ms | ~2.5 s |

8 KB and 64 KB requests cost nearly the same (1216 ms vs 1316 ms), so this is
**round-trip bound, not bandwidth bound**. The lever is fewer requests, not
smaller ones — raise `COG_BLOCKSIZE` before changing backend.

To switch anyway:

```bash
npm install @huggingface/hub
```

Set variable `STORAGE_DRIVER=huggingface`, variable `HF_REPO_ID`
(e.g. `your-name/drone-maps`), and secret `HF_TOKEN` (a write token from
<https://huggingface.co/settings/tokens>). Already-published projects keep
working — manifests store absolute URLs, so old and new backends coexist.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `invalid_grant` | Refresh token expired. OAuth app still in *Testing* (7-day limit) — publish it, then re-run `npm run auth:google`. |
| `Service Accounts do not have storage quota` | Using a service account. Use the refresh-token flow instead. |
| `storageQuotaExceeded` | Drive is full. Remember publishing stores ~2× the task size. |
| `Secret '…' is empty or does not exist` | Missing `VIEWER_PASSWORD` secret, or a typo in `password_secret`. |
| Job fails with `No space left on device` | Task too large for the runner's ~45 GB. Set `skip_pointcloud`, or convert locally. |
| Viewer shows "Incorrect password" | The secret's value differs from what you sent the client. |
| 3D tab missing | The task had no point cloud, or `skip_pointcloud` was set. |
