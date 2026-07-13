const fields = ['endpoint', 'apiKey'];
const statusEl = document.getElementById('status');
const lastEl = document.getElementById('last');

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? 'ok' : 'err';
  if (ok) setTimeout(() => (statusEl.textContent = ''), 4000);
}

async function refreshLast() {
  const { lastPush, lastCount } = await chrome.storage.local.get(['lastPush', 'lastCount']);
  lastEl.textContent = lastPush
    ? `Last push: ${new Date(lastPush).toLocaleString()} (${lastCount} gauges)`
    : 'No successful push yet.';
}

async function load() {
  const cfg = await chrome.storage.sync.get(fields);
  for (const f of fields) if (cfg[f] != null) document.getElementById(f).value = cfg[f];
  await refreshLast();
}

document.getElementById('save').addEventListener('click', async () => {
  const values = {};
  for (const f of fields) values[f] = document.getElementById(f).value.trim();
  await chrome.storage.sync.set(values);
  setStatus('Saved ✓', true);
});

document.getElementById('poll').addEventListener('click', () => {
  setStatus('Polling…', true);
  chrome.runtime.sendMessage({ type: 'poll-now' }, async (res) => {
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, false);
      return;
    }
    if (res?.ok) {
      setStatus(`Pushed ${res.samples} gauge(s) ✓`, true);
      await refreshLast();
    } else {
      setStatus(res?.error ?? 'Failed', false);
    }
  });
});

load();
