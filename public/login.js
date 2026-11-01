/* FileDrop login page */

const passInput = document.getElementById('pass');
const toggleBtn = document.getElementById('togglePass');
toggleBtn.addEventListener('click', () => {
  const show = passInput.type === 'password';
  passInput.type = show ? 'text' : 'password';
  document.getElementById('eyeShow').classList.toggle('hidden', show);
  document.getElementById('eyeHide').classList.toggle('hidden', !show);
  toggleBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  toggleBtn.setAttribute('aria-pressed', String(show));
  passInput.focus();
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('error');
  err.classList.add('hidden');
  const btn = e.currentTarget.querySelector('.btn.primary');
  btn.disabled = true; // also dims via .btn:disabled
  btn.classList.add('busy'); // spinner via .btn.busy::before
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user: document.getElementById('user').value,
        pass: document.getElementById('pass').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return (location.href = '/');
    err.textContent = data.error || 'Login failed';
    err.classList.remove('hidden');
  } catch {
    err.textContent = 'Network error — try again';
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
});
