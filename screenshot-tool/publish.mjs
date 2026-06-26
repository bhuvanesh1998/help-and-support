/**
 * publish.mjs — Phase 3: HelpAssistant Publisher
 * ─────────────────────────────────────────────────
 * Reads content_draft.json and for each tutorial:
 *   1. Creates a Page in the HelpAssistant admin API
 *   2. Uploads each screenshot to the media API
 *   3. Creates Steps with markdown content + image URLs
 *
 * Run standalone: node publish.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync }         from 'node:fs';
import { join, dirname }        from 'node:path';
import { fileURLToPath }        from 'node:url';
import config                   from './scrape.config.mjs';

const __dir      = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dir, 'output');
const DRAFT_FILE = join(OUTPUT_DIR, 'content_draft.json');
const RESULT_FILE = join(OUTPUT_DIR, 'publish_result.json');

// ── HA Admin API client ───────────────────────────────────────────────────────

class HAClient {
  constructor(token) {
    this.token   = token;
    this.baseUrl = config.ha.apiBase;
  }

  async _req(method, path, body) {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HA API ${method} ${path} → ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async createPage(title, description, routePath) {
    return this._req('POST', '/api/admin/pages', { title, description, routePath });
  }

  async createStep(pageId, stepNumber, title, instructionsMd, imageUrl) {
    return this._req('POST', `/api/admin/pages/${pageId}/steps`, {
      stepNumber, title, instructionsMd, imageUrl: imageUrl ?? null,
    });
  }

  async uploadMedia(screenshotPath, filename) {
    const buffer = readFileSync(screenshotPath);
    const blob   = new Blob([buffer], { type: 'image/png' });
    const form   = new FormData();
    form.append('file', blob, filename);

    const resp = await fetch(`${this.baseUrl}/api/admin/media`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body:    form,
    });
    if (!resp.ok) throw new Error(`Upload failed ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return data.asset?.publicUrl ?? data.url ?? '';
  }
}

async function loginHA() {
  const resp = await fetch(`${config.ha.apiBase}/api/admin/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: config.ha.email, password: config.ha.password }),
  });
  if (!resp.ok) throw new Error(`HA login failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.accessToken;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runPublisher(contentDraftInput) {
  console.log('\n════════════════════════════════════════');
  console.log(' Phase 3 — Publishing to HelpAssistant  ');
  console.log('════════════════════════════════════════');

  const draft   = contentDraftInput ?? JSON.parse(await readFile(DRAFT_FILE, 'utf8'));
  const screens = draft.screens ?? [];

  // Build a quick lookup: screenshotId → screen object
  const screenById = Object.fromEntries(screens.map(s => [s.id, s]));

  console.log('\n→ Authenticating with HelpAssistant API…');
  const token = await loginHA();
  const ha    = new HAClient(token);
  console.log('  ✓ Authenticated');

  const results = [];

  for (const tutorial of draft.tutorials) {
    const { page: pageInfo, steps, groupName } = tutorial;
    if (!pageInfo || !steps?.length) {
      console.log(`\n  ⚠  Skipping "${groupName}" — missing page or steps`);
      continue;
    }

    console.log(`\n── Publishing: "${pageInfo.title}"`);

    try {
      // 1. Create the page
      const created = await ha.createPage(
        pageInfo.title,
        pageInfo.description ?? '',
        pageInfo.routePath   ?? '/',
      );
      const pageId = created.page?.id ?? created.id;
      console.log(`  ✓ Page created: ${pageId}`);

      const stepResults = [];

      // 2. For each step: upload screenshot + create step
      for (const step of steps) {
        let imageUrl = null;

        const screen = screenById[step.screenshotId];
        if (screen?.screenshotPath) {
          try {
            imageUrl = await ha.uploadMedia(screen.screenshotPath, screen.filename);
            console.log(`  ✓ Step ${step.stepNumber} screenshot uploaded`);
          } catch (uploadErr) {
            console.warn(`  ⚠  Step ${step.stepNumber} screenshot upload failed: ${uploadErr.message}`);
          }
        }

        const createdStep = await ha.createStep(
          pageId,
          step.stepNumber,
          step.title,
          step.instructionsMd,
          imageUrl,
        );
        stepResults.push({ stepNumber: step.stepNumber, title: step.title, imageUrl });
        console.log(`  ✓ Step ${step.stepNumber}: "${step.title}"`);
      }

      results.push({
        groupName,
        pageId,
        title: pageInfo.title,
        routePath: pageInfo.routePath,
        steps: stepResults,
        status: 'published',
      });

    } catch (err) {
      console.error(`  ✗ ${pageInfo.title}: ${err.message}`);
      results.push({ groupName, title: pageInfo.title, status: 'failed', error: err.message });
    }
  }

  const output = {
    publishedAt:  new Date().toISOString(),
    total:        results.length,
    succeeded:    results.filter(r => r.status === 'published').length,
    failed:       results.filter(r => r.status === 'failed').length,
    results,
  };

  await writeFile(RESULT_FILE, JSON.stringify(output, null, 2));

  console.log('\n════════════════════════════════════════');
  console.log(` Phase 3 complete`);
  console.log(` Published: ${output.succeeded} / ${output.total} tutorials`);
  if (output.failed > 0) console.log(` Failed:    ${output.failed}`);
  console.log(` Saved → output/publish_result.json`);
  console.log('════════════════════════════════════════');

  return output;
}

// ── Standalone entry ──────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPublisher().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
