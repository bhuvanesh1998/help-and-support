/**
 * scraper.mjs — Phase 1: Screen Discovery
 * ─────────────────────────────────────────
 * Autonomously navigates the target app, discovers all distinct UI states,
 * and saves screenshots + DOM metadata to output/screen_map.json.
 *
 * Discovery strategy:
 *   1. Pre-auth screens: /login, /signup, /register, /forgot-password etc.
 *   2. Auth flow: fill email → Proceed → fill password → Sign In
 *   3. Post-login nav: find all sidebar/topbar links, click each, recurse
 *
 * Run standalone: node scraper.mjs
 */

import { chromium } from 'playwright';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './scrape.config.mjs';

const __dir        = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR   = join(__dir, 'output');
const SS_DIR       = join(OUTPUT_DIR, 'screenshots');
const SCREEN_MAP   = join(OUTPUT_DIR, 'screen_map.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    if (u.origin !== new URL(base).origin) return null;
    return u.pathname;
  } catch { return null; }
}

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── DOM extraction ────────────────────────────────────────────────────────────

async function extractDom(page) {
  return page.evaluate(() => ({
    url:     location.href,
    title:   document.title.trim(),
    heading: (document.querySelector('h1,h2,[class*="title"],[class*="heading"]')?.textContent ?? '').trim().slice(0, 80),
    inputs:  Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
      type:        i.type || 'text',
      id:          i.id,
      name:        i.name,
      placeholder: i.placeholder,
      label:       (document.querySelector(`label[for="${i.id}"]`)?.textContent ?? '').trim(),
    })).slice(0, 12),
    buttons: Array.from(document.querySelectorAll('button,[role="button"]')).map(b => ({
      id:    b.id,
      text:  b.textContent.trim().slice(0, 60),
      class: b.className.slice(0, 80),
    })).filter(b => b.text).slice(0, 12),
    links: Array.from(document.querySelectorAll('a[href]')).map(a => ({
      text:  a.textContent.trim().slice(0, 60),
      href:  a.href,
      class: a.className.slice(0, 60),
    })).filter(l => l.text && l.href && !l.href.startsWith('javascript')).slice(0, 20),
    navLinks: Array.from(document.querySelectorAll(
      'nav a, [role="navigation"] a, [class*="sidebar"] a, [class*="sidenav"] a, [class*="nav-item"], [class*="menu-item"]'
    )).map(a => ({
      text: a.textContent.trim().slice(0, 60),
      href: (a.href || a.querySelector('a')?.href || '').trim(),
    })).filter(l => l.text && l.href).slice(0, 30),
    bodyText: document.body.innerText.trim().slice(0, 800),
  }));
}

// ── Screenshot ────────────────────────────────────────────────────────────────

async function captureScreen(page, id, name, group) {
  const filename = `${id}-${slug(name)}.png`;
  const path     = join(SS_DIR, filename);
  await page.screenshot({ path, fullPage: false });

  const dom = await extractDom(page);
  return {
    id,
    name,
    group,
    url:       dom.url,
    filename,
    screenshotPath: path,
    dom,
    capturedAt: new Date().toISOString(),
  };
}

// ── Pre-auth screen discovery ─────────────────────────────────────────────────

async function discoverPreAuth(context, baseUrl, screens) {
  const { preAuthPaths, settleMs, viewport } = config.scraper;

  console.log('\n── Pre-auth screens ──────────────────────────────');

  // ① Login — email state
  {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
    await page.waitForSelector('input', { timeout: 8000 }).catch(() => {});
    await wait(settleMs);

    const screen = await captureScreen(page, String(screens.length + 1).padStart(3, '0'), 'Login — Enter Email', 'Authentication');
    screens.push(screen);
    console.log(`  ✓ ${screen.id} — ${screen.name}`);

    // ② Simulate password screen (2-step login: email → password)
    await page.evaluate(() => {
      const emailInput = document.querySelector('input#email, input[placeholder="Email"]');
      if (!emailInput) return;
      emailInput.setAttribute('type', 'password');
      emailInput.setAttribute('placeholder', 'Password');
      const btn = document.querySelector('button#proceed-btn');
      if (btn) btn.textContent = 'Sign In';
      const wrap = document.createElement('div');
      wrap.style.cssText = 'text-align:right;margin-top:6px;margin-bottom:4px;';
      const link = document.createElement('a');
      link.href = '#'; link.textContent = 'Forgot password?';
      link.style.cssText = 'font-size:13px;color:#0d9488;font-weight:600;text-decoration:none;';
      wrap.appendChild(link);
      emailInput.parentElement?.insertAdjacentElement('afterend', wrap);
    });
    await wait(400);
    {
      const passIdx = screens.length + 1;
      const passId  = String(passIdx).padStart(3, '0');
      const passScreen = await captureScreen(page, passId, 'Login — Enter Password', 'Authentication');
      screens.push(passScreen);
      console.log(`  ✓ ${passScreen.id} — ${passScreen.name}`);
    }

    await page.close();
  }

  // ③ Sign Up / Register page
  for (const path of ['/signup', '/register']) {
    try {
      const page = await context.newPage();
      const resp = await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle', timeout: 15_000 }).catch(() => null);
      if (resp && resp.ok()) {
        await wait(settleMs);
        const url  = page.url();
        if (!url.includes('/login')) {   // wasn't redirected back to login
          const idx  = screens.length + 1;
          const id   = String(idx).padStart(3, '0');
          const screen = await captureScreen(page, id, 'Sign Up', 'Authentication');
          screens.push(screen);
          console.log(`  ✓ ${screen.id} — ${screen.name} (${path})`);
          await page.close();
          break;
        }
      }
      await page.close();
    } catch { /* path not found */ }
  }

  // ④ Forgot password page
  for (const path of ['/forgot-password', '/forgot', '/reset-password']) {
    try {
      const page = await context.newPage();
      const resp = await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle', timeout: 15_000 }).catch(() => null);
      if (resp && resp.ok()) {
        await wait(settleMs);
        const url = page.url();
        if (!url.includes('/login')) {
          const idx  = screens.length + 1;
          const id   = String(idx).padStart(3, '0');
          const screen = await captureScreen(page, id, 'Forgot Password', 'Authentication');
          screens.push(screen);
          console.log(`  ✓ ${screen.id} — ${screen.name} (${path})`);
          await page.close();
          break;
        }
      }
      await page.close();
    } catch { /* path not found */ }
  }
}

// ── Login flow ────────────────────────────────────────────────────────────────

async function performLogin(context, baseUrl, email, password, screens) {
  console.log('\n── Login flow ────────────────────────────────────');
  const page = await context.newPage();

  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForSelector('input', { timeout: 10_000 }).catch(() => {});
  await wait(800);

  // Fill email
  const emailSels = ['input#email', 'input[type="email"]', 'input[name="email"]', 'input[placeholder*="mail" i]', 'input'];
  for (const sel of emailSels) {
    const el = await page.$(sel).catch(() => null);
    if (el) { await el.fill(email); break; }
  }
  await wait(400);

  // Capture: after filling email (proceed button highlighted)
  {
    const idx = screens.length + 1;
    const id  = String(idx).padStart(3, '0');
    const screen = await captureScreen(page, id, 'Login — Email Filled', 'Authentication');
    screens.push(screen);
    console.log(`  ✓ ${screen.id} — ${screen.name}`);
  }

  // Click proceed / next / continue / submit
  const proceedSels = ['button#proceed-btn', 'button[type="submit"]', 'button:has-text("Proceed")', 'button:has-text("Next")', 'button:has-text("Continue")'];
  let clicked = false;
  for (const sel of proceedSels) {
    const el = await page.$(sel).catch(() => null);
    if (el) { await el.click(); clicked = true; break; }
  }

  if (!clicked) {
    console.log('  ⚠  Could not find Proceed button — skipping password screen');
    await page.close();
    return { page: null, loggedIn: false };
  }

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await wait(config.scraper.settleMs);

  // Capture: password screen
  {
    const idx = screens.length + 1;
    const id  = String(idx).padStart(3, '0');
    const screen = await captureScreen(page, id, 'Login — Enter Password', 'Authentication');
    screens.push(screen);
    console.log(`  ✓ ${screen.id} — ${screen.name}`);
  }

  // Fill password
  const passSels = ['input[type="password"]', 'input[name="password"]', 'input[placeholder*="pass" i]'];
  for (const sel of passSels) {
    const el = await page.$(sel).catch(() => null);
    if (el) { await el.fill(password); break; }
  }
  await wait(400);

  // Click sign in / login / submit
  const signInSels = ['button[type="submit"]', 'button#proceed-btn', 'button:has-text("Sign In")', 'button:has-text("Login")', 'button:has-text("Log in")'];
  for (const sel of signInSels) {
    const el = await page.$(sel).catch(() => null);
    if (el) { await el.click(); break; }
  }

  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await wait(config.scraper.settleMs);

  const postLoginUrl = page.url();
  const loggedIn     = !postLoginUrl.includes('/login');

  if (!loggedIn) {
    console.log('  ⚠  Login may have failed — still on login page');
    console.log('       URL:', postLoginUrl);
    await page.close();
    return { page: null, loggedIn: false };
  }

  console.log(`  ✓ Login succeeded → ${postLoginUrl}`);
  return { page, loggedIn: true };
}

// ── Post-login discovery ──────────────────────────────────────────────────────

async function discoverPostLogin(context, page, baseUrl, screens, depth = 0) {
  const maxDepth = config.scraper.navDepth;
  if (depth > maxDepth) return;

  const dom          = await extractDom(page);
  const currentGroup = depth === 0 ? 'Dashboard' : `App — Depth ${depth}`;

  // Capture current screen
  {
    const name    = dom.heading || dom.title || new URL(dom.url).pathname.split('/').pop() || 'Screen';
    const idx     = screens.length + 1;
    const id      = String(idx).padStart(3, '0');
    const screen  = await captureScreen(page, id, name, currentGroup);
    screens.push(screen);
    console.log(`  ✓ ${screen.id} — ${screen.name}`);
  }

  if (depth >= maxDepth) return;

  // Collect nav links unique to this app
  const seen = new Set(screens.map(s => {
    try { return new URL(s.url).pathname; } catch { return s.url; }
  }));

  const navLinks = dom.navLinks
    .map(l => normalizeUrl(l.href, baseUrl))
    .filter(p => p && !seen.has(p) && p !== '/login' && p !== '/logout');

  const unique = [...new Set(navLinks)];
  console.log(`     Found ${unique.length} new nav links at depth ${depth}`);

  for (const path of unique.slice(0, 15)) { // cap at 15 nav items per level
    const fullUrl = `${baseUrl}${path}`;
    try {
      const navPage = await context.newPage();
      await navPage.goto(fullUrl, { waitUntil: 'networkidle', timeout: 20_000 });
      await wait(config.scraper.settleMs);

      const navUrl  = navPage.url();
      const navPath = normalizeUrl(navUrl, baseUrl);

      if (!navPath || seen.has(navPath) || navUrl.includes('/login')) {
        await navPage.close();
        continue;
      }
      seen.add(navPath);

      await discoverPostLogin(context, navPage, baseUrl, screens, depth + 1);
      await navPage.close();
    } catch (err) {
      console.warn(`     ⚠  ${path}: ${err.message}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runScraper() {
  console.log('════════════════════════════════════════');
  console.log(' Phase 1 — Screen Discovery             ');
  console.log('════════════════════════════════════════');

  await mkdir(SS_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const { baseUrl, email, password } = config.target;
  const screens = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport:          config.scraper.viewport,
    deviceScaleFactor: config.scraper.deviceScaleFactor,
    locale:            'en-US',
  });

  try {
    // Phase 1a: Pre-auth screens
    await discoverPreAuth(context, baseUrl, screens);

    // Phase 1b: Login + post-login discovery (only if credentials are provided)
    if (email && password) {
      const { page, loggedIn } = await performLogin(context, baseUrl, email, password, screens);
      if (loggedIn && page) {
        console.log('\n── Post-login screens ────────────────────────────');
        await discoverPostLogin(context, page, baseUrl, screens, 0);
        await page.close();
      }
    } else {
      console.log('\n  ℹ  No target credentials set — skipping post-login discovery.');
      console.log('     Set TARGET_EMAIL and TARGET_PASSWORD env vars or fill scrape.config.mjs');
    }
  } finally {
    await browser.close();
  }

  // Auto-group screens if no custom groups defined
  const groups = buildGroups(screens);

  const screenMap = {
    appName:     config.target.appName,
    baseUrl,
    capturedAt:  new Date().toISOString(),
    totalScreens: screens.length,
    groups,
    screens,
  };

  await writeFile(SCREEN_MAP, JSON.stringify(screenMap, null, 2));

  console.log('\n════════════════════════════════════════');
  console.log(` Phase 1 complete — ${screens.length} screens captured`);
  console.log(` Groups: ${groups.map(g => `${g.name} (${g.screenIds.length})`).join(', ')}`);
  console.log(` Saved → output/screen_map.json`);
  console.log('════════════════════════════════════════');

  return screenMap;
}

// ── Group screens into tutorial pages ────────────────────────────────────────

function buildGroups(screens) {
  if (config.groups) {
    return config.groups.map(g => ({
      ...g,
      screenIds: screens
        .filter(s => g.matchPaths.some(p => s.url.includes(p)))
        .map(s => s.id),
    }));
  }

  // Auto-group by declared group field
  const map = new Map();
  for (const s of screens) {
    if (!map.has(s.group)) map.set(s.group, []);
    map.get(s.group).push(s.id);
  }

  return Array.from(map.entries()).map(([name, screenIds], i) => ({
    id:        `group-${String(i + 1).padStart(2, '0')}`,
    name,
    screenIds,
    routePath: screenIds.length > 0 ? (new URL(screens.find(s => s.id === screenIds[0])?.url ?? 'http://x/').pathname) : '/',
  }));
}

// ── Standalone entry ──────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runScraper().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
