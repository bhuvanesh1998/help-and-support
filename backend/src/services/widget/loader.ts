/**
 * loader.ts — Builds the embeddable widget loader script (served at /widget.js).
 * ───────────────────────────────────────────────────────────────────────────
 * A host app adds one <script> tag; this loader injects a floating launcher and
 * an iframe panel pointing at our /embed page, keeping the panel in sync with
 * the host's current route (incl. SPA navigation) so it always shows the manual
 * for the screen the user is on.
 *
 * Configurable via data-* attributes on the <script> tag:
 *   data-base       Origin that serves the /embed panel (default: this server).
 *   data-position   'right' | 'left'                     (default: right)
 *   data-color      Accent colour, any hex               (default: #2e6f6a)
 *   data-theme      'auto' | 'light' | 'dark'            (default: auto)
 *   data-launcher   'fab' | 'tab' | 'pill'               (default: fab)
 *   data-icon       'question'|'chat'|'book'|'bulb'|'info'|'none' (default: question)
 *   data-label      Launcher text (tab/pill)             (default: contextual)
 *   data-animation  'slide'|'slide-side'|'scale'|'fade'|'none' (default: slide)
 *
 * Runtime API (for a host app's own controls):
 *   window.haWidget.open() / .close() / .toggle()
 *   window.haWidget.setTheme('light' | 'dark' | 'auto')
 */

export interface LoaderDefaults {
  base: string;
  position: string;
  color: string;
  launcher: string;
  icon: string;
  label: string;
  animation: string;
  theme: string;
}

export function buildLoaderJs(defaults: LoaderDefaults): string {
  return `(function () {
  if (window.__haWidgetLoaded) return;
  window.__haWidgetLoaded = true;

  // Server-saved defaults (Connect screen). A host's data-* attribute overrides.
  var cfg = ${JSON.stringify(defaults)};
  var s = document.currentScript;
  function attr(n, d) { var v = s && s.getAttribute(n); return (v === null || v === undefined || v === '') ? d : v; }
  function oneOf(v, allowed, d) { for (var i = 0; i < allowed.length; i++) if (allowed[i] === v) return v; return d; }

  var base = attr('data-base', cfg.base).replace(/\\/+$/, '');
  var pos = attr('data-position', cfg.position) === 'left' ? 'left' : 'right';
  var color = attr('data-color', cfg.color);
  var launcher = oneOf(attr('data-launcher', cfg.launcher), ['fab', 'tab', 'pill'], 'fab');
  var iconName = oneOf(attr('data-icon', cfg.icon), ['question', 'chat', 'book', 'bulb', 'info', 'none'], 'question');
  var label = attr('data-label', cfg.label);
  var anim = oneOf(attr('data-animation', cfg.animation), ['slide', 'slide-side', 'scale', 'fade', 'none'], 'slide');
  var themePref = oneOf(attr('data-theme', cfg.theme), ['auto', 'light', 'dark'], 'auto');
  var z = 2147483000;

  function sideCss() { return pos === 'left' ? 'left:20px;' : 'right:20px;'; }
  function hostMode() {
    if (themePref === 'light' || themePref === 'dark') return themePref;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  function routeUrl() {
    return base + '/embed?r=' + encodeURIComponent(location.pathname + location.search)
      + '&c=' + encodeURIComponent(color) + '&t=' + encodeURIComponent(hostMode());
  }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // Legible text colour (black/white) for the chosen accent.
  function onColor(hex) {
    var m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return '#fff';
    var h = m[1]; if (h.length === 3) h = h.replace(/(.)/g, '$1$1');
    function ch(i) { return parseInt(h.substr(i, 2), 16) / 255; }
    function lin(x) { return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
    var lum = 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4));
    return lum > 0.5 ? '#1a202c' : '#fff';
  }
  var fg = onColor(color);

  function icon(name, size) {
    var sw = 'stroke="' + fg + '"', fl = 'fill="' + fg + '"';
    var o = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" style="flex:none">';
    switch (name) {
      case 'none': return '';
      case 'chat': return o + '<path d="M4 5h16v11H8l-4 4V5z" ' + sw + ' stroke-width="1.8" stroke-linejoin="round"/></svg>';
      case 'book': return o + '<path d="M12 6c-2-1.2-4.6-1.2-6.6 0v11c2-1.2 4.6-1.2 6.6 0 2-1.2 4.6-1.2 6.6 0V6c-2-1.2-4.6-1.2-6.6 0v11" ' + sw + ' stroke-width="1.6" stroke-linejoin="round"/></svg>';
      case 'bulb': return o + '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11v2h6v-2A6 6 0 0 0 12 3z" ' + sw + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      case 'info': return o + '<circle cx="12" cy="12" r="9" ' + sw + ' stroke-width="1.7"/><path d="M12 11v5" ' + sw + ' stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="7.5" r="1.15" ' + fl + '/></svg>';
      default: return o + '<path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4" ' + sw + ' stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.5" r="1.2" ' + fl + '/></svg>';
    }
  }

  // ── Launcher ──────────────────────────────────────────────────────────────
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', label || 'Help');
  var shadow = 'box-shadow:0 6px 20px rgba(0,0,0,.25);';
  var common = 'position:fixed;z-index:' + z + ';border:none;cursor:pointer;background:' + color + ';color:' + fg + ';' + shadow + 'transition:filter .15s,transform .15s;';
  if (launcher === 'tab') {
    btn.style.cssText = common + 'top:50%;transform:translateY(-50%);' + (pos === 'left' ? 'left:0;' : 'right:0;')
      + (pos === 'left' ? 'border-radius:0 12px 12px 0;' : 'border-radius:12px 0 0 12px;')
      + 'padding:14px 7px;display:flex;flex-direction:column;align-items:center;gap:8px;writing-mode:vertical-rl;font:600 13px/1 system-ui,Segoe UI,sans-serif;letter-spacing:.2px;';
    btn.innerHTML = icon(iconName, 18) + (label ? '<span style="writing-mode:vertical-rl">' + esc(label) + '</span>' : '');
  } else if (launcher === 'pill') {
    btn.style.cssText = common + 'bottom:20px;' + sideCss() + 'border-radius:999px;padding:12px 18px;display:flex;align-items:center;gap:9px;font:600 14px system-ui,Segoe UI,sans-serif;';
    btn.innerHTML = icon(iconName, 20) + (label ? '<span>' + esc(label) + '</span>' : '');
  } else {
    btn.style.cssText = common + 'bottom:20px;' + sideCss() + 'width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;';
    btn.innerHTML = icon(iconName, 26) || icon('question', 26);
  }
  btn.addEventListener('mouseenter', function () { btn.style.filter = 'brightness(1.07)'; });
  btn.addEventListener('mouseleave', function () { btn.style.filter = ''; });

  // ── Panel iframe (with open/close animation) ────────────────────────────────
  function hiddenTransform() {
    if (anim === 'fade') return 'none';
    if (anim === 'scale') return 'scale(.92)';
    if (anim === 'slide-side') return pos === 'left' ? 'translateX(-26px)' : 'translateX(26px)';
    return 'translateY(16px)';
  }
  var dur = anim === 'none' ? '0s' : '.26s';
  var frame = document.createElement('iframe');
  frame.title = 'Help';
  frame.style.cssText = 'position:fixed;bottom:88px;' + sideCss() + 'z-index:' + z
    + ';width:460px;max-width:calc(100vw - 32px);height:86vh;max-height:880px;border:none;border-radius:16px;'
    + 'box-shadow:0 14px 50px rgba(0,0,0,.32);background:#fff;display:none;opacity:0;pointer-events:none;'
    + 'transform:' + hiddenTransform() + ';transform-origin:' + (pos === 'left' ? 'left bottom' : 'right bottom')
    + ';transition:opacity ' + dur + ' ease, transform ' + dur + ' ease;';
  frame.src = routeUrl();

  var open = false, hideTimer = null;
  function postRoute() { try { frame.contentWindow.postMessage({ ha: true, type: 'route', path: location.pathname + location.search }, '*'); } catch (e) {} }
  function postTheme() { try { frame.contentWindow.postMessage({ ha: true, type: 'theme', mode: hostMode() }, '*'); } catch (e) {} }
  function showFrame() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    frame.style.display = 'block';
    void frame.offsetWidth; // force reflow so the transition runs from the hidden state
    frame.style.opacity = '1';
    frame.style.transform = 'none';
    frame.style.pointerEvents = 'auto';
  }
  function hideFrame() {
    frame.style.opacity = '0';
    frame.style.transform = hiddenTransform();
    frame.style.pointerEvents = 'none';
    if (anim === 'none') { frame.style.display = 'none'; return; }
    hideTimer = setTimeout(function () { frame.style.display = 'none'; }, 300);
  }
  function setOpen(v) {
    open = v;
    // Hide the launcher while open — otherwise the always-on-top button overlaps
    // the panel's footer. The panel's own ✕ posts {ha,type:'close'} to re-show it.
    if (open) { showFrame(); btn.style.display = 'none'; postRoute(); postTheme(); }
    else { hideFrame(); btn.style.display = 'flex'; }
  }
  btn.addEventListener('click', function () { setOpen(!open); });

  function mount() {
    var root = document.body || document.documentElement;
    root.appendChild(btn);
    root.appendChild(frame);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // Public API for a host app's own controls (theme toggle, custom launcher, …).
  window.haWidget = {
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    toggle: function () { setOpen(!open); },
    setTheme: function (m) { themePref = (m === 'light' || m === 'dark' || m === 'auto') ? m : themePref; postTheme(); }
  };

  // Keep the panel in sync with host SPA navigation.
  var _push = history.pushState;
  history.pushState = function () { _push.apply(this, arguments); setTimeout(postRoute, 60); };
  var _rep = history.replaceState;
  history.replaceState = function () { _rep.apply(this, arguments); setTimeout(postRoute, 60); };
  window.addEventListener('popstate', function () { setTimeout(postRoute, 60); });

  // Follow host OS light/dark changes live when in auto mode.
  if (window.matchMedia) {
    try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (themePref === 'auto') postTheme(); }); } catch (e) {}
  }

  // Messages from the panel.
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.ha) return;
    if (d.type === 'close') setOpen(false);
    if (d.type === 'ready') { postRoute(); postTheme(); }
  });
})();
`;
}
