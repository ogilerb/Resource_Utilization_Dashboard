const fields = ['endpoint', 'apiKey', 'costPer1kIn', 'costPer1kOut'];

async function load() {
  const cfg = await chrome.storage.sync.get(fields);
  for (const f of fields) if (cfg[f] != null) document.getElementById(f).value = cfg[f];
}

document.getElementById('save').addEventListener('click', async () => {
  const values = {};
  for (const f of fields) values[f] = document.getElementById(f).value.trim();
  await chrome.storage.sync.set(values);
  const status = document.getElementById('status');
  status.textContent = 'Saved ✓';
  setTimeout(() => (status.textContent = ''), 1500);
});

load();
