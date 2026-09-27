const $ = (id) => document.getElementById(id);

function render(state) {
  const on = !!state?.connected;
  $('dot').classList.toggle('on', on);
  $('statusText').textContent = on ? 'Connected' : 'Disconnected';
  $('connect').disabled = on;
  $('disconnect').disabled = !on;
  $('meta').textContent = on && state.sessionId ? `session ${state.sessionId.slice(0, 8)}… · tab ${state.tabId}` : '';
}

function setErr(msg) { $('err').textContent = msg || ''; }

async function init() {
  const saved = await chrome.storage.local.get(['backendUrl', 'token']);
  $('url').value = saved.backendUrl || 'http://localhost:3000';
  $('token').value = saved.token || '';
  const { state } = await chrome.runtime.sendMessage({ type: 'getState' });
  render(state);
}

$('connect').addEventListener('click', async () => {
  setErr('');
  let backendUrl = $('url').value.trim();
  const token = $('token').value.trim();
  if (!backendUrl || !token) return setErr('Backend URL and token are required.');
  // Accept only the server origin — ignore any path (e.g. someone pastes the
  // app's /dashboard URL here), which would otherwise 404/405 the connector API.
  try {
    backendUrl = new URL(backendUrl).origin;
    $('url').value = backendUrl;
  } catch {
    return setErr('Backend URL must be a full URL, e.g. http://localhost:3000');
  }
  await chrome.storage.local.set({ backendUrl, token });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return setErr('No active tab.');
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
    return setErr('Open the target web app in this tab first (cannot attach to browser pages).');
  }

  $('connect').disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'connect', payload: { backendUrl, token, tabId: tab.id } });
  if (res?.error) { setErr(res.error); $('connect').disabled = false; return; }
  const { state } = await chrome.runtime.sendMessage({ type: 'getState' });
  render(state);
});

$('disconnect').addEventListener('click', async () => {
  setErr('');
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  const { state } = await chrome.runtime.sendMessage({ type: 'getState' });
  render(state);
});

// Live status updates pushed from the background worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'state') render(msg.state);
});

init();
