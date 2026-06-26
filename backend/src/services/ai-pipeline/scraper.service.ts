/// <reference lib="dom" />
/**
 * scraper.service.ts — Phase 1: Screen Discovery (backend, parameterized)
 * ────────────────────────────────────────────────────────────────────────
 * Ported from the standalone CLI scraper. Drives a headless Chromium session
 * against the target app, discovers distinct UI states, captures a screenshot
 * + DOM metadata for each, and reports progress through callbacks so the
 * caller can stream live updates to the client.
 *
 * No filesystem coupling: screenshots are handed to the injected `saveScreenshot`
 * so the job manager decides where/whether to persist them (as media assets).
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { ApiCall, CapturedScreen, ScreenDom, ScreenGroup, SessionInjection } from './types.js';

export interface ScraperContext {
  baseUrl: string;
  appName: string;
  email: string;
  password: string;
  navDepth: number;
  /** Launch a visible (headed) browser so a human can solve a captcha / finish login by hand. */
  headed?: boolean;
  /** When headed, how long to wait for the human to complete login, in ms (default 180000). */
  manualTimeoutMs?: number;
  /** Pre-authenticated session to inject (skips login + captcha entirely). */
  session?: SessionInjection;
  /** Persist a screenshot; returns its public URL + media id (or nulls on failure). */
  saveScreenshot: (
    buffer: Buffer,
    screenId: string,
    name: string,
  ) => Promise<{ imageUrl: string | null; mediaId: string | null }>;
  onScreen: (screen: CapturedScreen) => void;
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  signal: AbortSignal;
}

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 900;

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

function normalizeUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.origin !== new URL(base).origin) return null;
    return u.pathname;
  } catch {
    return null;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Escape a string for safe inclusion in a RegExp (route segments → click selectors). */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Live API-call capture ───────────────────────────────────────────────────────
// We record the real XHR/fetch traffic each screen makes so it can be documented
// in the "API" tab. Calls are collected per page and read back in captureScreen.

const apiCallsByPage = new WeakMap<Page, ApiCall[]>();

/** Third-party hosts that are never the app's own API (analytics, fonts, captcha…). */
const NON_API_HOST =
  /(google|gstatic|doubleclick|facebook|fbcdn|analytics|segment|sentry|hotjar|clarity|recaptcha|googletagmanager|jsdelivr|cloudflareinsights|fonts\.)/i;

/** Attach a response listener that records the app's API calls made on this page. */
function trackApiCalls(ctx: ScraperContext, page: Page): void {
  const calls: ApiCall[] = [];
  apiCallsByPage.set(page, calls);

  let baseHost = '';
  try {
    baseHost = new URL(ctx.baseUrl).host;
  } catch {
    /* ignore */
  }
  const seen = new Set<string>();

  page.on('response', (resp) => {
    void (async () => {
      try {
        const req = resp.request();
        const rt = req.resourceType();
        if (rt !== 'xhr' && rt !== 'fetch') return;

        const u = new URL(req.url());
        if (NON_API_HOST.test(u.host)) return;

        // Skip static assets / bundled config — they are not API endpoints even
        // though the SPA fetches them via XHR (e.g. /assets/app-config.json).
        const isStaticAsset =
          /^\/assets\//i.test(u.pathname) ||
          /\.(json|js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i.test(u.pathname);
        if (isStaticAsset) return;

        // Keep calls that are the app's own backend: same host, an api.* host,
        // or a path that looks like an API (/api, /e/, /v1, /graphql, …).
        const looksLikeApi =
          u.host === baseHost ||
          u.host.startsWith('api.') ||
          /\/(api|e|v\d+|graphql|rest)(\/|$)/i.test(u.pathname);
        if (!looksLikeApi) return;

        const key = `${req.method()} ${u.host}${u.pathname}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (calls.length >= 60) return; // safety cap per screen

        const contentType = resp.headers()['content-type'] ?? null;
        let responseSample: string | null = null;
        if (contentType && /json|text/i.test(contentType) && resp.status() < 400) {
          responseSample = await resp
            .text()
            .then((t) => (t.length > 2000 ? `${t.slice(0, 2000)}…` : t))
            .catch(() => null);
        }

        const post = req.postData();
        calls.push({
          method: req.method(),
          path: u.pathname,
          query: u.search ? u.search.replace(/^\?/, '') : null,
          host: u.host === baseHost ? null : u.host,
          requestBody: post ? (post.length > 2000 ? `${post.slice(0, 2000)}…` : post) : null,
          status: resp.status(),
          contentType,
          responseSample,
        });
      } catch {
        /* a response may be gone if the page navigated/closed — best effort */
      }
    })();
  });
}

/** Create a page with API-call tracking already attached. */
async function newTrackedPage(ctx: ScraperContext, context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  trackApiCalls(ctx, page);
  return page;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Job cancelled');
}

function nextId(screens: CapturedScreen[]): string {
  return String(screens.length + 1).padStart(3, '0');
}

// ── DOM extraction ──────────────────────────────────────────────────────────

async function extractDom(page: Page): Promise<ScreenDom> {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title.trim(),
    heading: (
      document.querySelector('h1,h2,[class*="title"],[class*="heading"]')?.textContent ?? ''
    )
      .trim()
      .slice(0, 80),
    inputs: Array.from(document.querySelectorAll('input:not([type="hidden"])'))
      .map((el) => {
        const i = el as HTMLInputElement;
        return {
          type: i.type || 'text',
          id: i.id,
          name: i.name,
          placeholder: i.placeholder,
          label: (document.querySelector(`label[for="${i.id}"]`)?.textContent ?? '').trim(),
        };
      })
      .slice(0, 12),
    buttons: Array.from(document.querySelectorAll('button,[role="button"]'))
      .map((b) => ({
        id: (b as HTMLElement).id,
        text: (b.textContent ?? '').trim().slice(0, 60),
        class: (b.className ?? '').toString().slice(0, 80),
      }))
      .filter((b) => b.text)
      .slice(0, 12),
    links: Array.from(document.querySelectorAll('a[href]'))
      .map((a) => {
        const link = a as HTMLAnchorElement;
        return {
          text: (link.textContent ?? '').trim().slice(0, 60),
          href: link.href,
          class: (link.className ?? '').toString().slice(0, 60),
        };
      })
      .filter((l) => l.text && l.href && !l.href.startsWith('javascript'))
      .slice(0, 20),
    navLinks: Array.from(
      document.querySelectorAll(
        'nav a, [role="navigation"] a, [class*="sidebar"] a, [class*="sidenav"] a, [class*="nav-item"], [class*="menu-item"]',
      ),
    )
      .map((a) => {
        const link = a as HTMLAnchorElement;
        return {
          text: (link.textContent ?? '').trim().slice(0, 60),
          href: (link.href || link.querySelector('a')?.href || '').trim(),
        };
      })
      .filter((l) => l.text && l.href)
      .slice(0, 30),
    bodyText: (document.body.innerText ?? '').trim().slice(0, 800),
  }));
}

// ── Screenshot + capture ─────────────────────────────────────────────────────

async function captureScreen(
  ctx: ScraperContext,
  page: Page,
  id: string,
  name: string,
  group: string,
): Promise<CapturedScreen> {
  const buffer = await page.screenshot({ fullPage: false });
  const dom = await extractDom(page);
  const { imageUrl, mediaId } = await ctx.saveScreenshot(buffer, id, name);

  const screen: CapturedScreen = {
    id,
    name,
    group,
    url: dom.url,
    imageUrl,
    mediaId,
    dom,
    apiCalls: apiCallsByPage.get(page) ?? [],
    capturedAt: new Date().toISOString(),
    base64: buffer.toString('base64'),
  };
  ctx.onScreen(screen);
  ctx.onLog('info', `Captured ${id} — ${name}`);
  return screen;
}

// ── Pre-auth screens ──────────────────────────────────────────────────────────

async function discoverPreAuth(
  ctx: ScraperContext,
  context: BrowserContext,
  screens: CapturedScreen[],
): Promise<void> {
  const { baseUrl } = ctx;
  ctx.onLog('info', 'Discovering pre-auth screens…');

  // ① Login — email state, then simulated password state
  {
    const page = await newTrackedPage(ctx, context);
    await page
      .goto(`${baseUrl}/login`, { waitUntil: 'networkidle', timeout: 30_000 })
      .catch(() => {});
    await page.waitForSelector('input', { timeout: 8000 }).catch(() => {});
    await wait(SETTLE_MS);
    checkAbort(ctx.signal);

    screens.push(await captureScreen(ctx, page, nextId(screens), 'Login — Enter Email', 'Authentication'));

    // Simulate the second step of a 2-step login (email → password)
    await page
      .evaluate(() => {
        const emailInput = document.querySelector(
          'input#email, input[placeholder="Email"]',
        ) as HTMLInputElement | null;
        if (!emailInput) return;
        emailInput.setAttribute('type', 'password');
        emailInput.setAttribute('placeholder', 'Password');
        const btn = document.querySelector('button#proceed-btn');
        if (btn) btn.textContent = 'Sign In';
      })
      .catch(() => {});
    await wait(400);
    checkAbort(ctx.signal);
    screens.push(
      await captureScreen(ctx, page, nextId(screens), 'Login — Enter Password', 'Authentication'),
    );

    await page.close();
  }

  // ② Sign Up / Register
  for (const path of ['/signup', '/register']) {
    checkAbort(ctx.signal);
    try {
      const page = await newTrackedPage(ctx, context);
      const resp = await page
        .goto(`${baseUrl}${path}`, { waitUntil: 'networkidle', timeout: 15_000 })
        .catch(() => null);
      if (resp?.ok() && !page.url().includes('/login')) {
        await wait(SETTLE_MS);
        screens.push(await captureScreen(ctx, page, nextId(screens), 'Sign Up', 'Authentication'));
        await page.close();
        break;
      }
      await page.close();
    } catch {
      /* path not found */
    }
  }

  // ③ Forgot password
  for (const path of ['/forgot-password', '/forgot', '/reset-password']) {
    checkAbort(ctx.signal);
    try {
      const page = await newTrackedPage(ctx, context);
      const resp = await page
        .goto(`${baseUrl}${path}`, { waitUntil: 'networkidle', timeout: 15_000 })
        .catch(() => null);
      if (resp?.ok() && !page.url().includes('/login')) {
        await wait(SETTLE_MS);
        screens.push(
          await captureScreen(ctx, page, nextId(screens), 'Forgot Password', 'Authentication'),
        );
        await page.close();
        break;
      }
      await page.close();
    } catch {
      /* path not found */
    }
  }
}

// ── Session injection (skip login + captcha with a pre-authenticated session) ───

async function applySession(ctx: ScraperContext, context: BrowserContext): Promise<void> {
  const s = ctx.session;
  if (!s) return;
  const origin = ctx.baseUrl;
  const secure = origin.startsWith('https');

  if (s.cookies?.length) {
    const cookies = s.cookies.map((c) =>
      c.domain
        ? { name: c.name, value: c.value, domain: c.domain, path: c.path ?? '/', secure }
        : { name: c.name, value: c.value, url: origin },
    );
    await context.addCookies(cookies).catch((e) =>
      ctx.onLog('warn', `Cookie injection failed: ${(e as Error).message}`),
    );
    ctx.onLog('info', `Injected ${s.cookies.length} session cookie(s).`);
  }

  if (s.localStorage && Object.keys(s.localStorage).length) {
    // Runs before page scripts on every navigation, so the SPA boots authed.
    await context.addInitScript((entries: Record<string, string>) => {
      try {
        for (const k of Object.keys(entries)) {
          const v = entries[k];
          if (typeof v === 'string') localStorage.setItem(k, v);
        }
      } catch {
        /* storage blocked */
      }
    }, s.localStorage);
    ctx.onLog('info', `Seeded ${Object.keys(s.localStorage).length} localStorage key(s).`);
  }
}

async function enterWithSession(
  ctx: ScraperContext,
  context: BrowserContext,
): Promise<{ page: Page | null; loggedIn: boolean }> {
  const startPath = ctx.session?.startPath || '/';
  const isLanding = startPath === '/dashboard' || startPath === '/';
  ctx.onLog('info', `Entering with provided session → ${startPath}`);
  const page = await newTrackedPage(ctx, context);

  // Boot the SPA on the dashboard first. It loads cleanly with the stored tokens
  // and lets Angular initialise its session/router. We always start here, even
  // for deep targets, because a COLD deep-link to a live route (e.g. /chat/...)
  // aborts the document navigation (net::ERR_ABORTED → chrome-error) when the
  // route redirects/boots — so we never hard-navigate to those routes directly.
  const bootPath = isLanding ? startPath : '/dashboard';
  await page
    .goto(`${ctx.baseUrl}${bootPath}`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    .catch(() => {});
  // Live pages hold open websockets so 'networkidle' never settles — best-effort only.
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  await wait(SETTLE_MS + 1200);

  // If the dashboard itself bounced to login, the session is genuinely invalid.
  if (page.url().includes('/login')) {
    ctx.onLog(
      'warn',
      `Session rejected — the dashboard redirected to /login. The tokens are likely expired; copy a fresh "token" + "tm_token" from a logged-in browser.`,
    );
    await page.close();
    return { page: null, loggedIn: false };
  }

  // For a deep target, navigate IN-APP by clicking the matching sidebar entry.
  // The app renders navigation as JS-driven <button>/<div> handlers (no <a href>),
  // and route guards redirect cold deep-links / pushState back to the dashboard —
  // so a real click on the module button is the only reliable way in.
  if (!isLanding) {
    const segments = startPath.split('/').filter(Boolean); // e.g. ['chat','conversation']
    const moduleWord = segments[0] ?? '';
    const subWord = segments[1] ?? '';

    if (moduleWord) {
      ctx.onLog('info', `Booted on dashboard → clicking sidebar "${moduleWord}" to reach ${startPath}`);
      // Match a button whose ENTIRE label is the module word (e.g. "Chat"), so
      // `.first()` lands on the real, visible nav button — not a partial-match
      // element earlier in the DOM that isn't clickable.
      const moduleBtn = page
        .locator('button', { hasText: new RegExp(`^\\s*${escapeRegex(moduleWord)}\\s*$`, 'i') })
        .first();
      await moduleBtn.click({ timeout: 8_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
      await wait(SETTLE_MS + 1500);

      // If a specific sub-view is requested and we're not there yet, click it too.
      if (subWord && !page.url().toLowerCase().includes(subWord.toLowerCase())) {
        const subItem = page
          .locator(`text=/^\\s*${escapeRegex(subWord)}\\s*$/i`)
          .first();
        await subItem.click({ timeout: 5_000 }).catch(() => {});
        await wait(SETTLE_MS + 1200);
      }
    }
  }

  const url = page.url();
  const failed = url.includes('/login') || url.startsWith('chrome-error') || url === 'about:blank';
  if (failed) {
    ctx.onLog(
      'warn',
      `Could not open ${startPath} (landed on "${url || 'blank'}"). The route may require additional in-app state; the session token alone reached the dashboard but not this view.`,
    );
    await page.close();
    return { page: null, loggedIn: false };
  }

  ctx.onLog('info', `Session accepted → ${url}`);
  return { page, loggedIn: true };
}

// ── Manual login wait (headed mode: human solves captcha / 2FA in the window) ───

/** True if the page appears to present a captcha challenge. */
async function hasCaptcha(page: Page): Promise<boolean> {
  return page
    .$('input[placeholder*="captcha" i], [class*="captcha" i], [id*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i]')
    .then(Boolean)
    .catch(() => false);
}

/** Poll until the page leaves /login (human completed login) or the timeout elapses. */
async function waitForManualLogin(ctx: ScraperContext, page: Page): Promise<boolean> {
  const timeout = ctx.manualTimeoutMs ?? 180_000;
  const deadline = Date.now() + timeout;
  ctx.onLog(
    'warn',
    `⏳ Manual step required — complete the login (and any captcha) in the browser window. ` +
      `Waiting up to ${Math.round(timeout / 1000)}s…`,
  );
  while (Date.now() < deadline) {
    if (ctx.signal.aborted) return false;
    await wait(1500);
    if (!page.url().includes('/login')) {
      ctx.onLog('info', 'Manual login detected — continuing the crawl.');
      return true;
    }
  }
  ctx.onLog('warn', 'Manual login window elapsed without completing login.');
  return false;
}

// ── Login flow ─────────────────────────────────────────────────────────────────

async function performLogin(
  ctx: ScraperContext,
  context: BrowserContext,
): Promise<{ page: Page | null; loggedIn: boolean }> {
  const { baseUrl, email, password } = ctx;
  ctx.onLog('info', 'Attempting login…');

  const page = await newTrackedPage(ctx, context);
  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForSelector('input', { timeout: 10_000 }).catch(() => {});
  await wait(800);

  const emailSels = [
    'input#email',
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="mail" i]',
    'input',
  ];
  for (const sel of emailSels) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.fill(email);
      break;
    }
  }
  await wait(400);

  const proceedSels = [
    'button#proceed-btn',
    'button[type="submit"]',
    'button:has-text("Proceed")',
    'button:has-text("Next")',
    'button:has-text("Continue")',
  ];
  let clicked = false;
  for (const sel of proceedSels) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.click().catch(() => {});
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    ctx.onLog('warn', 'Could not find a Proceed button — login skipped');
    await page.close();
    return { page: null, loggedIn: false };
  }

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await wait(SETTLE_MS);

  const passSels = [
    'input[type="password"]',
    'input[name="password"]',
    'input[placeholder*="pass" i]',
  ];
  for (const sel of passSels) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.fill(password);
      break;
    }
  }
  await wait(400);

  const signInSels = [
    'button[type="submit"]',
    'button#proceed-btn',
    'button:has-text("Sign In")',
    'button:has-text("Login")',
    'button:has-text("Log in")',
  ];
  for (const sel of signInSels) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.click().catch(() => {});
      break;
    }
  }

  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await wait(SETTLE_MS);

  let loggedIn = !page.url().includes('/login');

  // Still on /login after auto-submit — most often a captcha / 2FA block.
  if (!loggedIn) {
    const captcha = await hasCaptcha(page);
    if (ctx.headed) {
      if (captcha) ctx.onLog('warn', 'Captcha detected on the login page.');
      loggedIn = await waitForManualLogin(ctx, page);
    } else {
      ctx.onLog(
        'warn',
        `Login not completed — still on ${page.url()}.` +
          (captcha
            ? ' A captcha is blocking automated login — re-run with headed mode to solve it by hand.'
            : ' If the login needs a captcha or 2FA, re-run with headed mode to complete it manually.'),
      );
    }
  }

  if (!loggedIn) {
    await page.close();
    return { page: null, loggedIn: false };
  }

  ctx.onLog('info', `Login succeeded → ${page.url()}`);
  return { page, loggedIn: true };
}

// ── Post-login discovery (recursive nav crawl) ──────────────────────────────────

async function discoverPostLogin(
  ctx: ScraperContext,
  context: BrowserContext,
  page: Page,
  screens: CapturedScreen[],
  depth: number,
): Promise<void> {
  checkAbort(ctx.signal);
  const maxDepth = ctx.navDepth;
  if (depth > maxDepth) return;

  const dom = await extractDom(page);
  const currentGroup = depth === 0 ? 'Dashboard' : `App — Level ${depth}`;
  const name =
    dom.heading || dom.title || new URL(dom.url).pathname.split('/').pop() || 'Screen';

  screens.push(await captureScreen(ctx, page, nextId(screens), name, currentGroup));

  if (depth >= maxDepth) return;

  const seen = new Set(
    screens.map((s) => {
      try {
        return new URL(s.url).pathname;
      } catch {
        return s.url;
      }
    }),
  );

  const navPaths = [
    ...new Set(
      dom.navLinks
        .map((l) => normalizeUrl(l.href, ctx.baseUrl))
        .filter((p): p is string => !!p && !seen.has(p) && p !== '/login' && p !== '/logout'),
    ),
  ];
  ctx.onLog('info', `Found ${navPaths.length} new links at level ${depth}`);

  for (const path of navPaths.slice(0, 15)) {
    checkAbort(ctx.signal);
    try {
      const navPage = await newTrackedPage(ctx, context);
      await navPage.goto(`${ctx.baseUrl}${path}`, { waitUntil: 'networkidle', timeout: 20_000 });
      await wait(SETTLE_MS);

      const navPath = normalizeUrl(navPage.url(), ctx.baseUrl);
      if (!navPath || seen.has(navPath) || navPage.url().includes('/login')) {
        await navPage.close();
        continue;
      }
      seen.add(navPath);

      await discoverPostLogin(ctx, context, navPage, screens, depth + 1);
      await navPage.close();
    } catch (err) {
      ctx.onLog('warn', `${path}: ${(err as Error).message}`);
    }
  }
}

// ── Auto-group ──────────────────────────────────────────────────────────────────

function buildGroups(screens: CapturedScreen[]): ScreenGroup[] {
  const map = new Map<string, string[]>();
  for (const s of screens) {
    if (!map.has(s.group)) map.set(s.group, []);
    map.get(s.group)!.push(s.id);
  }
  return Array.from(map.entries()).map(([name, screenIds], i) => {
    let routePath = '/';
    const first = screens.find((s) => s.id === screenIds[0]);
    if (first) {
      try {
        routePath = new URL(first.url).pathname;
      } catch {
        /* keep default */
      }
    }
    return { id: `group-${String(i + 1).padStart(2, '0')}`, name, screenIds, routePath };
  });
}

// ── Entry point ──────────────────────────────────────────────────────────────────

export async function runScraper(
  ctx: ScraperContext,
): Promise<{ screens: CapturedScreen[]; groups: ScreenGroup[] }> {
  const screens: CapturedScreen[] = [];
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: !ctx.headed });
    if (ctx.headed) {
      ctx.onLog('info', 'Headed mode — a browser window will open for manual captcha/login if needed.');
    }
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'en-US',
    });

    if (ctx.session) {
      // Session path: inject the pre-authenticated session and crawl the app
      // directly. Skips the public auth screens (the session usually redirects
      // them) and login entirely — no credentials, no captcha.
      await applySession(ctx, context);
      const { page, loggedIn } = await enterWithSession(ctx, context);
      if (loggedIn && page) {
        ctx.onLog('info', 'Discovering app screens with the provided session…');
        await discoverPostLogin(ctx, context, page, screens, 0);
        await page.close();
      } else {
        // Session failed — fall back to capturing the public auth screens.
        await discoverPreAuth(ctx, context, screens);
      }
    } else {
      await discoverPreAuth(ctx, context, screens);

      if (ctx.email && ctx.password) {
        const { page, loggedIn } = await performLogin(ctx, context);
        if (loggedIn && page) {
          ctx.onLog('info', 'Discovering post-login screens…');
          await discoverPostLogin(ctx, context, page, screens, 0);
          await page.close();
        }
      } else {
        ctx.onLog('warn', 'No credentials or session provided — only pre-auth screens captured.');
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const groups = buildGroups(screens);
  return { screens, groups };
}
