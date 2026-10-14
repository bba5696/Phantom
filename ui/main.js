const { invoke } = window.__TAURI__.core;
const { listen }  = window.__TAURI__.event;

let running = false;

const dot        = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const logInner   = document.getElementById('log-inner');
const btnLaunch  = document.getElementById('btn-launch');
const btnSave    = document.getElementById('btn-save');
const emailInput = document.getElementById('input-email');
const pwInput    = document.getElementById('input-password');

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function appendLog(msg, cls = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  line.innerHTML = `<span class="ts">${ts()}</span><span class="msg">${esc(msg)}</span>`;
  logInner.appendChild(line);
  logInner.parentElement.scrollTop = logInner.parentElement.scrollHeight;
}

function setStatus(label, state) {
  statusText.textContent = label;
  dot.className = state === 'idle' ? '' : state;
}

// Load saved credentials
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const [email, pw] = await invoke('get_creds');
    if (email) emailInput.value = email;
    if (pw)    pwInput.value    = pw;
  } catch {}
  appendLog('Phantom ready.', 'dim');
});

// Save credentials
btnSave.addEventListener('click', async () => {
  try {
    await invoke('save_creds', { email: emailInput.value.trim(), password: pwInput.value });
    appendLog('Credentials saved.', 'dim');
  } catch (e) {
    appendLog(`Save failed: ${e}`, 'error');
  }
});

// Launch / Stop
btnLaunch.addEventListener('click', async () => {
  if (!running) {
    const email = emailInput.value.trim();
    const pw    = pwInput.value;
    if (!email || !pw) { appendLog('Enter credentials first.', 'warn'); return; }
    try {
      await invoke('start', { email, password: pw });
      running = true;
      btnLaunch.textContent   = 'Stop';
      btnLaunch.dataset.state = 'running';
    } catch (e) {
      appendLog(`Error: ${e}`, 'error');
      setStatus('Error', 'error');
    }
  } else {
    try { await invoke('stop'); } catch {}
    running = false;
    btnLaunch.textContent   = 'Launch';
    btnLaunch.dataset.state = 'idle';
  }
});

// Rust → frontend events
listen('log',    e => appendLog(e.payload.msg, e.payload.color || 'info'));
listen('status', e => setStatus(e.payload.label, e.payload.state));
