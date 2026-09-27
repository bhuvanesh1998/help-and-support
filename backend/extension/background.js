/**
 * HelpAssistant Connector — background service worker.
 * ─────────────────────────────────────────────────────────────────────────────
 * Bridges the operator's real, logged-in browser tab to the HelpAssistant
 * backend over CDP (chrome.debugger). It registers a session, long-polls the
 * backend for commands (driven by Claude via MCP), executes them against the
 * attached tab, and posts results back. It also streams the tab's live API
 * calls (XHR/fetch) so each screen's endpoints can be documented.
 *
 * No automatic activity: it only attaches/captures while the operator has
 * pressed Connect in the popup, and detaches on Disconnect or tab close.
 */

const PROTOCOL = '1.3';
const API_BUFFER_MAX = 200;
const ASSET_RE = /\.(json|js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)(\?|$)/i;
const NON_API_HOST = /(google|gstatic|doubleclick|facebook|fbcdn|analytics|segment|sentry|hotjar|clarity|recaptcha|googletagmanager|jsdelivr|cloudflareinsights|fonts\.)/i;

/** Live, in-memory session state (re-hydrated from storage if the SW restarts). */
let state = { connected: false, backendUrl: '', token: '', sessionId: '', tabId: null };
let apiBuffer = [];
const reqMeta = new Map(); // CDP requestId → { method, url, postData }
let polling = false;

// ── Config persistence ───────────────────────────────────────────────────────
async function loadState() {
  const s = await chrome.storage.local.get('connState');
  if (s.connState) state = { ...state, ...s.connState };
}
async function saveState() {
  await chrome.storage.local.set({ connState: state });
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` };
}

async function api(path, body) {
  const res = await fetch(`${state.backendUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ── Connect / disconnect ───────────────────────────────────────────────────────
async function connect({ backendUrl, token, tabId }) {
  await disconnect(); // clean slate
  state.backendUrl = backendUrl.replace(/\/+$/, '');
  state.token = token;
  state.tabId = tabId;

  const tab = await chrome.tabs.get(tabId);
  const { sessionId } = await api('/connector/register', { label: tab.title || tab.url || 'browser' });
  state.sessionId = sessionId;

  await chrome.debugger.attach({ tabId }, PROTOCOL);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}).catch(() => {});

  state.connected = true;
  await saveState();
  notify();
  pollLoop();
  flushLoop();
  return { sessionId };
}

async function disconnect() {
  const wasConnected = state.connected;
  state.connected = false;
  if (state.tabId != null) {
    try { await chrome.debugger.detach({ tabId: state.tabId }); } catch { /* not attached */ }
  }
  if (wasConnected && state.sessionId) {
    try { await api('/connector/disconnect', { sessionId: state.sessionId }); } catch { /* offline */ }
  }
  state.sessionId = '';
  state.tabId = null;
  apiBuffer = [];
  reqMeta.clear();
  await saveState();
  notify();
}

function notify() {
  chrome.runtime.sendMessage({ type: 'state', state: publicState() }).catch(() => {});
}
function publicState() {
  return { connected: state.connected, backendUrl: state.backendUrl, sessionId: state.sessionId, tabId: state.tabId };
}

// ── Command long-poll loop ──────────────────────────────────────────────────────
async function pollLoop() {
  if (polling) return;
  polling = true;
  while (state.connected) {
    try {
      const tab = state.tabId != null ? await chrome.tabs.get(state.tabId).catch(() => null) : null;
      const url = tab?.url ? `&url=${encodeURIComponent(tab.url)}` : '';
      const resp = await api(`/connector/poll?sessionId=${state.sessionId}${url}`);
      if (resp.expired) {
        // Server dropped our session (TTL / restart) — re-register and keep going.
        const reg = await api('/connector/register', { label: tab?.title || tab?.url || 'browser' });
        state.sessionId = reg.sessionId;
        await saveState();
        notify();
        continue;
      }
      const command = resp.command;
      if (command) {
        const result = await runCommand(command).catch((e) => ({ __error: e.message || String(e) }));
        await api('/connector/result', {
          commandId: command.id,
          ok: !result?.__error,
          data: result?.__error ? undefined : result,
          error: result?.__error,
        });
      }
    } catch (e) {
      // Backend unreachable / token revoked → back off, then re-check connected.
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  polling = false;
}

// Periodically push buffered API calls so the backend has live endpoint data.
async function flushLoop() {
  while (state.connected) {
    await new Promise((r) => setTimeout(r, 5000));
    if (!apiBuffer.length) continue;
    const calls = apiBuffer.splice(0, apiBuffer.length);
    const tab = state.tabId != null ? await chrome.tabs.get(state.tabId).catch(() => null) : null;
    try {
      await api('/connector/events', { sessionId: state.sessionId, url: tab?.url, apiCalls: calls });
    } catch { apiBuffer.unshift(...calls); /* retry next tick */ }
  }
}

// ── Command handlers (run over CDP against the attached tab) ─────────────────────
async function runCommand(cmd) {
  const tabId = state.tabId;
  if (tabId == null) throw new Error('no attached tab');

  switch (cmd.action) {
    case 'ping':
      return { ok: true };

    case 'captureScreen': {
      // Let the screen's data finish loading before we highlight + capture
      // (dashboards/reports fetch async). Clamped to 30s.
      const waitMs = Math.min(Math.max(Number(cmd.params?.waitMs) || 0, 0), 30000);
      if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
      const hl = cmd.params && cmd.params.highlight;
      let highlighted = false;
      if (hl) {
        highlighted = !!(await evaluate(tabId, haHighlight, [hl.selector ?? null, hl.text ?? null, hl.placeholder ?? null, hl.label ?? null]).catch(() => false));
        await new Promise((r) => setTimeout(r, 350)); // let scroll + overlay settle
      }
      const shot = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        fromSurface: true,
      });
      if (hl) await evaluate(tabId, haUnhighlight, []).catch(() => {});
      const tab = await chrome.tabs.get(tabId);
      return {
        screenshotBase64: shot?.data ?? null,
        url: tab.url ?? null,
        title: tab.title ?? null,
        apiCalls: apiBuffer.slice(-60),
        highlighted,
      };
    }

    case 'navigate': {
      const target = String(cmd.params?.url ?? '');
      if (!target) throw new Error('navigate needs a url');
      const abs = target.startsWith('http') ? target : new URL(target, (await chrome.tabs.get(tabId)).url).href;
      await chrome.tabs.update(tabId, { url: abs });
      await waitForLoad(tabId);
      const tab = await chrome.tabs.get(tabId);
      return { url: tab.url, title: tab.title };
    }

    case 'click': {
      // Prefer a REAL trusted click via CDP at the element's coordinates —
      // Angular menu handlers ignore synthetic JS events (isTrusted:false).
      const center = await evaluate(tabId, haCenter, [cmd.params?.selector ?? null, cmd.params?.text ?? null]).catch(() => null);
      let clicked = false;
      if (center && typeof center.x === 'number') {
        const base = { x: center.x, y: center.y, button: 'left', clickCount: 1 };
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y }).catch(() => {});
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base }).catch(() => {});
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }).catch(() => {});
        clicked = true;
      } else {
        clicked = !!(await evaluate(tabId, clickFn, [cmd.params?.selector ?? null, cmd.params?.text ?? null]).catch(() => false));
      }
      await new Promise((res) => setTimeout(res, 1000));
      const tab = await chrome.tabs.get(tabId);
      return { clicked, url: tab.url, title: tab.title };
    }

    case 'type': {
      const r = await evaluate(tabId, typeFn, [cmd.params?.selector ?? null, String(cmd.params?.text ?? '')]);
      return { typed: r };
    }

    default:
      throw new Error(`unknown action: ${cmd.action}`);
  }
}

async function waitForLoad(tabId, timeout = 12000) {
  const start = Date.now();
  // Poll the tab status until 'complete' (Page.loadEventFired is racy across navigations).
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && tab.status === 'complete') break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 1200)); // settle SPA render
}

/** Run a function (serialised) in the page via CDP Runtime.evaluate. */
async function evaluate(tabId, fn, args) {
  const expr = `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`;
  const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || 'evaluate failed');
  return res?.result?.value;
}

// These run in the page context (stringified). Keep them dependency-free.
function clickFn(selector, text) {
  let el = null;
  if (selector) el = document.querySelector(selector);
  if (!el && text) {
    const t = text.trim().toLowerCase();
    const nodes = Array.from(document.querySelectorAll('a,button,[role="button"],[role="tab"],[role="menuitem"],div,span,li'));
    el = nodes.find((n) => (n.textContent || '').trim().toLowerCase() === t)
      || nodes.find((n) => { const x = (n.textContent || '').trim().toLowerCase(); return x.length < 40 && x.indexOf(t) >= 0; });
  }
  if (!el) return false;
  // Climb to the nearest actionable ancestor so framework (Angular) click
  // handlers fire — clicking a bare inner <span> often doesn't toggle a menu.
  var actionable = el.closest('button,a,[role="button"],[role="tab"],[role="menuitem"],li') || el;
  actionable.scrollIntoView({ block: 'center' });
  var opts = { bubbles: true, cancelable: true, view: window };
  actionable.dispatchEvent(new MouseEvent('mousedown', opts));
  actionable.dispatchEvent(new MouseEvent('mouseup', opts));
  actionable.dispatchEvent(new MouseEvent('click', opts));
  if (typeof actionable.click === 'function') actionable.click();
  return true;
}
function typeFn(selector, value) {
  const el = selector ? document.querySelector(selector) : document.activeElement;
  if (!el) return false;
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// Draw a red highlight box (+ optional label) around an element, matched by CSS
// selector, input placeholder, or visible text. Runs in the page via evaluate().
function haHighlight(selector, text, placeholder, label) {
  var old = document.getElementById('__ha_hl_box'); if (old) old.remove();
  var oldL = document.getElementById('__ha_hl_label'); if (oldL) oldL.remove();
  var el = null;
  if (selector) { try { el = document.querySelector(selector); } catch (e) {} }
  if (!el && placeholder) {
    el = Array.prototype.find.call(document.querySelectorAll('input,textarea'), function (i) {
      return (i.placeholder || '').toLowerCase().indexOf(String(placeholder).toLowerCase()) >= 0;
    });
  }
  if (!el && text) {
    var t = String(text).trim().toLowerCase();
    var nodes = Array.prototype.slice.call(document.querySelectorAll('button,a,[role="button"],[role="tab"],label,span,div,th,h1,h2,h3,p'));
    el = nodes.find(function (n) { return (n.textContent || '').trim().toLowerCase() === t; })
      || nodes.find(function (n) { var x = (n.textContent || '').trim().toLowerCase(); return x.length < 60 && x.indexOf(t) >= 0; });
  }
  if (!el) return false;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  var r = el.getBoundingClientRect();
  var box = document.createElement('div');
  box.id = '__ha_hl_box';
  box.style.cssText = 'position:fixed;z-index:2147483646;border:3px solid #e5392f;border-radius:6px;box-shadow:0 0 0 9999px rgba(17,17,17,0.18);pointer-events:none;left:' + (r.left - 5) + 'px;top:' + (r.top - 5) + 'px;width:' + (r.width + 10) + 'px;height:' + (r.height + 10) + 'px;';
  document.body.appendChild(box);
  if (label) {
    var lab = document.createElement('div');
    lab.id = '__ha_hl_label';
    lab.textContent = label;
    var top = r.top - 32; if (top < 4) top = r.bottom + 8;
    lab.style.cssText = 'position:fixed;z-index:2147483647;background:#e5392f;color:#fff;font:600 12px system-ui,sans-serif;padding:4px 9px;border-radius:5px;pointer-events:none;white-space:nowrap;left:' + Math.max(4, r.left - 5) + 'px;top:' + top + 'px;';
    document.body.appendChild(lab);
  }
  return true;
}

function haUnhighlight() {
  var b = document.getElementById('__ha_hl_box'); if (b) b.remove();
  var l = document.getElementById('__ha_hl_label'); if (l) l.remove();
  return true;
}

// Resolve an element (by selector or visible text), scroll it into view, and
// return its viewport-center coordinates for a trusted CDP Input click.
function haCenter(selector, text) {
  var el = null;
  if (selector) { try { el = document.querySelector(selector); } catch (e) {} }
  if (!el && text) {
    var t = String(text).trim().toLowerCase();
    var nodes = Array.prototype.slice.call(document.querySelectorAll('a,button,[role="button"],[role="tab"],[role="menuitem"],div,span,li'));
    el = nodes.find(function (n) { return (n.textContent || '').trim().toLowerCase() === t; })
      || nodes.find(function (n) { var x = (n.textContent || '').trim().toLowerCase(); return x.length < 40 && x.indexOf(t) >= 0; });
  }
  if (!el) return null;
  var a = el.closest('button,a,[role="button"],[role="tab"],[role="menuitem"],li') || el;
  a.scrollIntoView({ block: 'center', inline: 'center' });
  var r = a.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return {
    x: Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1),
    y: Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1),
  };
}

// ── Network capture (CDP events) ─────────────────────────────────────────────────
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!state.connected || source.tabId !== state.tabId) return;

  if (method === 'Network.requestWillBeSent') {
    reqMeta.set(params.requestId, {
      method: params.request.method,
      url: params.request.url,
      postData: params.request.postData ?? null,
      type: params.type,
    });
  } else if (method === 'Network.responseReceived') {
    const meta = reqMeta.get(params.requestId) || {};
    meta.status = params.response.status;
    meta.contentType = params.response.headers?.['content-type'] || params.response.mimeType || null;
    meta.type = params.type || meta.type;
    reqMeta.set(params.requestId, meta);
  } else if (method === 'Network.loadingFinished') {
    const meta = reqMeta.get(params.requestId);
    reqMeta.delete(params.requestId);
    if (!meta || !meta.url) return;
    if (meta.type !== 'XHR' && meta.type !== 'Fetch') return;

    let u;
    try { u = new URL(meta.url); } catch { return; }
    if (NON_API_HOST.test(u.host)) return;
    if (/^\/assets\//i.test(u.pathname) || ASSET_RE.test(u.pathname)) return;

    let responseSample = null;
    if (meta.contentType && /json|text/i.test(meta.contentType) && (meta.status ?? 0) < 400) {
      try {
        const body = await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Network.getResponseBody', {
          requestId: params.requestId,
        });
        if (body?.body) {
          const raw = body.base64Encoded ? atob(body.body) : body.body;
          responseSample = raw.length > 2000 ? raw.slice(0, 2000) + '…' : raw;
        }
      } catch { /* body gone */ }
    }

    pushApiCall({
      method: meta.method || 'GET',
      path: u.pathname,
      query: u.search ? u.search.replace(/^\?/, '') : null,
      host: u.host,
      requestBody: meta.postData ? String(meta.postData).slice(0, 2000) : null,
      status: meta.status ?? null,
      contentType: meta.contentType,
      responseSample,
    });
  }
});

/** Mask obvious PII (emails, long digit runs) in captured bodies before they leave the browser. */
function redactPII(s) {
  if (!s) return s;
  return String(s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b\d{7,}\b/g, '[number]');
}

function pushApiCall(call) {
  call.responseSample = redactPII(call.responseSample);
  call.requestBody = redactPII(call.requestBody);
  const key = `${call.method} ${call.host}${call.path}`;
  if (apiBuffer.some((c) => `${c.method} ${c.host}${c.path}` === key)) return; // dedupe
  apiBuffer.push(call);
  if (apiBuffer.length > API_BUFFER_MAX) apiBuffer.shift();
}

// Detach cleanly if the operator closes the captured tab or detaches DevTools.
chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === state.tabId) disconnect(); });
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === state.tabId && state.connected) disconnect();
});

// ── Popup messaging ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      await loadState();
      if (msg.type === 'getState') return sendResponse({ state: publicState() });
      if (msg.type === 'connect') return sendResponse(await connect(msg.payload));
      if (msg.type === 'disconnect') { await disconnect(); return sendResponse({ ok: true }); }
      sendResponse({ error: 'unknown message' });
    } catch (e) {
      sendResponse({ error: e.message || String(e) });
    }
  })();
  return true; // async response
});

// Keep-alive backstop so the long-poll loop survives SW idling.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async () => {
  await loadState();
  if (state.connected && !polling) pollLoop();
});

// On service-worker (re)start, resume polling immediately if we were connected —
// combined with the server's expired→re-register, the session self-heals.
loadState().then(() => { if (state.connected && !polling) pollLoop(); });
