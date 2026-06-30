import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import fs from 'node:fs';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { uploadDir } from './lib/upload.js';
import { healthRouter } from './routes/health.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { publicRouter } from './routes/public.routes.js';
import { pagesRouter } from './routes/admin/pages.routes.js';
import { categoriesRouter } from './routes/admin/categories.routes.js';
import { stepsRouter } from './routes/admin/steps.routes.js';
import { mediaRouter } from './routes/admin/media.routes.js';
import { usersRouter } from './routes/admin/users.routes.js';
import { analyticsRouter } from './routes/admin/analytics.routes.js';
import { aiPipelineRouter } from './routes/admin/ai-pipeline.routes.js';
import { mcpAdminRouter } from './routes/admin/mcp-admin.routes.js';
import { exportsRouter } from './routes/admin/exports.routes.js';
import { mcpRouter } from './routes/mcp.routes.js';
import { connectorRouter } from './routes/connector.routes.js';
import { buildLoaderJs } from './services/widget/loader.js';
import { getWidgetConfig } from './services/widget/config.js';
import { connectRouter } from './routes/admin/connect.routes.js';
import { authenticate } from './middleware/auth.middleware.js';
import { notFoundHandler } from './middleware/not-found.js';
import { errorHandler } from './middleware/error-handler.js';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Manage frame-ancestors ourselves (per-path) so the /embed widget can be
  // framed by client sites while everything else stays clickjacking-protected.
  app.use(helmet({ frameguard: false, contentSecurityPolicy: false }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/embed' || req.path.startsWith('/embed/')) {
      // Allow configured host apps to embed the help panel in an iframe.
      res.setHeader('Content-Security-Policy', `frame-ancestors ${env.embedAllowedOrigins}`);
      res.removeHeader('X-Frame-Options');
    } else {
      // Block framing of the admin/help app itself.
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    }
    next();
  });

  const allowedOrigins = env.corsOrigin.split(',').map((o) => o.trim());
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin (curl, server-to-server, same-origin) or an allowed app origin.
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        // Browser-extension connector runs from a chrome-extension://… origin.
        if (/^(chrome-extension|moz-extension):\/\//.test(origin)) {
          callback(null, true);
          return;
        }
        // Disallowed origin: respond WITHOUT CORS headers rather than throwing
        // (throwing here surfaces as a generic 500 for every such request).
        callback(null, false);
      },
      credentials: true,
    }),
  );

  // ── Browser-extension connector bridge ──────────────────────────────────
  // Mounted before the global 1mb parser with a larger limit: command results
  // carry base64 screenshots. Token-gated internally (connector bearer token).
  app.use('/connector', express.json({ limit: '25mb' }), connectorRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Serve uploaded media files — override CORP so cross-origin pages (e.g. localhost:4200) can load images
  app.use(
    '/uploads',
    (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      next();
    },
    express.static(path.resolve(uploadDir)),
  );

  // ── Angular SPA (production) / dev redirect ──────────────────────────────
  // Only when the built SPA is actually colocated (single-image deploy). When the
  // frontend is deployed as a separate app (e.g. Coolify), this dir is absent and
  // the backend serves the API only — unmatched GETs fall through to the 404 handler.
  const angularDist = path.resolve('..', 'frontend', 'dist', 'help-assistant-ui', 'browser');
  const spaAvailable = fs.existsSync(path.join(angularDist, 'index.html'));
  if (env.isProduction && spaAvailable) {
    app.use(express.static(angularDist));
  } else if (!env.isProduction) {
    const frontendOrigin = env.corsOrigin.split(',')[0]?.trim() ?? 'http://localhost:4200';
    app.get('/', (_req: Request, res: Response) => {
      res.redirect(frontendOrigin);
    });
  }

  // Request logging
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info('request', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Math.round(ms),
      });
    });
    next();
  });

  // ── Health (unauthenticated) ─────────────────────────────────────────────
  app.use('/api', healthRouter);

  // ── Auth (unauthenticated) ───────────────────────────────────────────────
  app.use('/api/admin/auth', authRouter);

  // ── Public API (unauthenticated) ─────────────────────────────────────────
  app.use('/api/public', publicRouter);

  // ── Embeddable widget loader (public script include) ─────────────────────
  app.get('/widget.js', async (_req: Request, res: Response) => {
    const base = env.corsOrigin.split(',')[0]?.trim() || env.publicBaseUrl;
    const cfg = await getWidgetConfig();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(buildLoaderJs({ base, ...cfg }));
  });

  // Demo host page — embeds the widget so the install can be verified end-to-end
  // and every launcher/animation/icon option can be previewed live. The chosen
  // options arrive as query params and are baked server-side into the <script>
  // tag (so document.currentScript reads them reliably).
  app.get('/embed-demo', async (req: Request, res: Response) => {
    const base = env.corsOrigin.split(',')[0]?.trim() || env.publicBaseUrl;
    const cfg = await getWidgetConfig();
    const pick = (key: string, allowed: string[], def: string): string => {
      const v = String((req.query[key] as string | undefined) ?? '');
      return allowed.includes(v) ? v : def;
    };
    // Query params let you preview any combo live; otherwise fall back to the
    // admin's saved config so the demo reflects the latest Save.
    const launcher = pick('launcher', ['fab', 'tab', 'pill'], cfg.launcher);
    const iconName = pick('icon', ['question', 'chat', 'book', 'bulb', 'info', 'none'], cfg.icon);
    const animation = pick('animation', ['slide', 'slide-side', 'scale', 'fade', 'none'], cfg.animation);
    const position = pick('position', ['right', 'left'], cfg.position);

    const sel = (a: string, b: string) => (a === b ? ' selected' : '');
    const opt = (
      id: string,
      cur: string,
      items: Array<[string, string]>,
    ): string =>
      `<select id="${id}" onchange="applyCfg()">` +
      items.map(([v, l]) => `<option value="${v}"${sel(cur, v)}>${l}</option>`).join('') +
      `</select>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta charset="utf-8"/><title>Help widget demo</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;margin:0;padding:40px;background:var(--bg);color:var(--fg);transition:background .2s,color .2s}
body[data-mode="dark"]{--bg:#0f1115;--fg:#e5e7eb;--muted:#9aa4b2;--card:#161a20;--border:#2b323c;--code-bg:#1f242c;--code-fg:#7dd3c0}
body[data-mode="light"]{--bg:#f5f7fa;--fg:#16202b;--muted:#5b6573;--card:#ffffff;--border:#d8dee6;--code-bg:#eef1f5;--code-fg:#0b7a6b}
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
h1{margin:0 0 6px}p{color:var(--muted)}
code{background:var(--code-bg);padding:2px 7px;border-radius:6px;color:var(--code-fg)}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}
button{padding:10px 14px;border:1px solid var(--border);border-radius:9px;background:var(--card);color:var(--fg);cursor:pointer;font:inherit}
button:hover{border-color:#2e6f6a}
.theme-toggle{display:inline-flex;align-items:center;gap:8px;font-weight:600}
.config{display:flex;gap:18px;flex-wrap:wrap;margin-top:26px;padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--card)}
.config label{display:flex;flex-direction:column;gap:5px;font-size:.78rem;font-weight:600;color:var(--muted)}
.config select{padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;cursor:pointer}
.section-label{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:24px 0 0}
</style></head>
<body data-mode="dark">
<div class="bar">
  <div>
    <h1>Embed widget demo</h1>
    <p>Simulated app route: <code id="route">/chat/conversation</code> — the launcher opens the manual for this route. Click a button to navigate; the panel follows.</p>
  </div>
  <button class="theme-toggle" id="themeBtn" onclick="toggleTheme()" aria-label="Toggle light/dark mode">
    <span id="themeIcon">🌙</span> <span id="themeLabel">Dark</span>
  </button>
</div>

<p class="section-label">Simulated routes</p>
<div class="btns">
  <button onclick="go('/chat/conversation')">/chat/conversation</button>
  <button onclick="go('/login')">/login</button>
  <button onclick="go('/admin/users')">/admin/users</button>
  <button onclick="go('/journey/workspace')">/journey/workspace</button>
  <button onclick="go('/nonexistent')">unknown screen</button>
</div>

<p class="section-label">Widget configuration <span style="text-transform:none;font-weight:400">(changing a value reloads the demo)</span></p>
<div class="config">
  <label>Launcher ${opt('cfgLauncher', launcher, [['fab', 'Round button'], ['tab', 'Side tab'], ['pill', 'Pill + text']])}</label>
  <label>Icon ${opt('cfgIcon', iconName, [['question', 'Question'], ['chat', 'Chat'], ['book', 'Manual'], ['bulb', 'Tips'], ['info', 'Info'], ['none', 'None']])}</label>
  <label>Open animation ${opt('cfgAnim', animation, [['slide', 'Slide up'], ['slide-side', 'Slide in'], ['scale', 'Pop'], ['fade', 'Fade'], ['none', 'None']])}</label>
  <label>Side ${opt('cfgPos', position, [['right', 'Right'], ['left', 'Left']])}</label>
</div>

<script>
function go(p){history.pushState({},'',p);document.getElementById('route').textContent=p;}
if(location.pathname!=='/chat/conversation' && location.pathname!=='/embed-demo')document.getElementById('route').textContent=location.pathname;
function applyTheme(m){
  document.body.setAttribute('data-mode',m);
  document.getElementById('themeIcon').textContent = m==='dark' ? '🌙' : '☀️';
  document.getElementById('themeLabel').textContent = m==='dark' ? 'Dark' : 'Light';
  if(window.haWidget && window.haWidget.setTheme) window.haWidget.setTheme(m);
}
function toggleTheme(){ applyTheme(document.body.getAttribute('data-mode')==='dark' ? 'light' : 'dark'); }
function applyCfg(){
  var q=new URLSearchParams();
  q.set('launcher',document.getElementById('cfgLauncher').value);
  q.set('icon',document.getElementById('cfgIcon').value);
  q.set('animation',document.getElementById('cfgAnim').value);
  q.set('position',document.getElementById('cfgPos').value);
  location.href='/embed-demo?'+q.toString();
}
</script>
<script src="/widget.js" data-base="${base}" data-position="${position}" data-color="${cfg.color}" data-theme="${cfg.theme}" data-launcher="${launcher}" data-icon="${iconName}" data-animation="${animation}" data-label="${cfg.label.replace(/"/g, '&quot;')}"></script>
<script>applyTheme(document.body.getAttribute('data-mode'));</script>
</body></html>`);
  });

  // ── MCP server (Claude-host transport; bearer connector token, NOT a JWT) ─
  // Mounted before the global authenticate — Claude hosts present the MCP
  // connector token, not an admin JWT.
  app.use('/mcp', mcpRouter);

  // ── AI Pipeline (self-authenticating: Bearer for JSON, ?token= for SSE) ──
  // Mounted before the global authenticate so the EventSource stream can
  // authenticate via query param (EventSource cannot set headers).
  app.use('/api/admin/ai-pipeline', aiPipelineRouter);

  // ── Admin API (JWT required for all routes below) ────────────────────────
  app.use('/api/admin', authenticate);
  app.use('/api/admin/pages/:pageId/steps', stepsRouter);
  app.use('/api/admin/pages', pagesRouter);
  app.use('/api/admin/categories', categoriesRouter);
  app.use('/api/admin/connect', connectRouter);
  app.use('/api/admin/media', mediaRouter);
  app.use('/api/admin/users', usersRouter);
  app.use('/api/admin/analytics', analyticsRouter);
  app.use('/api/admin/mcp', mcpAdminRouter);
  app.use('/api/admin/exports', exportsRouter);

  // SPA fallback in production — serve index.html for any unmatched non-API GET.
  // Express 5 / path-to-regexp v8 rejects a bare '*' route, so use middleware
  // (and let API/upload/asset misses fall through to the JSON 404 handler).
  if (env.isProduction && spaAvailable) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
        return next();
      }
      res.sendFile(path.join(angularDist, 'index.html'));
    });
  }

  // 404 + error handler — always last
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
