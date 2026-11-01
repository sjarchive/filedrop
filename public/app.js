/* FileDrop frontend */

const $ = (id) => document.getElementById(id);

let selectedFile = null;
let duplicateCheckSeq = 0; // ignores asynchronous duplicate checks on stale picks
let busy = false; // declared up front — updateCreateBtn() reads it

/* -------------------------------- auth ---------------------------------- */

(async () => {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) location.href = '/login';
  } catch {
    location.href = '/login';
  }
})();

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});

/* ------------------------------- upload UI ------------------------------- */

const dropzone = $('dropzone');
const fileInput = $('fileInput');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => e.key === 'Enter' && fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) selectFile(fileInput.files[0]);
  fileInput.value = ''; // allow re-selecting the same file after clearing
});

['dragover', 'dragenter'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  })
);
dropzone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
});
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) selectFile(file);
});

function selectFile(file) {
  hideError(); // a new pick supersedes any earlier "duplicate" rejection
  selectedFile = file;
  $('fileName').textContent = file.name;
  $('fileSize').textContent = fmtSize(file.size);
  $('fileRow').classList.remove('hidden');
  dropzone.classList.add('hidden');
  hideResult();
  updateCreateBtn();
  void rejectIfDuplicate(file); // fires async; rejections undo the selection
}

// Pre-flight: if these exact bytes — or a file with the same name and size —
// are already shared with a live link, reject the file immediately, before any
// upload is ever started.
async function rejectIfDuplicate(file) {
  const seq = ++duplicateCheckSeq;
  const hash = await fileHash(file);
  // bail if the user picked another file (or cleared) while we were hashing
  if (seq !== duplicateCheckSeq || selectedFile !== file) return;
  try {
    const res = await fetch('/api/uploads/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash, name: file.name, size: file.size }),
    });
    if (res.status === 401) {
      location.href = '/login';
      return;
    }
    const data = await res.json().catch(() => null);
    if (seq !== duplicateCheckSeq || selectedFile !== file) return; // stale race
    if (data?.duplicate) {
      const how =
        data.match === 'name-size'
          ? 'A file with the same name and size'
          : 'This exact file';
      resetSelection();
      showError(
        `${how} is already uploaded and its link is still active — ` +
          `no need to share it again: ${location.origin}/s/${data.id}`
      );
    }
  } catch {
    // network hiccup → skip the pre-check; /api/uploads/init still dedupes
  }
}

function resetSelection() {
  selectedFile = null;
  fileInput.value = '';
  $('fileRow').classList.add('hidden');
  dropzone.classList.remove('hidden');
  updateCreateBtn();
  hideResult();
}

$('clearFile').addEventListener('click', resetSelection);

/* -------------------------------- expiry --------------------------------- */

$('expiry').addEventListener('change', () => {
  const custom = $('expiry').value === 'custom';
  $('expiryCustom').classList.toggle('hidden', !custom);
  if (custom) {
    const min = new Date(Date.now() + 60 * 2 * 1000); // 2 min from now
    const max = new Date(Date.now() + 90 * 24 * 3600 * 1000);
    const el = $('expiryCustom');
    el.min = toLocalInput(min);
    el.max = toLocalInput(max);
  }
  updateCreateBtn();
});

$('expiryCustom').addEventListener('change', updateCreateBtn);

/* ---- themed dropdown: visual listbox wired to the hidden #expiry ---- */
(() => {
  const trigger = $('expiryTrigger');
  const label = $('expiryTriggerText');
  const menu = $('expiryMenu');
  const select = $('expiry');
  const items = [...menu.querySelectorAll('[role="option"]')];
  let open = false;

  const setOpen = (o) => {
    open = o;
    trigger.setAttribute('aria-expanded', String(o));
    menu.setAttribute('aria-hidden', String(!o));
    menu.classList.toggle('open', o);
    trigger.closest('.dropdown').classList.toggle('open', o);
    if (o) menu.querySelector('[aria-selected="true"]')?.focus();
  };

  const choose = (item, refocus) => {
    if (!item) return;
    items.forEach((i) => i.setAttribute('aria-selected', String(i === item)));
    label.textContent = item.textContent;
    if (select.value !== item.dataset.value) {
      select.value = item.dataset.value;
      select.dispatchEvent(new Event('change')); // existing expiry wiring reacts
    }
    setOpen(false);
    if (refocus) trigger.focus();
  };

  // sync the visible label with the actual (hidden) select value
  const initial = items.find((i) => i.dataset.value === select.value) || items[0];
  items.forEach((i) => i.setAttribute('aria-selected', String(i === initial)));
  label.textContent = initial.textContent;

  trigger.addEventListener('click', () => setOpen(!open));

  trigger.addEventListener('keydown', (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setOpen(true);
    }
  });

  menu.addEventListener('keydown', (e) => {
    const current = document.activeElement;
    const idx = items.indexOf(current);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next =
        e.key === 'ArrowDown'
          ? items[Math.min(idx + 1, items.length - 1)] || items[0]
          : items[Math.max(idx - 1, 0)] || items[items.length - 1];
      next?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(current, true);
    } else if (e.key === 'Escape') {
      setOpen(false);
      trigger.focus();
    } else if (e.key === 'Tab') {
      setOpen(false); // let focus move on naturally
    }
  });

  items.forEach((item) => {
    item.addEventListener('click', () => choose(item, false));
    item.addEventListener('keydown', (e) => {
      // type-ahead: jump to the first item starting with the pressed letter
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = items.find(
          (i) =>
            i !== item &&
            i.textContent.toLowerCase().startsWith(e.key.toLowerCase())
        );
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    });
  });

  // close when clicking anywhere outside the dropdown
  document.addEventListener('pointerdown', (e) => {
    if (open && !e.target.closest('#expiryDropdown')) setOpen(false);
  });
})();

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const hashCache = new WeakMap(); // File → its SHA-256 (or null when unhashable)

async function fileHash(file) {
  if (hashCache.has(file)) return hashCache.get(file);
  const hash = await computeHash(file);
  hashCache.set(file, hash);
  return hash;
}

// SHA-256 of the file bytes (hex). Returns null when the client can't or won't
// hash — uploads then proceed normally with no dedupe. Only files up to
// 256 MB are hashed so arrayBuffer() memory spikes stay reasonable.
async function computeHash(file) {
  try {
    if (!file || !crypto?.subtle || file.size > 256 * 1024 * 1024) return null;
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null; // hashing is an optimization, never a blocker
  }
}

// Presets are sent as a duration so the server counts expiry from when the
// upload finishes; custom dates are sent as an absolute timestamp.
function getExpiryPayload() {
  const v = $('expiry').value;
  if (v === 'custom') {
    if (!$('expiryCustom').value) return null;
    return { expiresAt: new Date($('expiryCustom').value).getTime() };
  }
  return { duration: Number(v) };
}

function isExpiryPassed(payload) {
  return (
    payload.expiresAt !== undefined &&
    payload.expiresAt < Date.now() + 60 * 1000 // server demands ≥ 1 min ahead
  );
}

function updateCreateBtn() {
  const customOk = $('expiry').value !== 'custom' || !!$('expiryCustom').value;
  $('createBtn').disabled = !(selectedFile && customOk && !busy);
  $('createBtn').classList.toggle('busy', busy); // spinner while uploading
}

/* --------------------------------- flow ---------------------------------- */

$('createBtn').addEventListener('click', uploadSelected);

async function uploadSelected() {
  if (!selectedFile || busy) return;
  const file = selectedFile;
  busy = true;
  hideError();
  hideResult();
  updateCreateBtn();

  try {
    const expiry = getExpiryPayload();
    if (!expiry || isExpiryPassed(expiry)) {
      throw new Error('Pick an expiry at least 1 minute in the future');
    }

    // hash the bytes (native SHA-256) so the worker can spot a re-upload of
    // identical content. Memory would spike on huge files, so only hash ≤ 256 MB.
    const hash = await fileHash(file);

    // 1. ask worker for a presigned B2 upload URL — or, if these exact bytes
    //    are already shared and unexpired, get the previous link straight back
    const init = await api('/api/uploads/init', {
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      hash,
    });

    if (init.duplicate) {
      showProgress(1, 'Already uploaded — reusing your previous link');
      resetSelection();
      $('resultLink').value = `${location.origin}/s/${init.id}`;
      $('resultNote').classList.remove('hidden');
      $('result').classList.remove('hidden');
      refreshList();
      return;
    }

    // 2. upload directly to B2 with progress
    await xhrUpload(init.uploadUrl, file);

    // 3. register file + expiry with the worker — but don't bother if a custom
    //    expiry died during a long upload (server would reject; the cron
    //    reaps the orphaned object)
    if (isExpiryPassed(expiry)) {
      throw new Error('Custom expiry passed during upload — please start over');
    }
    await api('/api/files', {
      id: init.id,
      key: init.key,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      ...expiry,
    });

    const link = `${location.origin}/s/${init.id}`;
    resetSelection(); // clears the selection without touching the result below
    $('resultLink').value = link;
    $('resultNote').classList.add('hidden');
    $('result').classList.remove('hidden');
    refreshList();
  } catch (e) {
    showError(e.message || 'Upload failed');
  } finally {
    busy = false;
    hideProgress();
    updateCreateBtn();
  }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login'; // session expired mid-use
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const UPLOAD_STALL_MS = 60 * 1000; // no progress for 60 s → give up

function xhrUpload(url, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let lastActivity = Date.now();

    const done = (fn, arg) => {
      clearInterval(stallTimer);
      if (!settled) {
        settled = true;
        fn(arg);
      }
    };

    // abort on a stalled connection instead of hanging forever
    const stallTimer = setInterval(() => {
      if (Date.now() - lastActivity > UPLOAD_STALL_MS) {
        xhr.abort();
        done(reject, new Error('Upload stalled — no progress for 60 s'));
      }
    }, 5000);

    xhr.open('PUT', url);
    showProgress(0);
    xhr.upload.onprogress = (e) => {
      lastActivity = Date.now();
      if (e.lengthComputable) showProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        showProgress(1, 'Finalizing…');
        done(resolve);
      } else {
        done(reject, new Error(`Upload to storage failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => done(reject, new Error('Upload to storage failed (network error)'));
    xhr.onabort = () => done(reject, new Error('Upload canceled'));
    xhr.send(file);
  });
}

/* --------------------------------- lists ---------------------------------- */

let listSig = '';   // skip DOM rebuilds when nothing visible changed
let loaded = false; // initial skeletons only

function renderSkeletons(count = 3) {
  const body = $('filesBody');
  body.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const sk = document.createElement('div');
    sk.className = 'file-item skel';
    sk.style.setProperty('--i', i);
    sk.innerHTML =
      '<div class="fi-main"><span class="sk-bar sk-a"></span><span class="sk-bar sk-b"></span></div>' +
      '<div class="sk-actions"><span class="sk-bar sk-c"></span><span class="sk-bar sk-c"></span></div>';
    body.append(sk);
  }
  $('filesEmpty').classList.add('hidden');
  $('filesTable').classList.remove('hidden');
}

async function refreshList() {
  try {
    const res = await fetch('/api/files');
    if (res.status === 401) {
      location.href = '/login';
      return;
    }
    if (!res.ok) return;
    const files = await res.json();
    loaded = true;

    // signature = structural data + minute-precision countdown, so labels stay
    // fresh while unchanged lists keep their hover/scroll state untouched
    const sig = JSON.stringify(
      files.map((f) => [f.id, f.name, f.size, Math.ceil((f.expiresAt - Date.now()) / 60000)])
    );
    if (sig === listSig) return;
    listSig = sig;

    const body = $('filesBody');
    body.innerHTML = '';

    if (!files.length) {
      $('filesEmpty').textContent = 'Nothing shared yet.';
      $('filesEmpty').classList.remove('hidden');
      $('filesTable').classList.add('hidden');
      return;
    }
    $('filesEmpty').classList.add('hidden');
    $('filesTable').classList.remove('hidden');

    files.forEach((f, i) => body.append(buildRow(f, i)));
  } catch {
    if (!loaded) {
      $('filesBody').innerHTML = '';
      $('filesTable').classList.add('hidden');
      const empty = $('filesEmpty');
      empty.textContent = 'Couldn’t load files — retrying soon.';
      empty.classList.remove('hidden');
    }
  }
}

function buildRow(f, i) {
  const item = document.createElement('div');
  item.className = 'file-item';
  item.style.setProperty('--i', Math.min(i, 8)); // cap stagger delay

  const main = document.createElement('div');
  main.className = 'fi-main';

  const name = document.createElement('span');
  name.className = 'fi-name';
  name.textContent = f.name;
  name.title = f.name;

  const meta = document.createElement('span');
  meta.className = 'fi-meta';

  const size = document.createElement('span');
  size.className = 'fi-size';
  size.textContent = fmtSize(f.size);

  const expired = f.expiresAt <= Date.now();
  const exp = document.createElement('span');
  exp.className = expired ? 'fi-exp expired' : 'fi-exp';
  exp.textContent = expired ? 'expired' : `in ${fmtRemaining(f.expiresAt - Date.now())}`;

  meta.append(size, exp);
  main.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'fi-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn ghost sm';
  copyBtn.textContent = 'Copy link';
  copyBtn.addEventListener('click', () =>
    copyText(`${location.origin}/s/${f.id}`, copyBtn, 'Copy link')
  );

  const openBtn = document.createElement('button');
  openBtn.className = 'btn ghost sm';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', () =>
    window.open(`${location.origin}/s/${f.id}`, '_blank')
  );

  const delBtn = document.createElement('button');
  delBtn.className = 'btn danger sm';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete "${f.name}" and its share link?`)) return;
    const res = await fetch(`/api/files/${f.id}`, { method: 'DELETE' }).catch(() => null);
    if (res && res.status === 401) {
      location.href = '/login';
      return;
    }
    refreshList();
  });

  actions.append(copyBtn, openBtn, delBtn);
  item.append(main, actions);
  return item;
}

renderSkeletons(); // shimmer while the first fetch is in flight
refreshList();
setInterval(refreshList, 60 * 1000); // keep expiry status fresh

/* -------------------------------- helpers --------------------------------- */

async function copyText(text, btn, label) {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  if (!ok) {
    // clipboard API needs a secure context — fall back for http/older browsers
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
  }
  btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
  setTimeout(() => (btn.textContent = label), 1200);
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtRemaining(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''}`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''}`;
}

function showProgress(frac, text) {
  $('progressWrap').classList.remove('hidden');
  $('progressBar').style.width = `${Math.round(frac * 100)}%`;
  $('progressText').textContent = text || `Uploading… ${Math.round(frac * 100)}%`;
}

function hideProgress() {
  $('progressWrap').classList.add('hidden');
}

function hideResult() {
  $('result').classList.add('hidden');
  $('resultLink').value = '';
  $('resultNote').classList.add('hidden');
}

function showError(msg) {
  const el = $('errorBox');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError() {
  $('errorBox').classList.add('hidden');
}

$('copyLink').addEventListener('click', () =>
  copyText($('resultLink').value, $('copyLink'), 'Copy')
);

$('viewLink').addEventListener('click', () => {
  const link = $('resultLink').value;
  if (link) window.open(link, '_blank');
});
