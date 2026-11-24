import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeObjectKey,
  encodeContentDisposition,
  encodeKeyPath,
  escapeHtml,
  extractFileIdFromRawKey,
  objectKey,
  parseListVersionsXml,
  sanitizeName,
} from '../src/lib.js';
import worker, {
  b2Delete,
  cleanupExpired,
  findLive,
  handleDeleteFile,
  handleLogin,
  handleShare,
  handleUploadFinalize,
} from '../src/index.js';

function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key, opts) {
      if (!store.has(key)) return null;
      const val = store.get(key);
      if (opts?.type === 'json') return JSON.parse(val);
      return val;
    },
    async put(key, val) {
      store.set(key, String(val));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function makeEnv(kvInitial = {}) {
  return {
    FILES: makeKv(kvInitial),
    ASSETS: {
      async fetch() {
        return new Response('<html>ok</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
    },
    B2_BUCKET: 'test-bucket',
    B2_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com/',
    B2_REGION: 'us-east-005',
    B2_KEY_ID: 'test-key-id',
    B2_APP_KEY: 'test-app-key',
    AUTH_USER: 'admin',
    AUTH_PASS: 'secret123',
  };
}

function withMockFetch(handler, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = orig;
    });
}

function listVersionsXml({ versions = [], deleteMarkers = [], isTruncated = false, nextKeyMarker = '', nextVersionIdMarker = '' }) {
  const escape = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const vXml = versions
    .map(
      (v) =>
        `<Version><Key>${escape(v.key)}</Key><VersionId>${escape(v.versionId)}</VersionId><IsLatest>${Boolean(v.isLatest)}</IsLatest>${
          v.lastModified ? `<LastModified>${v.lastModified}</LastModified>` : ''
        }</Version>`
    )
    .join('');
  const dmXml = deleteMarkers
    .map(
      (d) =>
        `<DeleteMarker><Key>${escape(d.key)}</Key><VersionId>${escape(d.versionId)}</VersionId><IsLatest>${Boolean(d.isLatest)}</IsLatest></DeleteMarker>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult><IsTruncated>${isTruncated}</IsTruncated>${
    nextKeyMarker ? `<NextKeyMarker>${escape(nextKeyMarker)}</NextKeyMarker>` : ''
  }${
    nextVersionIdMarker ? `<NextVersionIdMarker>${escape(nextVersionIdMarker)}</NextVersionIdMarker>` : ''
  }${vXml}${dmXml}</ListVersionsResult>`;
}

/* ----------------------------- pure lib tests ----------------------------- */

test('sanitizeName blocks path traversal, control chars, and is idempotent', () => {
  assert.equal(sanitizeName('.'), 'file');
  assert.equal(sanitizeName('..'), 'file');
  assert.equal(sanitizeName('   '), 'file');
  assert.equal(sanitizeName(''), 'file');
  assert.equal(sanitizeName('../etc/passwd'), '.._etc_passwd');
  assert.equal(sanitizeName('hello\x00world\x7f.txt'), 'hello_world_.txt');
  const longWithTrailingSpace = 'a'.repeat(179) + ' bbb';
  const once = sanitizeName(longWithTrailingSpace);
  assert.equal(once, sanitizeName(once));
  assert.ok(once.length <= 180);
});

test('objectKey / decodeObjectKey / encodeKeyPath round-trip special characters', () => {
  const id = '0123456789abcdef';
  const name = "photo (1) 50% 'test'!* café.png";
  const key = objectKey(id, name);
  assert.ok(!key.includes('(') && !key.includes(')') && !key.includes("'"));
  const raw = decodeObjectKey(key);
  assert.equal(raw, `files/${id}/${name}`);
  assert.equal(encodeKeyPath(raw), key);
  assert.equal(extractFileIdFromRawKey(raw), id);
  assert.equal(extractFileIdFromRawKey('other/0123456789abcdef/a.txt'), null);
});

test('encodeContentDisposition emits ASCII fallback and RFC 5987 UTF-8 filename*', () => {
  const cd = encodeContentDisposition("café (1) 'note'*.pdf");
  assert.match(cd, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
  assert.ok(!cd.split("filename*=UTF-8''")[1].includes('('));
  assert.ok(!cd.split("filename*=UTF-8''")[1].includes("'"));
  assert.ok(!cd.split("filename*=UTF-8''")[1].includes('*'));
});

test('parseListVersionsXml parses versions, delete markers, entities, and truncation', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <ListVersionsResult>
    <IsTruncated>true</IsTruncated>
    <NextKeyMarker>files/0123456789abcdef/a &amp; b.txt</NextKeyMarker>
    <NextVersionIdMarker>v2</NextVersionIdMarker>
    <Version>
      <Key>files/0123456789abcdef/a &amp; b &apos;1&apos;.txt</Key>
      <VersionId>v1</VersionId>
      <IsLatest>false</IsLatest>
      <LastModified>2026-11-01T00:00:00.000Z</LastModified>
    </Version>
    <DeleteMarker>
      <Key>files/0123456789abcdef/a &amp; b &apos;1&apos;.txt</Key>
      <VersionId>dm1</VersionId>
      <IsLatest>true</IsLatest>
    </DeleteMarker>
  </ListVersionsResult>`;
  const parsed = parseListVersionsXml(xml);
  assert.equal(parsed.isTruncated, true);
  assert.equal(parsed.nextKeyMarker, 'files/0123456789abcdef/a & b.txt');
  assert.equal(parsed.nextVersionIdMarker, 'v2');
  assert.equal(parsed.versions.length, 1);
  assert.equal(parsed.versions[0].key, "files/0123456789abcdef/a & b '1'.txt");
  assert.equal(parsed.versions[0].isLatest, false);
  assert.equal(parsed.deleteMarkers.length, 1);
  assert.equal(parsed.deleteMarkers[0].versionId, 'dm1');
});

test('escapeHtml escapes angle brackets and quotes', () => {
  assert.equal(escapeHtml(`<script>"&'</script>`), '&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;');
});

/* ----------------------- permanent B2 delete tests ------------------------ */

test('b2Delete permanently deletes all versions BEFORE delete markers via versionId', async () => {
  const env = makeEnv();
  const id = '0123456789abcdef';
  const key = objectKey(id, 'report (1).pdf');
  const rawKey = decodeObjectKey(key);
  const calls = [];

  await withMockFetch(
    async (req) => {
      const u = new URL(req.url);
      calls.push({ method: req.method, path: u.pathname, query: u.search });
      if (req.method === 'GET' && u.searchParams.has('versions')) {
        assert.equal(u.searchParams.get('prefix'), `files/${id}/`);
        return new Response(
          listVersionsXml({
            versions: [
              { key: rawKey, versionId: 'ver-old', isLatest: false },
              { key: `files/${id}/other.pdf`, versionId: 'ver-other', isLatest: true },
            ],
            deleteMarkers: [{ key: rawKey, versionId: 'dm-1', isLatest: true }],
          }),
          { status: 200 }
        );
      }
      if (req.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected call: ${req.method} ${req.url}`);
    },
    async () => {
      const ok = await b2Delete(env, key);
      assert.equal(ok, true);
    }
  );

  // 1 GET ?versions + 2 DELETEs (ver-old first, then dm-1; never ver-other)
  assert.equal(calls.length, 3);
  assert.equal(calls[1].method, 'DELETE');
  assert.ok(calls[1].query.includes('versionId=ver-old'));
  assert.equal(calls[2].method, 'DELETE');
  assert.ok(calls[2].query.includes('versionId=dm-1'));
});

test('b2Delete falls back to HEAD x-amz-version-id if ListObjectVersions returns 403', async () => {
  const env = makeEnv();
  const key = objectKey('0123456789abcdef', 'doc.txt');
  const calls = [];

  await withMockFetch(
    async (req) => {
      const u = new URL(req.url);
      calls.push({ method: req.method, query: u.search });
      if (req.method === 'GET' && u.searchParams.has('versions')) {
        return new Response('AccessDenied', { status: 403 });
      }
      if (req.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'x-amz-version-id': 'v-head-99' } });
      }
      if (req.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error('Unexpected');
    },
    async () => {
      assert.equal(await b2Delete(env, key), true);
    }
  );

  assert.equal(calls[2].method, 'DELETE');
  assert.ok(calls[2].query.includes('versionId=v-head-99'));
});

/* -------------------------- cron cleanup tests ---------------------------- */

test('cleanupExpired permanently deletes due del:, stale pending:, hidden versions, and orphans while preserving live files', async () => {
  const nowMs = Date.UTC(2026, 10, 24, 6, 0, 0);
  const nowSec = Math.floor(nowMs / 1000);

  const dueId = '1111111111111111';
  const futureId = '2222222222222222';
  const stalePendingId = '3333333333333333';
  const freshPendingId = '4444444444444444';
  const hiddenLegacyId = '5555555555555555';
  const orphanId = '6666666666666666';

  const dueKey = objectKey(dueId, 'expired.zip');
  const futureKey = objectKey(futureId, 'live.zip');
  const stalePendingKey = objectKey(stalePendingId, 'abandoned.bin');
  const freshPendingKey = objectKey(freshPendingId, 'uploading.bin');
  const hiddenLegacyRaw = `files/${hiddenLegacyId}/old-soft-deleted.pdf`;
  const orphanRaw = `files/${orphanId}/orphaned.bin`;

  const env = makeEnv({
    [`del:${nowSec - 60}:${dueId}`]: JSON.stringify({ key: dueKey }),
    [`file:${dueId}`]: JSON.stringify({ key: dueKey, name: 'expired.zip', expiresAt: nowMs - 60000 }),
    [`del:${nowSec + 3600}:${futureId}`]: JSON.stringify({ key: futureKey }),
    [`file:${futureId}`]: JSON.stringify({ key: futureKey, name: 'live.zip', expiresAt: nowMs + 3600000 }),
    'del:bad:corrupt': '{not-json',
    [`pending:${stalePendingId}`]: JSON.stringify({ key: stalePendingKey, at: nowSec - 8000 }),
    [`pending:${freshPendingId}`]: JSON.stringify({ key: freshPendingKey, at: nowSec - 300 }),
  });

  // In-memory mock B2 versioned bucket
  const b2Objects = [
    { type: 'Version', key: decodeObjectKey(dueKey), versionId: 'v-due', isLatest: true, lastModified: '2026-11-24T04:00:00.000Z' },
    { type: 'Version', key: decodeObjectKey(futureKey), versionId: 'v-live', isLatest: true, lastModified: '2026-11-24T04:00:00.000Z' },
    { type: 'Version', key: decodeObjectKey(stalePendingKey), versionId: 'v-stale', isLatest: true, lastModified: '2026-11-24T03:00:00.000Z' },
    { type: 'Version', key: decodeObjectKey(freshPendingKey), versionId: 'v-fresh', isLatest: true, lastModified: '2026-11-24T05:55:00.000Z' },
    // Previously soft-deleted file (noncurrent version + delete marker left over from old plain DELETE)
    { type: 'Version', key: hiddenLegacyRaw, versionId: 'v-hidden', isLatest: false, lastModified: '2026-11-20T00:00:00.000Z' },
    { type: 'DeleteMarker', key: hiddenLegacyRaw, versionId: 'dm-hidden', isLatest: true },
    // Orphaned file with no KV entry and LastModified > 2h ago
    { type: 'Version', key: orphanRaw, versionId: 'v-orphan', isLatest: true, lastModified: '2026-11-24T01:00:00.000Z' },
    // Unrelated non-FileDrop bucket object — must never be touched
    { type: 'Version', key: 'backups/keep.tar', versionId: 'v-keep', isLatest: true, lastModified: '2026-10-01T00:00:00.000Z' },
  ];

  await withMockFetch(
    async (req) => {
      const u = new URL(req.url);
      if (req.method === 'GET' && u.searchParams.has('versions')) {
        const prefix = u.searchParams.get('prefix') || '';
        const matching = b2Objects.filter((o) => o.key.startsWith(prefix));
        return new Response(
          listVersionsXml({
            versions: matching.filter((o) => o.type === 'Version'),
            deleteMarkers: matching.filter((o) => o.type === 'DeleteMarker'),
          }),
          { status: 200 }
        );
      }
      if (req.method === 'DELETE') {
        const vid = u.searchParams.get('versionId');
        assert.ok(vid, 'DELETE must always include versionId for permanent B2 deletion');
        const idx = b2Objects.findIndex((o) => o.versionId === vid);
        if (idx >= 0) b2Objects.splice(idx, 1);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected ${req.method} ${req.url}`);
    },
    async () => {
      const stats = await cleanupExpired(env, { nowMs });
      assert.equal(stats.delDeleted, 1);
      assert.equal(stats.pendingDeleted, 1);
      assert.equal(stats.sweepDeletedVersions, 2); // v-hidden + v-orphan
      assert.equal(stats.sweepDeletedMarkers, 1); // dm-hidden
    }
  );

  // Remaining B2 objects: ONLY live file, fresh pending upload, and unrelated bucket file
  assert.deepEqual(
    b2Objects.map((o) => o.versionId).sort(),
    ['v-fresh', 'v-keep', 'v-live']
  );
  // KV cleaned up: expired del:, expired file:, corrupt del:, stale pending: all gone
  assert.equal(env.FILES.store.has(`del:${nowSec - 60}:${dueId}`), false);
  assert.equal(env.FILES.store.has(`file:${dueId}`), false);
  assert.equal(env.FILES.store.has('del:bad:corrupt'), false);
  assert.equal(env.FILES.store.has(`pending:${stalePendingId}`), false);
  // Preserved KV keys
  assert.equal(env.FILES.store.has(`del:${nowSec + 3600}:${futureId}`), true);
  assert.equal(env.FILES.store.has(`file:${futureId}`), true);
  assert.equal(env.FILES.store.has(`pending:${freshPendingId}`), true);
});

test('cleanupExpired respects subrequest budget without burning retry counters', async () => {
  const nowMs = Date.UTC(2026, 10, 24, 6, 0, 0);
  const nowSec = Math.floor(nowMs / 1000);
  const id1 = 'aaaaaaaaaaaaaaaa';
  const id2 = 'bbbbbbbbbbbbbbbb';
  const env = makeEnv({
    [`del:${nowSec - 10}:${id1}`]: JSON.stringify({ key: objectKey(id1, 'one.txt') }),
    [`del:${nowSec - 10}:${id2}`]: JSON.stringify({ key: objectKey(id2, 'two.txt') }),
  });

  let fetchCount = 0;
  await withMockFetch(
    async (req) => {
      fetchCount += 1;
      const u = new URL(req.url);
      if (req.method === 'GET' && u.searchParams.has('versions')) {
        return new Response(
          listVersionsXml({
            versions: [{ key: `files/${id1}/one.txt`, versionId: 'v1', isLatest: true }],
          }),
          { status: 200 }
        );
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      const stats = await cleanupExpired(env, { nowMs, maxB2Requests: 2 });
      assert.equal(stats.delDeleted, 1);
      assert.equal(stats.budgetExhausted, true);
      assert.equal(fetchCount, 2);
    }
  );

  // Second item should remain untouched with no tries incremented
  const second = JSON.parse(env.FILES.store.get(`del:${nowSec - 10}:${id2}`));
  assert.equal(second.tries, undefined);
});

/* ------------------- dedupe, finalize, delete, auth tests ----------------- */

test('findLive matches exact SHA-256 and never falsely matches different content with same name+size', async () => {
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const id = '1234567890abcdef';
  const future = Date.now() + 3600_000;

  const env = makeEnv({
    [`file:${id}`]: JSON.stringify({
      key: objectKey(id, 'report.txt'),
      name: 'report.txt',
      size: 100,
      hash: hashA,
      expiresAt: future,
    }),
    [`dedupe:${hashA}`]: JSON.stringify({ id, expiresAt: future }),
    [`idmap:100:report.txt`]: JSON.stringify({ id, expiresAt: future }),
  });

  // Same hash -> exact duplicate
  const exact = await findLive(env, { hash: hashA, name: 'renamed.txt', size: 100 });
  assert.equal(exact?.match, 'exact');
  assert.equal(exact?.id, id);

  // Same name + size, DIFFERENT SHA-256 -> NOT a duplicate!
  const different = await findLive(env, { hash: hashB, name: 'report.txt', size: 100 });
  assert.equal(different, null);

  // No hash (file > 256 MB) -> falls back to name-size
  const fallback = await findLive(env, { hash: '', name: 'report.txt', size: 100 });
  assert.equal(fallback?.match, 'name-size');
  assert.equal(fallback?.id, id);
});

test('handleUploadFinalize stores dedupe hash, honors 0-byte content-length, and is idempotent', async () => {
  const id = 'abcdef0123456789';
  const hash = 'c'.repeat(64);
  const key = objectKey(id, 'empty.txt');
  const env = makeEnv({
    [`pending:${id}`]: JSON.stringify({ key, at: Math.floor(Date.now() / 1000) }),
  });

  await withMockFetch(
    async (req) => {
      assert.equal(req.method, 'HEAD');
      return new Response(null, {
        status: 200,
        headers: { 'content-length': '0', 'content-type': 'text/plain' },
      });
    },
    async () => {
      const req = new Request('https://example.com/api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          key,
          name: 'empty.txt',
          size: 9999, // fake client size — server must trust B2 content-length 0
          type: 'text/plain',
          hash,
          duration: 3600,
        }),
      });
      const res = await handleUploadFinalize(req, env, 'sid');
      assert.equal(res.status, 200);

      const meta = JSON.parse(env.FILES.store.get(`file:${id}`));
      assert.equal(meta.size, 0);
      assert.equal(meta.hash, hash);
      assert.ok(env.FILES.store.has(`dedupe:${hash}`));
      assert.equal(env.FILES.store.has(`pending:${id}`), false);

      // Calling finalize a second time with a different duration must NOT add a second del: key
      const req2 = new Request('https://example.com/api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, key, name: 'empty.txt', duration: 120 }),
      });
      const res2 = await handleUploadFinalize(req2, env, 'sid');
      assert.equal(res2.status, 200);
      const delKeys = [...env.FILES.store.keys()].filter((k) => k.startsWith('del:'));
      assert.equal(delKeys.length, 1);
    }
  );
});

test('handleDeleteFile recovers B2 key from del: even after file: expired and cleans dedupe/idmap', async () => {
  const id = '9999999999999999';
  const key = objectKey(id, 'gone.txt');
  const rawKey = decodeObjectKey(key);
  const env = makeEnv({
    // Note: file:<id> already evicted by KV TTL, only del: remains!
    [`del:1700000000:${id}`]: JSON.stringify({ key }),
  });

  let deletedVid = null;
  await withMockFetch(
    async (req) => {
      const u = new URL(req.url);
      if (req.method === 'GET' && u.searchParams.has('versions')) {
        return new Response(
          listVersionsXml({
            versions: [{ key: rawKey, versionId: 'v-expired-99', isLatest: true }],
          }),
          { status: 200 }
        );
      }
      if (req.method === 'DELETE') {
        deletedVid = u.searchParams.get('versionId');
        return new Response(null, { status: 204 });
      }
      throw new Error('Unexpected');
    },
    async () => {
      const res = await handleDeleteFile(new URL(`https://example.com/api/files/${id}`), env);
      assert.equal(res.status, 200);
    }
  );

  assert.equal(deletedVid, 'v-expired-99');
  assert.equal(env.FILES.store.has(`del:1700000000:${id}`), false);
});

test('auth guards HEAD / and GET /index.html, handles null JSON login, and supports HEAD + Range on /s/<id>', async () => {
  const env = makeEnv();

  // HEAD / without session -> 302 /login (fixes 200 bypass!)
  const headRoot = await worker.fetch(new Request('https://example.com/', { method: 'HEAD' }), env);
  assert.equal(headRoot.status, 302);
  assert.equal(headRoot.headers.get('location'), '/login');

  // GET /index.html without session -> 302 /login
  const getIndex = await worker.fetch(new Request('https://example.com/index.html', { method: 'GET' }), env);
  assert.equal(getIndex.status, 302);
  assert.equal(getIndex.headers.get('location'), '/login');

  // POST /api/login with JSON null -> 401 (never 500!)
  const nullLogin = await handleLogin(
    new Request('https://example.com/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    }),
    env
  );
  assert.equal(nullLogin.status, 401);

  // Valid login -> 200 with session cookie
  const okLogin = await handleLogin(
    new Request('https://example.com/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin', pass: 'secret123' }),
    }),
    env
  );
  assert.equal(okLogin.status, 200);
  assert.match(okLogin.headers.get('set-cookie') || '', /sid=[0-9a-f]{32};.*HttpOnly; Secure; SameSite=Strict/);

  // /s/<id> HEAD and Range GET
  const id = 'fedcba9876543210';
  env.FILES.store.set(
    `file:${id}`,
    JSON.stringify({
      key: objectKey(id, 'video (1).mp4'),
      name: 'video (1).mp4',
      size: 1000,
      type: 'video/mp4',
      expiresAt: Date.now() + 60_000,
    })
  );

  await withMockFetch(
    async (req) => {
      if (req.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-length': '1000', 'accept-ranges': 'bytes' },
        });
      }
      if (req.method === 'GET' && req.headers.get('range') === 'bytes=0-9') {
        return new Response('0123456789', {
          status: 206,
          headers: { 'content-length': '10', 'content-range': 'bytes 0-9/1000', 'accept-ranges': 'bytes' },
        });
      }
      return new Response('B2 down', { status: 503 });
    },
    async () => {
      const headShare = await handleShare(
        new Request(`https://example.com/s/${id}`, { method: 'HEAD' }),
        `/s/${id}`,
        env
      );
      assert.equal(headShare.status, 200);
      assert.equal(headShare.headers.get('content-length'), '1000');
      assert.match(headShare.headers.get('content-disposition') || '', /filename="video \(1\)\.mp4"/);

      const rangeShare = await handleShare(
        new Request(`https://example.com/s/${id}`, {
          method: 'GET',
          headers: { range: 'bytes=0-9' },
        }),
        `/s/${id}`,
        env
      );
      assert.equal(rangeShare.status, 206);
      assert.equal(rangeShare.headers.get('content-range'), 'bytes 0-9/1000');
      assert.equal(await rangeShare.text(), '0123456789');

      // Upstream 503 -> 502 (not misleading 404)
      const errShare = await handleShare(
        new Request(`https://example.com/s/${id}`, { method: 'GET' }),
        `/s/${id}`,
        env
      );
      assert.equal(errShare.status, 502);
    }
  );
});
