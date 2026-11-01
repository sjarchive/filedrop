import { AwsClient } from 'aws4fetch';

const SESSION_TTL = 60 * 60 * 24 * 7;      // login session: 7 days
const UPLOAD_PRESIGN_TTL = 60 * 60;        // presigned upload URL: 1 hour
const MIN_EXPIRY = 60;                     // link must last at least 60 s
const MAX_EXPIRY = 60 * 60 * 24 * 90;      // ...and at most 90 days
const LOGIN_ATTEMPT_LIMIT = 10;            // per IP per hour (fixed window)
const PENDING_STALE_SEC = 2 * 60 * 60;     // init'd-but-never-finalized uploads: reaped after 2 h
const MAX_DELETE_RETRIES = 5;              // cron gives up on a B2 object after this many failures

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};
// static pages (index.html, login.html): scripts/styles all same-origin, no inline code
// connect-src must admit the B2 host: uploads PUT files straight to it from the browser
function assetCsp(env) {
  const b2 = env.B2_ENDPOINT ? new URL(env.B2_ENDPOINT).origin : '';
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

    try {
      // The app shell is protected: logged-out visitors are redirected before
      // it's served, so the UI never flashes for a split second before the
      // client-side /api/me check redirects them.
      if (path === '/' && request.method === 'GET') {
        const sid = await requireAuth(request, env);
        if (!sid) {
          return new Response(null, {
            status: 302,
            headers: { location: '/login', ...noStore, ...SEC_HEADERS },
          });
        }
      }

      if (path === '/api/login' && request.method === 'POST') return await handleLogin(request, env);
      if (path === '/api/logout' && request.method === 'POST') return await handleLogout(request, env);
      if (path === '/api/me' && request.method === 'GET') {
        const sid = await requireAuth(request, env);
        return sid ? json({ ok: true }) : json({ ok: false }, 401);
      }

      if (path === '/api/uploads/check' && request.method === 'POST') {
        return authGuard(request, env, () => handleDuplicateCheck(request, env));
      }
      if (path === '/api/uploads/init' && request.method === 'POST') {
        return authGuard(request, env, () => handleUploadInit(request, env));
      }
      if (path === '/api/files' && request.method === 'POST') {
        return authGuard(request, env, (s) => handleUploadFinalize(request, env, s));
      }
      if (path === '/api/files' && request.method === 'GET') {
        return authGuard(request, env, () => handleListFiles(env));
      }
      if (path.startsWith('/api/files/') && request.method === 'DELETE') {
        return authGuard(request, env, () => handleDeleteFile(url, env));
      }

      if (path.startsWith('/s/') && request.method === 'GET') return await handleShare(path, env);

      // Everything else is static assets (/, /login, css, js)
      const asset = await env.ASSETS.fetch(request);
      const res = new Response(asset.body, asset);
      for (const [k, v] of Object.entries(SEC_HEADERS)) res.headers.set(k, v);
      // force revalidation (ETag → 304) so browsers never run stale JS/CSS
      res.headers.set('cache-control', 'no-cache');
      if ((res.headers.get('content-type') || '').includes('text/html')) {
        res.headers.set('content-security-policy', assetCsp(env));
      }
      return res;
    } catch (err) {
      console.error(err);
      return json({ error: 'Internal error' }, 500);
    }
  },

  // Hourly: wipe expired files (and abandoned uploads) from B2 so storage doesn't fill up
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

function sanitizeName(name) {
  const s = typeof name === 'string' ? name : '';
  return (s || 'file')
    .replace(/[\x00-\x1f\\/#?"<>|:]/g, '_')
    .slice(0, 180) || 'file';
}

function objectKey(id, name) {
  return ['files', id, sanitizeName(name)].map(encodeURIComponent).join('/');
}

function b2Client(env) {
  return new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APP_KEY,
    service: 's3',
    region: env.B2_REGION,
  });
}

function b2Url(env, key) {
  return `${env.B2_ENDPOINT}/${env.B2_BUCKET}/${key}`;
}

// Delete a B2 object. Returns true on success or 404 (already gone).
async function b2Delete(env, key) {
  try {
    const resp = await b2Client(env).fetch(new Request(b2Url(env, key), { method: 'DELETE' }));
    if (resp.ok || resp.status === 404) return true;
    console.error('B2 delete failed', resp.status);
    return false;
  } catch (e) {
    console.error('B2 delete error', e);
    return false;
  }
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

async function handleLogin(request, env) {
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

  const body = await request.json().catch(() => ({}));
  const user = String(body.user ?? '');
  const pass = String(body.pass ?? '');

  // compare via digests so the check is constant-time-ish
  const [a, b, expectedUser, expectedPass] = await Promise.all([
    digest(user), digest(pass), digest(env.AUTH_USER), digest(env.AUTH_PASS),
  ]);

  if (a === expectedUser && b === expectedPass) {
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

async function digest(s) {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('');
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
//   1. exact: SHA-256 content hash (hashed by the browser; only clients that
//      can hash send it)
//   2. name-size fallback: catches browsers running a stale page or files too
//      big to hash (original filename + byte size must both match)
// Returns { match, id, name, expiresAt } or null. KV TTL deletion is lazy, so
// the file record itself is always re-checked ("live" = exists and unexpired).
async function findLive(env, { hash, name, size }) {
  const candidates = [];
  if (/^[0-9a-f]{64}$/.test(String(hash || ''))) {
    candidates.push({ match: 'exact', key: `dedupe:${hash}` });
  }
  if (name && size) {
    const s = Math.max(0, Math.floor(Number(size) || 0));
    if (s > 0) {
      candidates.push({
        match: 'name-size',
        key: `idmap:${s}:${sanitizeName(name)}`,
      });
    }
  }
  for (const c of candidates) {
    const hit = await env.FILES.get(c.key, { type: 'json' });
    if (!hit?.id) continue;
    const meta = await env.FILES.get(`file:${hit.id}`, { type: 'json' });
    if (!meta || (Number(meta.expiresAt) || 0) <= Date.now()) continue;
    return { match: c.match, id: hit.id, name: meta.name, expiresAt: meta.expiresAt };
  }
  return null;
}

// Pre-flight duplicate check so the UI can reject the file at drop time,
// before any upload starts.
async function handleDuplicateCheck(request, env) {
  const body = await request.json().catch(() => ({}));
  const found = await findLive(env, {
    hash: String(body?.hash || ''),
    name: body?.name,
    size: body?.size,
  });
  return json(
    found ? { ok: true, duplicate: true, ...found } : { ok: true, duplicate: false },
    200,
    noStore
  );
}

async function handleUploadInit(request, env) {
  const body = await request.json().catch(() => ({}));

  // Dedupe: if these same bytes (or the same name+size) are already shared and
  // still live, skip the upload and hand back the existing link.
  const found = await findLive(env, body || {});
  if (found) {
    return json({ ok: true, duplicate: true, ...found }, 200, noStore);
  }

  const id = genId();
  const key = objectKey(id, body?.name);
  const uploadUrl = await presign(env, 'PUT', key, UPLOAD_PRESIGN_TTL);
  // Tracks in-flight uploads so the hourly cron can reap ones that never finalize
  await env.FILES.put(`pending:${id}`, JSON.stringify({ key, at: Math.floor(Date.now() / 1000) }));
  return json({ ok: true, id, key, uploadUrl }, 200, noStore);
}

async function handleUploadFinalize(request, env, sid) {
  const body = await request.json().catch(() => {});
  const id = String(body?.id || '');
  if (!/^[0-9a-f]{16}$/.test(id)) return json({ error: 'Invalid upload' }, 400, noStore);

  // The key is server-owned: re-derive it from id + name instead of trusting
  // the client (a malformed key would break every later presign/delete URL)
  const name = sanitizeName(body?.name);
  const key = objectKey(id, name);
  if (body?.key !== key) return json({ error: 'Invalid upload' }, 400, noStore);

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
  let type = String(body.type || 'application/octet-stream').slice(0, 120);
  try {
    const resp = await b2Client(env).fetch(new Request(b2Url(env, key), { method: 'HEAD' }));
    if (resp.status === 404) {
      return json({ error: 'Upload not found in storage — please try again' }, 400, noStore);
    }
    if (resp.ok) {
      size = Number(resp.headers.get('content-length')) || size;
      type = (resp.headers.get('content-type') || type).slice(0, 120);
    }
  } catch (e) {
    console.error('B2 head error', e); // transient — keep client-supplied values
  }

  const meta = { key, name, size, type, createdAt: Date.now(), expiresAt: expiresAt * 1000 };
  // No grace buffer: KV TTL kills the entry at expiry and handleShare double-checks it
  const ttl = Math.max(60, expiresAt - nowSec);
  // Remember identities so a future upload of the same bytes (or of a file with
  // the same name and size — for clients that can't hash) reuses this link.
  // Entries die with the file's expiry, so links can never be resurrected.
  const hash = String(body?.hash || '');
  await Promise.all([
    env.FILES.put(`file:${id}`, JSON.stringify(meta), { expirationTtl: ttl }),
    env.FILES.put(`del:${expiresAt}:${id}`, JSON.stringify({ key })),
    env.FILES.delete(`pending:${id}`),
    env.FILES.put(
      `idmap:${size}:${name}`,
      JSON.stringify({ id, expiresAt: expiresAt * 1000 }),
      { expirationTtl: ttl }
    ),
    /^[0-9a-f]{64}$/.test(hash)
      ? env.FILES.put(
          `dedupe:${hash}`,
          JSON.stringify({ id, expiresAt: expiresAt * 1000 }),
          { expirationTtl: ttl }
        )
      : Promise.resolve(),
  ]);
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
      const meta = await env.FILES.get(k.name, { type: 'json' });
      if (!meta) return null; // expired or mid-write
      return { id: k.name.split(':')[1], ...meta };
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

// Remove every KV entry tied to a file id: its metadata, its pending marker,
// and ALL its scheduled B2 deletions (due or not — an explicit delete is explicit).
async function purgeKeys(env, id) {
  const keys = (await listKv(env, 'del:'))
    .filter((k) => k.name.endsWith(`:${id}`))
    .map((k) => k.name);
  keys.push(`file:${id}`, `pending:${id}`); // deleting missing keys is a no-op
  await Promise.all(keys.map((k) => env.FILES.delete(k)));
}

async function handleDeleteFile(url, env) {
  const id = url.pathname.split('/')[3];
  if (!/^[0-9a-f]{16}$/.test(id || '')) return json({ error: 'Bad id' }, 400);

  const nowSec = Math.floor(Date.now() / 1000);
  const meta = await env.FILES.get(`file:${id}`, { type: 'json' });

  await purgeKeys(env, id);

  if (meta?.key) {
    const deleted = await b2Delete(env, meta.key);
    if (!deleted) {
      // re-arm so the hourly cron keeps retrying (bounded by MAX_DELETE_RETRIES)
      await env.FILES.put(`del:${nowSec}:${id}`, JSON.stringify({ key: meta.key, tries: 1 }));
    }
  }
  return json({ ok: true }, 200, noStore);
}

/* --------------------------------- share ---------------------------------- */

// Share link: /s/<id> — 16 hex chars, short and self-contained. The token
// (64-bit random id) is the capability. The download is proxied through the
// Worker (streamed, not buffered) so visitors never see the long B2 presigned
// URL in their address bar.
async function handleShare(path, env) {
  const id = path.slice(3);
  if (!/^[0-9a-f]{16}$/.test(id)) return sharePage('Invalid link', 'This link is malformed.', 400);

  const meta = await env.FILES.get(`file:${id}`, { type: 'json' });
  // explicit expiry check: KV TTL deletion is lazy, don't give links a grace window
  if (!meta || (Number(meta.expiresAt) || 0) <= Date.now()) {
    return sharePage('Link expired', 'This link has expired or no longer exists.', 404);
  }

  // aws4fetch signs the request automatically; the body streams pass-through
  let upstream;
  try {
    upstream = await b2Client(env).fetch(new Request(b2Url(env, meta.key), { method: 'GET' }));
  } catch (e) {
    console.error('B2 download error', e);
    return sharePage('Error', 'Could not fetch a download link. Please try again.', 500);
  }
  if (!upstream.ok) {
    console.error('B2 get failed', upstream.status);
    return sharePage('Error', 'The file is no longer available in storage.', 404);
  }

  // decent filename for browsers that download instead of render
  const headers = { ...noStore, ...SEC_HEADERS };
  headers['content-type'] = meta.type || upstream.headers.get('content-type') || 'application/octet-stream';
  const len = upstream.headers.get('content-length');
  if (len) headers['content-length'] = len;
  headers['content-disposition'] =
    `attachment; filename*=UTF-8''${encodeURIComponent(meta.name || 'file')}`;
  return new Response(upstream.body, { status: 200, headers });
}

function sharePage(title, message, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0c12"><title>${title}</title>
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
/* rotating border glow — mirrors the main site: a custom property must be
   registered via @property or the keyframe on --glow-angle can't interpolate */
@property --glow-angle{syntax:'<angle>';initial-value:0deg;inherits:false}
.card::before{content:'';position:absolute;inset:-1px;border-radius:23.5px;padding:1.5px;background:conic-gradient(from var(--glow-angle),transparent 0 295deg,rgba(91,140,255,.85) 325deg,rgba(139,92,246,.95) 348deg,transparent 360deg);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;animation:spin 8s linear infinite}
@keyframes spin{to{--glow-angle:360deg}}
@keyframes pop{from{opacity:0;transform:translateY(16px) scale(.97)}}
h1{font-size:20px;margin:0 0 10px;letter-spacing:-.01em}
p{color:#98a0b3;margin:0;font-size:14px;line-height:1.5}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style></head>
<body><div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
<div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
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

async function cleanupExpired(env) {
  const nowSec = Math.floor(Date.now() / 1000);

  // 1. delete B2 objects whose share window has ended
  for (const k of await listKv(env, 'del:')) {
    const sec = Number(k.name.split(':')[1]);
    if (!Number.isFinite(sec) || sec > nowSec) continue;
    const info = await env.FILES.get(k.name, { type: 'json' });
    const deleted = info?.key ? await b2Delete(env, info.key) : true;
    if (deleted) {
      await env.FILES.delete(k.name);
    } else if ((info.tries || 0) + 1 >= MAX_DELETE_RETRIES) {
      console.error('cron: giving up on B2 delete for', k.name);
      await env.FILES.delete(k.name);
    } else {
      await env.FILES.put(k.name, JSON.stringify({ ...info, tries: (info.tries || 0) + 1 }));
    }
  }

  // 2. reap abandoned uploads: init was called but finalize never happened
  //    (presign TTL is 1 h, so anything older than PENDING_STALE_SEC is dead)
  for (const k of await listKv(env, 'pending:')) {
    const info = await env.FILES.get(k.name, { type: 'json' });
    if (!info || nowSec - info.at < PENDING_STALE_SEC) continue;
    const deleted = info.key ? await b2Delete(env, info.key) : true;
    if (deleted) await env.FILES.delete(k.name);
  }
}
