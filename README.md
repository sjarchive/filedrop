# FileDrop

Self-hosted file sharing: log in, upload a file, get a shareable link that expires when you choose.

- **Cloudflare Workers** (free tier) — hosts the site, auth, and share links
- **Backblaze B2** (10 GB free) — private bucket that holds the files
- **Cloudflare KV** (free tier) — sessions, file metadata, link expiry
- An **hourly cron** deletes expired files from B2 automatically
- **Mobile-first glass UI** — aurora/mesh gradients, glassmorphism, spotlight & border glow, 3D tilt, parallax, skeleton loaders; fully reduced-motion aware
- **Continuous Deployment**: every push to `main` is automatically built and deployed to the Cloudflare Worker via [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) (`npx wrangler deploy`). The GitHub repo is the source of truth — the worker keeps running even if the local clone is deleted.

## How it works

```
Browser ── login ─────────────────────► Worker  (session cookie in KV)
Browser ── 1. init upload ────────────► Worker  (presigned PUT URL, 1 h)
Browser ── 2. PUT file directly ──────► B2      (bucket stays private)
Other   ── GET /s/<id> ───────────────► Worker  (KV expiry check → streams file from B2; the B2 URL is never exposed)
Cron    ── hourly ────────────────────► Worker  (purge expired objects from B2)
```

## Setup

### 1. Backblaze B2
1. Create a free account at backblaze.com → **B2 Cloud Storage**.
2. **Create a private bucket** (File Type: *Private*, Object Lock: off). Note its **name**.
3. Find the bucket's **endpoint / region** in the bucket settings (shows like `s3.us-west-004.backblazeb2.com`) — note the region, e.g. `us-west-004`.
4. Go to **Application Keys** → *Add a new application key*, scoped to that bucket, with read/write access (no `keyID` wipe). Note the **keyID** and **applicationKey**.
5. On the bucket → **Lifecycle/Settings**, or under *Application key creation page*: add a **CORS rule** allowing PUT/GET from your site origin (required for browser uploads):
   - Allowed origins: `https://<your-worker-name>.<your-subdomain>.workers.dev`
   - Allowed HTTP methods: `GET, PUT, HEAD`
   - Allowed headers: `*`

### 2. Cloudflare
```bash
npm install
npx wrangler login
npx wrangler kv namespace create FILES    # copy the "id" into wrangler.jsonc
```

### 3. Configure
Edit `wrangler.jsonc`:
- `kv_namespaces[0].id` → your KV namespace id
- `B2_BUCKET` → your B2 bucket name
- `B2_ENDPOINT` → `https://s3.<region>.backblazeb2.com`
- `B2_REGION` → e.g. `us-west-004`

Login uses a single username/password stored as secrets (never in code):

```bash
npx wrangler secret put B2_KEY_ID     # B2 application keyID
npx wrangler secret put B2_APP_KEY    # B2 applicationKey
npx wrangler secret put AUTH_USER     # your login username
npx wrangler secret put AUTH_PASS     # your login password
```

### 4. Deploy
```bash
npm run deploy
```
Your shareable file drop is live at `https://filedrop.<your-subdomain>.workers.dev`.

Local testing: `npm run dev` (use `http://localhost:8787`; put the same secrets in a `.dev.vars` file).

## Notes & limits

- **Max file size**: B2 caps objects at ~5 TB — the presigned-PUT flow means uploads never pass through the Worker, so there is no 100 MB Worker limit. Watch the 10 GB free-storage cap (cron clears expired files hourly).
- **Link expiry**: presets 1 h / 1 d / 7 d / 30 d count from when the upload *finishes* (not from when you clicked); a custom date/time is absolute, up to 90 days ahead.
- **B2 egress**: free 3× storage / day (≈ 30 GB/day on free tier). Downloads proxy through the Worker, so visitors never see (or bookmark) the long presigned B2 URL — the share link stays short and private in the address bar.
- **Auth**: sessions are 7-day HttpOnly cookies; login is rate-limited to 10 attempts/hour/IP (fixed window). All responses carry `nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer`, and pages get a strict CSP (login page scripts live in `/login.js`, not inline).
- **Duplicate uploads**: the browser SHA-256-hashes files up to 256 MB and sends the hash with the init request; if identical bytes are already shared and unexpired, the worker skips the upload entirely and returns the previous `/s/<id>` link. The dedupe entry dies with the file's expiry, so links can never be resurrected.
- **Orphan cleanup**: every upload init writes a `pending:` marker in KV; if the upload is never finalized (browser closed mid-flow), the hourly cron deletes the orphaned B2 object after 2 hours — no dashboard cleanup needed.
