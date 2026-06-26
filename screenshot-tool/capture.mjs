/**
 * capture.mjs — Automated tutorial screenshot tool
 *
 * For each step in steps.config.mjs:
 *   1. Opens a headless Chromium browser
 *   2. Navigates to the target URL and runs any pre-actions (fill, click)
 *   3. Injects DOM overlay annotations (colored border + label badge) over target elements
 *   4. Takes a viewport screenshot (2x device scale for retina quality)
 *   5. Uploads the PNG to the backend media API
 *   6. PATCHes the tutorial step with the returned imageUrl
 *
 * Run: node capture.mjs
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_BASE, PAGE_ID, ADMIN_EMAIL, ADMIN_PASSWORD, STEPS } from './steps.config.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dir, 'screenshots');

// ── Auth ──────────────────────────────────────────────────────────────────────

async function login() {
  const resp = await fetch(`${API_BASE}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!resp.ok) throw new Error(`Login failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.accessToken;
}

// ── Annotation injection ──────────────────────────────────────────────────────

async function injectHighlight(page, h) {
  for (const sel of h.selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;

      // Scroll element into view and wait for position to settle
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(300);

      const box = await loc.boundingBox();
      if (!box) continue;

      await page.evaluate(
        ({ box, label, color, id }) => {
          const pad = 5;
          document.getElementById('hl-' + id)?.remove();

          const wrap = document.createElement('div');
          wrap.id = 'hl-' + id;
          Object.assign(wrap.style, {
            position:        'fixed',
            left:            `${box.x - pad}px`,
            top:             `${box.y - pad}px`,
            width:           `${box.width + pad * 2}px`,
            height:          `${box.height + pad * 2}px`,
            border:          `3px solid ${color}`,
            borderRadius:    '8px',
            zIndex:          '2147483647',
            pointerEvents:   'none',
            boxShadow:       `0 0 0 3px rgba(255,255,255,0.95), 0 4px 20px rgba(0,0,0,0.18)`,
            backgroundColor: `${color}1a`,
          });

          // Label badge
          const badge = document.createElement('div');
          badge.textContent = label;
          Object.assign(badge.style, {
            position:    'absolute',
            top:         '-36px',
            left:        '-3px',
            background:  color,
            color:       '#fff',
            font:        '700 12px/1.3 system-ui, -apple-system, sans-serif',
            padding:     '5px 12px',
            borderRadius:'6px',
            whiteSpace:  'nowrap',
            boxShadow:   '0 2px 10px rgba(0,0,0,0.3)',
            letterSpacing: '0.01em',
          });

          // Arrow pointer below badge
          const arrow = document.createElement('div');
          Object.assign(arrow.style, {
            position:    'absolute',
            bottom:      '-8px',
            left:        '12px',
            width:       '0',
            height:      '0',
            borderLeft:  '7px solid transparent',
            borderRight: '7px solid transparent',
            borderTop:   `8px solid ${color}`,
          });

          badge.appendChild(arrow);
          wrap.appendChild(badge);
          document.body.appendChild(wrap);
        },
        { box, label: h.label, color: h.color, id: h.id },
      );

      return; // success — stop trying selectors
    } catch {
      // selector threw — try the next one
    }
  }
  console.warn(`  ⚠  No element matched for "${h.label}"`);
}

// ── Pre-step actions ──────────────────────────────────────────────────────────

async function runActions(page, actions) {
  for (const action of actions) {
    if (action.type === 'fill') {
      for (const sel of action.selectors) {
        try {
          const loc = page.locator(sel).first();
          if ((await loc.count()) > 0) {
            await loc.fill(action.value);
            break;
          }
        } catch {}
      }
    }

    if (action.type === 'click') {
      for (const sel of action.selectors) {
        try {
          const loc = page.locator(sel).first();
          if ((await loc.count()) > 0) {
            await loc.click();
            break;
          }
        } catch {}
      }
    }

    if (action.type === 'waitForNavigation') {
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    if (action.type === 'wait') {
      await page.waitForTimeout(action.timeout ?? 1000);
    }

    if (action.type === 'simulatePasswordScreen') {
      // Transform the login form to look like the password screen (step 2 of Twixor's 2-step login)
      await page.evaluate(() => {
        const emailInput = document.querySelector('input#email');
        if (!emailInput) return;

        // Change email field → password field
        emailInput.setAttribute('type', 'password');
        emailInput.setAttribute('placeholder', 'Password');
        emailInput.id = 'password';

        // Update the label text above if present
        const label = document.querySelector('label[for="email"], .login-label, .form-label');
        if (label) label.textContent = 'Password';

        // Update Proceed → Sign In
        const btn = document.querySelector('button#proceed-btn');
        if (btn) btn.textContent = 'Sign In';

        // Inject a "Forgot password?" link below the field
        const existing = document.getElementById('simulated-forgot-link');
        if (!existing) {
          const wrap = document.createElement('div');
          wrap.style.cssText = 'text-align:right;margin-top:6px;margin-bottom:4px;';
          const link = document.createElement('a');
          link.id = 'simulated-forgot-link';
          link.href = '#';
          link.textContent = 'Forgot password?';
          link.style.cssText = 'font-size:13px;color:#0d9488;font-weight:600;text-decoration:none;';
          wrap.appendChild(link);
          emailInput.parentElement?.insertAdjacentElement('afterend', wrap);
        }
      });
      await page.waitForTimeout(300);
    }
  }
}

// ── Media upload + step patch ─────────────────────────────────────────────────

async function uploadMedia(token, screenshotPath, filename) {
  const buffer = readFileSync(screenshotPath);
  const blob = new Blob([buffer], { type: 'image/png' });
  const form = new FormData();
  form.append('file', blob, filename);

  const resp = await fetch(`${API_BASE}/api/admin/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!resp.ok) throw new Error(`Upload failed ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.asset.publicUrl;
}

async function patchStep(token, stepId, imageUrl) {
  const resp = await fetch(`${API_BASE}/api/admin/pages/${PAGE_ID}/steps/${stepId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl }),
  });
  if (!resp.ok) throw new Error(`Patch failed ${resp.status}: ${await resp.text()}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log(' Screenshot Tool  —  Twixor Tutorial Capture  ');
  console.log('══════════════════════════════════════════════\n');

  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  const token = await login();
  console.log('✓ Authenticated\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport:         { width: 1440, height: 900 },
    deviceScaleFactor: 2,           // retina-quality PNG
    locale:           'en-US',
  });

  let ok = 0;

  for (const step of STEPS) {
    console.log(`─── Step ${step.stepNumber}: ${step.slug}`);
    const page = await context.newPage();

    try {
      await page.goto(step.url, { waitUntil: 'networkidle', timeout: 30_000 });

      if (step.waitFor) {
        await page.waitForSelector(step.waitFor, { timeout: 10_000 }).catch(() => {});
      }
      await page.waitForTimeout(1000); // allow hydration / animations

      if (step.actions?.length) {
        await runActions(page, step.actions);
        await page.waitForTimeout(600);
      }

      for (const h of step.highlights) {
        await injectHighlight(page, h);
      }
      await page.waitForTimeout(400); // let overlays paint

      const filename      = `step-${step.stepNumber}-${step.slug}.png`;
      const screenshotPath = join(SCREENSHOTS_DIR, filename);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.log(`  ✓ Screenshot → ${filename}`);

      const imageUrl = await uploadMedia(token, screenshotPath, filename);
      console.log(`  ✓ Uploaded   → ${imageUrl}`);

      await patchStep(token, step.id, imageUrl);
      console.log(`  ✓ Step patched with imageUrl`);

      ok++;
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
    } finally {
      await page.close();
    }
    console.log();
  }

  await browser.close();
  console.log(`══════════════════════════════════════════════`);
  console.log(` Done — ${ok} / ${STEPS.length} steps updated`);
  console.log(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
