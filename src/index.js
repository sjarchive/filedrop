import { AwsClient } from 'aws4fetch';
import {
  decodeObjectKey,
  encodeContentDisposition,
  encodeKeyPath,
  escapeHtml,
  extractFileIdFromRawKey,
  isValidHexId,
  isValidSha256,
  normalizeEndpoint,
  objectKey,
  parseListVersionsXml,
  sanitizeContentType,
  sanitizeName,
} from './lib.js';

const SESSION_TTL = 60 * 60 * 24 * 7;      // login session: 7 days
const UPLOAD_PRESIGN_TTL = 60 * 60;        // presigned upload URL: 1 hour
const MIN_EXPIRY = 60;                     // link must last at least 60 s
const MAX_EXPIRY = 60 * 60 * 24 * 90;      // ...and at most 90 days
const LOGIN_ATTEMPT_LIMIT = 10;            // per IP per hour (fixed window)
const PENDING_STALE_SEC = 2 * 60 * 60;     // init'd-but-never-finalized uploads: reaped after 2 h
const MAX_DELETE_RETRIES = 5;              // cron gives up on a B2 object after this many failures
const MAX_CRON_B2_REQUESTS = 40;           // stay safely under Cloudflare Workers 50-subrequest free-tier limit

const KV_INVALID_JSON = Symbol('KV_INVALID_JSON');

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

// static pages (index.html, login.html): scripts/styles all same-origin, no inline code
// connect-src must admit the B2 host: uploads PUT files straight to it from the browser
function assetCsp(env) {
  const b2 = env.B2_ENDPOINT ? new URL(normalizeEndpoint(env.B2_ENDPOINT)).origin : '';
  return (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    `connect-src 'self' ${b2}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  );
}

// share error pages: static HTML with an inline <style>, zero scripts
const SHARE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // The app shell is protected: logged-out visitors are redirected before
      // it's served (for both GET and HEAD, on both / and /index.html).
      if ((path === '/' || path === '/index.html') && (method === 'GET' || method === 'HEAD')) {
        const sid = await requireAuth(request, env);
        if (!sid) {
          return new Response(null, {
            status: 302,
            headers: { location: '/login', ...noStore, ...SEC_HEADERS },
          });
        }
      }

      if (path === '/api/login' && method === 'POST') return await handleLogin(request, env);
      if (path === '/api/logout' && method === 'POST') return await handleLogout(request, env);
      if (path === '/api/me' && method === 'GET') {
        const sid = await requireAuth(request, env);
        return sid ? json({ ok: true }, 200, noStore) : json({ ok: false }, 401, noStore);
      }

      if (path === '/api/uploads/check' && method === 'POST') {
        return authGuard(request, env, () => handleDuplicateCheck(request, env));
      }
      if (path === '/api/uploads/init' && method === 'POST') {
        return authGuard(request, env, () => handleUploadInit(request, env));
      }
      if (path === '/api/files' && method === 'POST') {
        return authGuard(request, env, (s) => handleUploadFinalize(request, env, s));
      }
      if (path === '/api/files' && method === 'GET') {
        return authGuard(request, env, () => handleListFiles(env));
      }
      if (path.startsWith('/api/files/') && method === 'DELETE') {
        return authGuard(request, env, () => handleDeleteFile(url, env));
      }

      if (path.startsWith('/s/') && (method === 'GET' || method === 'HEAD')) {
        return await handleShare(request, path, env);
      }

      // Everything else is static assets (/, /login, css, js)
      const asset = await env.ASSETS.fetch(request);
      const res = new Response(asset.body, asset);
      for (const [k, v] of Object.entries(SEC_HEADERS)) res.headers.set(k, v);
      // Authenticated app shell should never be stored in shared/browser caches;
      // other static assets revalidate via ETag so browsers never run stale JS/CSS.
      if (path === '/' || path === '/index.html') {
        res.headers.set('cache-control', 'no-store');
      } else {
        res.headers.set('cache-control', 'no-cache');
      }
      if ((res.headers.get('content-type') || '').includes('text/html')) {
        res.headers.set('content-security-policy', assetCsp(env));
      }
      return res;
    } catch (err) {
      console.error(err);
      return json({ error: 'Internal error' }, 500, noStore);
    }
  },

  // Hourly: permanently wipe expired files, abandoned uploads, and hidden B2 versions
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpired(env));
  },
};

/* ------------------------------- helpers -------------------------------- */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...SEC_HEADERS, ...headers },
  });
}

const noStore = { 'cache-control': 'no-store' };

async function readJsonObject(request) {
  try {
    const val = await request.json();
    return val && typeof val === 'object' && !Array.isArray(val) ? val : {};
  } catch {
    return {};
  }
}

async function getKvJson(env, key) {
  const raw = await env.FILES.get(key);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : KV_INVALID_JSON;
  } catch {
    return KV_INVALID_JSON;
  }
}

function getCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

async function requireAuth(request, env) {
  const sid = getCookie(request, 'sid');
  if (!sid) return null;
  return (await env.FILES.get(`sess:${sid}`)) ? sid : null;
}

async function authGuard(request, env, fn) {
  const sid = await requireAuth(request, env);
  if (!sid) return json({ error: 'Not logged in' }, 401, noStore);
  return fn(sid);
}

function genId() {
  // 64-bit random id for share links (randomUUID would waste a nibble on the version field)
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b2Client(env) {
  return new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APP_KEY,
    service: 's3',
    region: env.B2_REGION,
    retries: 2, // keep retries bounded so Workers subrequest limits aren't exhausted
  });
}

function b2BucketUrl(env) {
  return `${normalizeEndpoint(env.B2_ENDPOINT)}/${env.B2_BUCKET}`;
}

function b2Url(env, key) {
  return `${b2BucketUrl(env)}/${key}`;
}

function consumeBudget(budget) {
  if (!budget) return true;
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

async function b2ListObjectVersionsPage(env, prefix, keyMarker, versionIdMarker, budget) {
  if (!consumeBudget(budget)) return { ok: false, budgetExceeded: true };
  const url = new URL(b2BucketUrl(env));
  url.searchParams.set('versions', '');
  if (prefix) url.searchParams.set('prefix', prefix);
  if (keyMarker) url.searchParams.set('key-marker', keyMarker);
  if (versionIdMarker) url.searchParams.set('version-id-marker', versionIdMarker);

  try {
    const resp = await b2Client(env).fetch(new Request(url, { method: 'GET' }));
    if (!resp.ok) {
      console.error('B2 ListObjectVersions failed', resp.status, prefix);
      return { ok: false, status: resp.status };
    }
    const xml = await resp.text();
    return { ok: true, ...parseListVersionsXml(xml) };
  } catch (e) {
    console.error('B2 ListObjectVersions error', e);
    return { ok: false };
  }
}

async function b2DeleteVersion(env, encodedKey, versionId, budget) {
  if (!consumeBudget(budget)) return { ok: false, budgetExceeded: true };
  const url = new URL(b2Url(env, encodedKey));
  if (versionId != null && versionId !== '') {
    url.searchParams.set('versionId', versionId);
  }
  try {
    const resp = await b2Client(env).fetch(new Request(url, { method: 'DELETE' }));
    if (resp.ok || resp.status === 404) return { ok: true };
    console.error('B2 delete version failed', resp.status, encodedKey, versionId);
    return { ok: false, status: resp.status };
  } catch (e) {
    console.error('B2 delete version error', e);
    return { ok: false };
  }
}

// Permanently delete a B2 object and ALL of its versions and delete markers.
// On Backblaze B2, a plain S3 DELETE without versionId only hides the file
// (adds a delete marker) while keeping the file bytes consuming storage quota.
// Returns true if permanently deleted (or already absent), false on error or budget exhaustion.
export async function b2Delete(env, key, budget = null) {
  const rawKey = decodeObjectKey(key);
  const encodedKey = encodeKeyPath(rawKey);
  const fileId = extractFileIdFromRawKey(rawKey);
  // Listing by "files/<id>/" avoids any query-encoding ambiguity with special characters
  const prefix = fileId ? `files/${fileId}/` : rawKey;

  const versionsToDelete = [];
  const markersToDelete = [];
  let keyMarker = null;
  let versionIdMarker = null;

  while (true) {
    const page = await b2ListObjectVersionsPage(env, prefix, keyMarker, versionIdMarker, budget);
    if (page.budgetExceeded) return false;
    if (!page.ok) {
      // Fallback if key lacks listFiles (403): HEAD for x-amz-version-id, then permanent DELETE
      if (page.status === 403) {
        return await b2DeleteViaHeadFallback(env, encodedKey, budget);
      }
      return false;
    }

    for (const v of page.versions) {
      if (v.key === rawKey) versionsToDelete.push(v.versionId);
    }
    for (const dm of page.deleteMarkers) {
      if (dm.key === rawKey) markersToDelete.push(dm.versionId);
    }

    if (!page.isTruncated || !page.nextKeyMarker) break;
    keyMarker = page.nextKeyMarker;
    versionIdMarker = page.nextVersionIdMarker;
  }

  if (!versionsToDelete.length && !markersToDelete.length) return true;

  // Delete file versions BEFORE delete markers so a partial failure never un-hides a file
  for (const versionId of versionsToDelete) {
    const res = await b2DeleteVersion(env, encodedKey, versionId, budget);
    if (!res.ok) return false;
  }
  for (const versionId of markersToDelete) {
    const res = await b2DeleteVersion(env, encodedKey, versionId, budget);
    if (!res.ok) return false;
  }
  return true;
}

async function b2DeleteViaHeadFallback(env, encodedKey, budget) {
  if (!consumeBudget(budget)) return false;
  let versionId = null;
  try {
    const head = await b2Client(env).fetch(new Request(b2Url(env, encodedKey), { method: 'HEAD' }));
    if (head.status === 404) return true;
    if (head.ok) versionId = head.headers.get('x-amz-version-id');
  } catch (e) {
    console.error('B2 head fallback error', e);
  }
  const res = await b2DeleteVersion(env, encodedKey, versionId, budget);
  return res.ok;
}

// Presigned URL (query-string signature, bucket stays private)
async function presign(env, method, key, expiresIn) {
  const url = new URL(b2Url(env, key));
  url.searchParams.set('X-Amz-Expires', String(expiresIn));
  const request = new Request(url, { method });
  const signed = await b2Client(env).sign(request, { aws: { signQuery: true } });
  return signed.url;
}

/* --------------------------------- auth ---------------------------------- */

async function sha256Bytes(s) {
  const bytes = new TextEncoder().encode(s);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function constantTimeEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  if (typeof crypto.subtle?.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function handleLogin(request, env) {
  // refuse to run with unset secrets (digest(undefined) would hash "undefined"
  // and let undefined/undefined log in)
  if (!env.AUTH_USER || !env.AUTH_PASS) {
    return json({ error: 'Server auth is not configured' }, 500, noStore);
  }

  // Fixed-window rate limit per IP: the hour bucket is baked into the key, so
  // retries never extend the window. KV is eventually consistent, so this is
  // approximate under bursts — good enough for a personal file drop.
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const rlKey = `rl:${ip}:${Math.floor(Date.now() / 3600000)}`;
  const attempts = parseInt((await env.FILES.get(rlKey)) || '0', 10);
  if (attempts >= LOGIN_ATTEMPT_LIMIT) {
    return json({ error: 'Too many failed attempts. Try again later.' }, 429, noStore);
  }

  const body = await readJsonObject(request);
  const user = String(body.user ?? '');
  const pass = String(body.pass ?? '');

  // Constant-time comparison of SHA-256 digests (no short-circuiting)
  const [a, b, expectedUser, expectedPass] = await Promise.all([
    sha256Bytes(user),
    sha256Bytes(pass),
    sha256Bytes(env.AUTH_USER),
    sha256Bytes(env.AUTH_PASS),
  ]);
  const userOk = constantTimeEqual(a, expectedUser);
  const passOk = constantTimeEqual(b, expectedPass);

  if (userOk && passOk) {
    const sid = genId() + genId();
    await Promise.all([
      env.FILES.put(`sess:${sid}`, '1', { expirationTtl: SESSION_TTL }),
      env.FILES.delete(rlKey), // a successful login clears the failure counter
    ]);
    return json({ ok: true }, 200, {
      ...noStore,
      'set-cookie': `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}`,
    });
  }

  // TTL longer than the window itself, so the counter always expires cleanly
  await env.FILES.put(rlKey, String(attempts + 1), { expirationTtl: 2 * 3600 });
  return json({ error: 'Wrong username or password' }, 401, noStore);
}

async function handleLogout(request, env) {
  const sid = getCookie(request, 'sid');
  if (sid) await env.FILES.delete(`sess:${sid}`);
  return json({ ok: true }, 200, {
    ...noStore,
    'set-cookie': 'sid=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
  });
}

/* -------------------------------- upload ---------------------------------- */

// Look up an unexpired share for a candidate identity, two ways:
//   1. exact: SHA-256 content hash (hashed by the browser for files ≤ 256 MB)
//   2. name-size fallback: catches files too big to hash or clients that can't
//      hash, WITHOUT falsely matching a modified file that has a different SHA-256
// Returns { match, id, name, expiresAt } or null.
export async function findLive(env, { hash, name, size }) {
  const validHash = isValidSha256(hash) ? String(hash) : '';
  const candidates = [];

  if (validHash) {
    candidates.push({ match: 'exact', key: `dedupe:${validHash}` });
  }
  if (name && size != null) {
    const s = Math.max(0, Math.floor(Number(size) || 0));
    if (s > 0) {
      candidates.push({
        match: 'name-size',
        key: `idmap:${s}:${sanitizeName(name)}`,
      });
    }
  }

  for (const c of candidates) {
    const hit = await getKvJson(env, c.key);
    if (!hit || hit === KV_INVALID_JSON || !hit.id) continue;
    const meta = await getKvJson(env, `file:${hit.id}`);
    if (!meta || meta === KV_INVALID_JSON || (Number(meta.expiresAt) || 0) <= Date.now()) continue;
    // If both the incoming file and the stored file have SHA-256 hashes and they differ,
    // they are provably different files with the same name & byte length — never treat as duplicate.
    if (c.match === 'name-size' && validHash && meta.hash && meta.hash !== validHash) {
      continue;
    }
    return { match: c.match, id: hit.id, name: meta.name, expiresAt: meta.expiresAt };
  }
  return null;
}

// Pre-flight duplicate check so the UI can reject the file at drop time,
// before any upload starts.
async function handleDuplicateCheck(request, env) {
  const body = await readJsonObject(request);
  const found = await findLive(env, {
    hash: String(body.hash || ''),
    name: body.name,
    size: body.size,
  });
  return json(
    found ? { ok: true, duplicate: true, ...found } : { ok: true, duplicate: false },
    200,
    noStore
  );
}

async function handleUploadInit(request, env) {
  const body = await readJsonObject(request);

  // Dedupe: if these same bytes (or the same name+size) are already shared and
  // still live, skip the upload and hand back the existing link.
  const found = await findLive(env, body);
  if (found) {
    return json({ ok: true, duplicate: true, ...found }, 200, noStore);
  }

  const id = genId();
  const key = objectKey(id, body.name);
  const uploadUrl = await presign(env, 'PUT', key, UPLOAD_PRESIGN_TTL);
  // Tracks in-flight uploads so the hourly cron can reap ones that never finalize
  await env.FILES.put(`pending:${id}`, JSON.stringify({ key, at: Math.floor(Date.now() / 1000) }));
  return json({ ok: true, id, key, uploadUrl }, 200, noStore);
}

export async function handleUploadFinalize(request, env, _sid) {
  const body = await readJsonObject(request);
  const id = String(body.id || '');
  if (!isValidHexId(id)) return json({ error: 'Invalid upload' }, 400, noStore);

  // The key is server-owned: re-derive it from id + name instead of trusting
  // the client (a malformed key would break every later presign/delete URL)
  const name = sanitizeName(body.name);
  const key = objectKey(id, name);
  if (body.key !== key) return json({ error: 'Invalid upload' }, 400, noStore);

  // Guard against double-finalizing the same upload id (which would register
  // conflicting del:<exp>:<id> timers and delete the file prematurely)
  const existing = await getKvJson(env, `file:${id}`);
  if (existing && existing !== KV_INVALID_JSON) {
    return json({ ok: true, id, link: `/s/${id}` }, 200, noStore);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  // Presets arrive as a duration, so expiry counts from *finalize* (i.e. after
  // the upload finished), not from when the user clicked. Custom dates arrive
  // as an absolute timestamp; clients may send ms or s — normalize to seconds.
  let expiresAt;
  if (body.duration != null) {
    expiresAt = nowSec + Math.max(0, Math.floor(Number(body.duration) || 0));
  } else {
    const raw = Math.floor(Number(body.expiresAt) || 0);
    expiresAt = raw > 1e12 ? Math.round(raw / 1000) : raw;
  }
  if (expiresAt < nowSec + MIN_EXPIRY || expiresAt > nowSec + MAX_EXPIRY) {
    return json({ error: 'Choose an expiry between 1 minute and 90 days ahead' }, 400, noStore);
  }

  // Verify the object actually exists in B2 and take authoritative size/type
  let size = Math.max(0, Math.floor(Number(body.size) || 0));
  let type = sanitizeContentType(body.type);
  try {
    const resp = await b2Client(env).fetch(new Request(b2Url(env, key), { method: 'HEAD' }));
    if (resp.status === 404) {
      return json({ error: 'Upload not found in storage — please try again' }, 400, noStore);
    }
    if (resp.ok) {
      const cl = resp.headers.get('content-length');
      if (cl !== null && cl !== '' && Number.isFinite(Number(cl))) {
        size = Math.max(0, Math.floor(Number(cl)));
      }
      const upstreamType = resp.headers.get('content-type');
      if (upstreamType) type = sanitizeContentType(upstreamType);
    }
  } catch (e) {
    console.error('B2 head error', e); // transient — keep client-supplied values
  }

  const hash = isValidSha256(body.hash) ? String(body.hash) : '';
  const meta = {
    key,
    name,
    size,
    type,
    ...(hash ? { hash } : {}),
    createdAt: Date.now(),
    expiresAt: expiresAt * 1000,
  };
  // No grace buffer: KV TTL kills the entry at expiry and handleShare double-checks it
  const ttl = Math.max(60, expiresAt - nowSec);
  // Remember identities so a future upload of the same bytes (or of a file with
  // the same name and size — for clients that can't hash) reuses this link.
  // Entries die with the file's expiry, so links can never be resurrected.
  const writes = [
    env.FILES.put(`file:${id}`, JSON.stringify(meta), { expirationTtl: ttl }),
    env.FILES.put(`del:${expiresAt}:${id}`, JSON.stringify({ key })),
    env.FILES.delete(`pending:${id}`),
  ];
  if (size > 0) {
    writes.push(
      env.FILES.put(
        `idmap:${size}:${name}`,
        JSON.stringify({ id, expiresAt: expiresAt * 1000 }),
        { expirationTtl: ttl }
      )
    );
  }
  if (hash) {
    writes.push(
      env.FILES.put(
        `dedupe:${hash}`,
        JSON.stringify({ id, expiresAt: expiresAt * 1000 }),
        { expirationTtl: ttl }
      )
    );
  }
  await Promise.all(writes);
  return json({ ok: true, id, link: `/s/${id}` }, 200, noStore);
}

/* ------------------------------- management ------------------------------- */

async function listKv(env, prefix) {
  const entries = [];
  let cursor;
  do {
    const listed = await env.FILES.list({ prefix, cursor, limit: 1000 });
    entries.push(...listed.keys);
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return entries;
}

async function handleListFiles(env) {
  const nowMs = Date.now();
  const files = await Promise.all(
    (await listKv(env, 'file:')).map(async (k) => {
      const meta = await getKvJson(env, k.name);
      if (!meta || meta === KV_INVALID_JSON) return null; // expired, corrupt, or mid-write
      return {
        id: k.name.split(':')[1],
        name: meta.name,
        size: meta.size,
        type: meta.type,
        createdAt: meta.createdAt,
        expiresAt: meta.expiresAt,
      };
    })
  );

  return json(
    files
      .filter(Boolean)
      .filter((f) => f.expiresAt > nowMs)
      .sort((a, b) => b.createdAt - a.createdAt),
    200,
    noStore
  );
}

async function deleteIfMatchesId(env, kvKey, id) {
  const entry = await getKvJson(env, kvKey);
  if (entry && entry !== KV_INVALID_JSON && entry.id === id) {
    await env.FILES.delete(kvKey);
  }
}

// Collect B2 keys from del:/pending: before removing KV entries tied to a file id,
// so deleting an already-expired file never orphans its object in B2.
export async function handleDeleteFile(url, env) {
  const id = url.pathname.split('/')[3];
  if (!isValidHexId(id)) return json({ error: 'Bad id' }, 400, noStore);

  const nowSec = Math.floor(Date.now() / 1000);
  const [meta, delEntries, pendingInfo] = await Promise.all([
    getKvJson(env, `file:${id}`),
    listKv(env, 'del:').then((keys) => keys.filter((k) => k.name.endsWith(`:${id}`))),
    getKvJson(env, `pending:${id}`),
  ]);

  // Recover the B2 object key from file:<id>, del:<exp>:<id>, or pending:<id>
  const b2KeysToDelete = new Set();
  if (meta && meta !== KV_INVALID_JSON && meta.key) b2KeysToDelete.add(meta.key);
  if (pendingInfo && pendingInfo !== KV_INVALID_JSON && pendingInfo.key) {
    b2KeysToDelete.add(pendingInfo.key);
  }
  const delInfos = await Promise.all(delEntries.map((k) => getKvJson(env, k.name)));
  for (const info of delInfos) {
    if (info && info !== KV_INVALID_JSON && info.key) b2KeysToDelete.add(info.key);
  }

  // Purge KV records tied to this file id (including dedupe/idmap pointers)
  const kvDeletes = [
    ...delEntries.map((k) => env.FILES.delete(k.name)),
    env.FILES.delete(`file:${id}`),
    env.FILES.delete(`pending:${id}`),
  ];
  if (meta && meta !== KV_INVALID_JSON) {
    if (meta.hash && isValidSha256(meta.hash)) {
      kvDeletes.push(deleteIfMatchesId(env, `dedupe:${meta.hash}`, id));
    }
    if (meta.name && meta.size > 0) {
      kvDeletes.push(deleteIfMatchesId(env, `idmap:${meta.size}:${sanitizeName(meta.name)}`, id));
    }
  }
  await Promise.all(kvDeletes);

  for (const b2Key of b2KeysToDelete) {
    const deleted = await b2Delete(env, b2Key);
    if (!deleted) {
      // re-arm so the hourly cron keeps retrying (bounded by MAX_DELETE_RETRIES)
      await env.FILES.put(`del:${nowSec}:${id}`, JSON.stringify({ key: b2Key, tries: 1 }));
    }
  }
  return json({ ok: true }, 200, noStore);
}

/* --------------------------------- share ---------------------------------- */

// Share link: /s/<id> — 16 hex chars, short and self-contained. The token
// (64-bit random id) is the capability. The download is proxied through the
// Worker (streamed, not buffered) so visitors never see the long B2 presigned
// URL in their address bar.
export async function handleShare(request, path, env) {
  const id = path.slice(3);
  if (!isValidHexId(id)) return sharePage('Invalid link', 'This link is malformed.', 400);

  const meta = await getKvJson(env, `file:${id}`);
  // explicit expiry check: KV TTL deletion is lazy, don't give links a grace window
  if (!meta || meta === KV_INVALID_JSON || (Number(meta.expiresAt) || 0) <= Date.now()) {
    return sharePage('Link expired', 'This link has expired or no longer exists.', 404);
  }

  const isHead = request.method === 'HEAD';
  const b2Headers = new Headers();
  const range = !isHead ? request.headers.get('range') : null;
  if (range) b2Headers.set('range', range);

  // aws4fetch signs the request automatically; the body streams pass-through
  let upstream;
  try {
    upstream = await b2Client(env).fetch(
      new Request(b2Url(env, meta.key), { method: isHead ? 'HEAD' : 'GET', headers: b2Headers })
    );
  } catch (e) {
    console.error('B2 download error', e);
    return sharePage('Error', 'Could not fetch this file right now. Please try again.', 502);
  }
  if (upstream.status === 404) {
    console.error('B2 get missing', upstream.status);
    return sharePage('Link expired', 'The file is no longer available in storage.', 404);
  }
  if (upstream.status === 416) {
    return new Response(null, { status: 416, headers: { ...noStore, ...SEC_HEADERS } });
  }
  if (!upstream.ok) {
    console.error('B2 get failed', upstream.status);
    return sharePage('Error', 'Temporary storage error. Please try again in a moment.', 502);
  }

  const headers = { ...noStore, ...SEC_HEADERS };
  headers['content-type'] = sanitizeContentType(
    meta.type || upstream.headers.get('content-type') || 'application/octet-stream'
  );
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag']) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  headers['content-disposition'] = encodeContentDisposition(meta.name || 'file');

  return new Response(isHead ? null : upstream.body, {
    status: upstream.status === 206 ? 206 : 200,
    headers,
  });
}

function sharePage(title, message, status = 200) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0c12"><title>${safeTitle}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(130% 70% at 50% 0%,#131826 0%,#0a0c12 55%) fixed,#0a0c12;color:#eef1f7;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
.aurora{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.aurora i{position:absolute;border-radius:50%}
.aurora i:nth-child(1){width:60vmax;height:60vmax;left:-15vmax;top:-20vmax;background:radial-gradient(closest-side,rgba(91,140,255,.42),transparent 72%);animation:d1 24s ease-in-out infinite alternate}
.aurora i:nth-child(2){width:52vmax;height:52vmax;right:-18vmax;bottom:-22vmax;background:radial-gradient(closest-side,rgba(139,92,246,.34),transparent 72%);animation:d2 30s ease-in-out infinite alternate}
.aurora i:nth-child(3){width:42vmax;height:42vmax;left:12vmax;bottom:-14vmax;background:radial-gradient(closest-side,rgba(34,211,238,.2),transparent 72%);animation:d1 36s ease-in-out infinite alternate-reverse}
@keyframes d1{to{transform:translate3d(7vw,5vh,0) scale(1.12)}}
@keyframes d2{to{transform:translate3d(-6vw,-7vh,0) scale(1.1)}}
.card{position:relative;width:min(420px,100%);padding:44px 38px;text-align:center;border-radius:22px;background:rgba(18,21,30,.52);border:1px solid rgba(255,255,255,.09);box-shadow:0 24px 70px rgba(2,4,10,.55),inset 0 1px 0 rgba(255,255,255,.06),0 14px 60px rgba(91,140,255,.13);-webkit-backdrop-filter:blur(20px) saturate(160%);backdrop-filter:blur(20px) saturate(160%);animation:pop .5s cubic-bezier(.22,1,.36,1) backwards}
@property --glow-angle{syntax:'<angle>';initial-value:0deg;inherits:false}
.card::before{content:'';position:absolute;inset:-1px;border-radius:23.5px;padding:1.5px;background:conic-gradient(from var(--glow-angle),transparent 0 295deg,rgba(91,140,255,.85) 325deg,rgba(139,92,246,.95) 348deg,transparent 360deg);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;animation:spin 8s linear infinite}
@keyframes spin{to{--glow-angle:360deg}}
@keyframes pop{from{opacity:0;transform:translateY(16px) scale(.97)}}
h1{font-size:20px;margin:0 0 10px;letter-spacing:-.01em}
p{color:#98a0b3;margin:0;font-size:14px;line-height:1.5}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style></head>
<body><div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
<div class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p></div></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': SHARE_CSP,
      ...noStore,
      ...SEC_HEADERS,
    },
  });
}

/* --------------------------------- cron ----------------------------------- */

export async function cleanupExpired(env, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const budget = { remaining: options.maxB2Requests ?? MAX_CRON_B2_REQUESTS };
  const stats = {
    delDeleted: 0,
    delFailed: 0,
    pendingDeleted: 0,
    pendingFailed: 0,
    sweepDeletedVersions: 0,
    sweepDeletedMarkers: 0,
    budgetExhausted: false,
  };

  // 1. Permanently delete B2 objects whose share window has ended
  for (const k of await listKv(env, 'del:')) {
    try {
      const parts = k.name.split(':');
      const sec = Number(parts[1]);
      const id = parts[2];
      if (!Number.isFinite(sec)) {
        console.error('cron: removing malformed del key', k.name);
        await env.FILES.delete(k.name);
        continue;
      }
      if (sec > nowSec) continue;

      const info = await getKvJson(env, k.name);
      if (info === KV_INVALID_JSON) {
        console.error('cron: removing corrupt del key', k.name);
        await env.FILES.delete(k.name);
        continue;
      }
      if (!info?.key) {
        await env.FILES.delete(k.name);
        continue;
      }
      if (budget.remaining <= 0) {
        stats.budgetExhausted = true;
        break;
      }

      const deleted = await b2Delete(env, info.key, budget);
      if (deleted) {
        await env.FILES.delete(k.name);
        stats.delDeleted += 1;
        // Also prune expired file:<id> if KV lazy TTL hasn't evicted it yet
        if (isValidHexId(id)) {
          const meta = await getKvJson(env, `file:${id}`);
          if (meta && meta !== KV_INVALID_JSON && (Number(meta.expiresAt) || 0) <= nowMs) {
            await env.FILES.delete(`file:${id}`);
          }
        }
      } else if (budget.remaining <= 0) {
        stats.budgetExhausted = true;
        break;
      } else {
        stats.delFailed += 1;
        const tries = (Number(info.tries) || 0) + 1;
        if (tries >= MAX_DELETE_RETRIES) {
          console.error('cron: giving up on B2 delete for', k.name);
          await env.FILES.delete(k.name);
        } else {
          await env.FILES.put(k.name, JSON.stringify({ ...info, tries }));
        }
      }
    } catch (e) {
      console.error('cron: error processing del key', k.name, e);
    }
  }

  // 2. Reap abandoned uploads: init was called but finalize never happened
  //    (presign TTL is 1 h, so anything older than PENDING_STALE_SEC is dead)
  for (const k of await listKv(env, 'pending:')) {
    try {
      const info = await getKvJson(env, k.name);
      if (info === KV_INVALID_JSON) {
        console.error('cron: removing corrupt pending key', k.name);
        await env.FILES.delete(k.name);
        continue;
      }
      if (!info) continue;
      if (Number.isFinite(info.at) && nowSec - info.at < PENDING_STALE_SEC) continue;

      if (!info.key) {
        await env.FILES.delete(k.name);
        continue;
      }
      if (budget.remaining <= 0) {
        stats.budgetExhausted = true;
        break;
      }

      const deleted = await b2Delete(env, info.key, budget);
      if (deleted) {
        await env.FILES.delete(k.name);
        stats.pendingDeleted += 1;
      } else if (budget.remaining <= 0) {
        stats.budgetExhausted = true;
        break;
      } else {
        stats.pendingFailed += 1;
        const tries = (Number(info.tries) || 0) + 1;
        if (tries >= MAX_DELETE_RETRIES) {
          console.error('cron: giving up on stale pending B2 delete for', k.name);
          await env.FILES.delete(k.name);
        } else {
          await env.FILES.put(k.name, JSON.stringify({ ...info, tries }));
        }
      }
    } catch (e) {
      console.error('cron: error processing pending key', k.name, e);
    }
  }

  // 3. Bucket reconciliation sweep: permanently purge previously hidden versions,
  //    stale delete markers, and any expired/orphaned files under "files/" in B2.
  if (budget.remaining >= 2) {
    await sweepBucketVersions(env, nowMs, nowSec, budget, stats);
  } else if (budget.remaining <= 0) {
    stats.budgetExhausted = true;
  }

  console.log('cron: cleanup complete', JSON.stringify(stats));
  return stats;
}

async function sweepBucketVersions(env, nowMs, nowSec, budget, stats) {
  const byKey = new Map();
  let keyMarker = null;
  let versionIdMarker = null;
  let truncatedBoundaryKey = null;
  let pages = 0;

  while (budget.remaining >= 2 && pages < 5) {
    pages += 1;
    const page = await b2ListObjectVersionsPage(env, 'files/', keyMarker, versionIdMarker, budget);
    if (page.budgetExceeded) {
      stats.budgetExhausted = true;
      break;
    }
    if (!page.ok) return;

    for (const v of page.versions) {
      let bucket = byKey.get(v.key);
      if (!bucket) {
        bucket = { versions: [], deleteMarkers: [] };
        byKey.set(v.key, bucket);
      }
      bucket.versions.push(v);
    }
    for (const dm of page.deleteMarkers) {
      let bucket = byKey.get(dm.key);
      if (!bucket) {
        bucket = { versions: [], deleteMarkers: [] };
        byKey.set(dm.key, bucket);
      }
      bucket.deleteMarkers.push(dm);
    }

    if (!page.isTruncated || !page.nextKeyMarker) {
      truncatedBoundaryKey = null;
      break;
    }
    truncatedBoundaryKey = page.nextKeyMarker;
    keyMarker = page.nextKeyMarker;
    versionIdMarker = page.nextVersionIdMarker;
  }

  const liveCache = new Map();
  async function getKeyStatus(id, rawKey) {
    const cacheKey = `${id}:${rawKey}`;
    if (liveCache.has(cacheKey)) return liveCache.get(cacheKey);

    const [meta, pending] = await Promise.all([
      getKvJson(env, `file:${id}`),
      getKvJson(env, `pending:${id}`),
    ]);

    let status = 'missing';
    if (meta && meta !== KV_INVALID_JSON && decodeObjectKey(meta.key) === rawKey) {
      status = (Number(meta.expiresAt) || 0) > nowMs ? 'live' : 'expired';
    } else if (
      pending &&
      pending !== KV_INVALID_JSON &&
      decodeObjectKey(pending.key) === rawKey &&
      Number.isFinite(pending.at) &&
      nowSec - pending.at < PENDING_STALE_SEC
    ) {
      status = 'pending';
    }

    liveCache.set(cacheKey, status);
    return status;
  }

  for (const [rawKey, entry] of byKey.entries()) {
    if (budget.remaining <= 0) {
      stats.budgetExhausted = true;
      break;
    }

    if (truncatedBoundaryKey && rawKey === truncatedBoundaryKey) continue; // avoid splitting a key across page boundary
    const id = extractFileIdFromRawKey(rawKey);
    if (!id) continue; // never touch objects outside files/<16-hex-id>/...

    const status = await getKeyStatus(id, rawKey);
    const encodedKey = encodeKeyPath(rawKey);
    const hasLatestDeleteMarker = entry.deleteMarkers.some((dm) => dm.isLatest);

    let remainingVersions = entry.versions.length;
    for (const v of entry.versions) {
      if (budget.remaining <= 0) {
        stats.budgetExhausted = true;
        break;
      }

      // Decide whether this specific version should be permanently destroyed:
      // - Always purge noncurrent (hidden/old) versions
      // - Purge latest version if expired, already hidden by a delete marker, or
      //   untracked in KV and older than PENDING_STALE_SEC
      let shouldDelete = !v.isLatest;
      if (!shouldDelete && status !== 'live' && status !== 'pending') {
        const modMs = v.lastModified ? Date.parse(v.lastModified) : NaN;
        const isOldEnough = Number.isFinite(modMs) && nowMs - modMs >= PENDING_STALE_SEC * 1000;
        if (status === 'expired' || hasLatestDeleteMarker || isOldEnough) {
          shouldDelete = true;
        }
      }

      if (shouldDelete) {
        const res = await b2DeleteVersion(env, encodedKey, v.versionId, budget);
        if (res.budgetExceeded) {
          stats.budgetExhausted = true;
          break;
        }
        if (res.ok) {
          remainingVersions -= 1;
          stats.sweepDeletedVersions += 1;
        }
      }
    }

    // Only purge DeleteMarkers once zero versions remain for this key
    // (otherwise deleting a latest DeleteMarker would un-hide a soft-deleted file!)
    if (remainingVersions === 0 && entry.deleteMarkers.length > 0) {
      for (const dm of entry.deleteMarkers) {
        if (budget.remaining <= 0) {
          stats.budgetExhausted = true;
          break;
        }
        const res = await b2DeleteVersion(env, encodedKey, dm.versionId, budget);
        if (res.budgetExceeded) {
          stats.budgetExhausted = true;
          break;
        }
        if (res.ok) {
          stats.sweepDeletedMarkers += 1;
        }
      }
    }
  }
}
