#!/usr/bin/env node
/**
 * run-pipeline.mjs — Master Orchestrator
 * ────────────────────────────────────────
 * Runs all 3 phases in sequence with progress output and a confirmation
 * checkpoint before publishing to the live HelpAssistant API.
 *
 * Usage:
 *   node run-pipeline.mjs              — full pipeline (phases 1→2→3)
 *   node run-pipeline.mjs --from 2     — resume from phase 2 (uses existing screen_map.json)
 *   node run-pipeline.mjs --from 3     — resume from phase 3 (uses existing content_draft.json)
 *   node run-pipeline.mjs --no-publish — run phases 1 + 2 only (no publish)
 *   node run-pipeline.mjs --dry-run    — same as --no-publish (alias)
 *
 * Before running:
 *   1. Fill in scrape.config.mjs with target credentials + AI keys
 *   2. Make sure the HelpAssistant backend is running (npm run dev in /backend)
 */

import { createInterface } from 'node:readline';
import { existsSync }      from 'node:fs';
import { readFile }        from 'node:fs/promises';
import { join, dirname }   from 'node:path';
import { fileURLToPath }   from 'node:url';
import config              from './scrape.config.mjs';

const __dir      = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dir, 'output');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const fromPhase = (() => {
  const idx = args.indexOf('--from');
  return idx !== -1 ? parseInt(args[idx + 1], 10) : 1;
})();
const noPublish = args.includes('--no-publish') || args.includes('--dry-run');

// ── Confirm prompt ────────────────────────────────────────────────────────────

function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${question} (y/N): `, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ── Summary printer ───────────────────────────────────────────────────────────

async function printDraftSummary() {
  const draftPath = join(OUTPUT_DIR, 'content_draft.json');
  if (!existsSync(draftPath)) return;
  try {
    const draft = JSON.parse(await readFile(draftPath, 'utf8'));
    console.log('\n┌─────────────────────────────────────────────┐');
    console.log('│          Draft Content Summary               │');
    console.log('└─────────────────────────────────────────────┘');
    for (const t of draft.tutorials) {
      console.log(`\n  📄 ${t.page?.title ?? t.groupName}`);
      console.log(`     Route: ${t.page?.routePath ?? '/'}`);
      console.log(`     Steps: ${t.steps?.length ?? 0}`);
      for (const s of t.steps ?? []) {
        console.log(`       ${s.stepNumber}. ${s.title}`);
      }
    }
    console.log();
  } catch { /* noop */ }
}

async function printScreenMapSummary() {
  const mapPath = join(OUTPUT_DIR, 'screen_map.json');
  if (!existsSync(mapPath)) return;
  try {
    const map = JSON.parse(await readFile(mapPath, 'utf8'));
    console.log('\n┌─────────────────────────────────────────────┐');
    console.log('│          Screen Map Summary                  │');
    console.log('└─────────────────────────────────────────────┘');
    console.log(`  App:      ${map.appName}`);
    console.log(`  Screens:  ${map.totalScreens}`);
    console.log(`  Groups:`);
    for (const g of map.groups) {
      console.log(`    • ${g.name} — ${g.screenIds.length} screens`);
    }
    console.log();
  } catch { /* noop */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   HelpAssistant — AI Documentation Pipeline  ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  App:         ${config.target.appName} (${config.target.baseUrl})`);
  console.log(`  Target user: ${config.target.email || '⚠  NOT SET — only pre-auth screens will be captured'}`);
  console.log(`  AI:          ${config.ai.anthropicKeys.length} Anthropic key(s), ${config.ai.openaiKeys.length} OpenAI key(s)`);
  console.log(`  HA API:      ${config.ha.apiBase}`);
  console.log(`  Start phase: ${fromPhase}`);
  if (noPublish) console.log(`  Publish:     disabled (--no-publish)`);
  console.log('');

  // ── Phase 1: Screen discovery ─────────────────────────────────────────────
  let screenMap;
  if (fromPhase <= 1) {
    const { runScraper } = await import('./scraper.mjs');
    screenMap = await runScraper();
    await printScreenMapSummary();

    if (!noPublish) {
      const go = await confirm('Phase 1 complete. Proceed to AI content drafting?');
      if (!go) { console.log('Stopped.'); process.exit(0); }
    }
  } else {
    const mapPath = join(OUTPUT_DIR, 'screen_map.json');
    if (!existsSync(mapPath)) {
      console.error('ERROR: output/screen_map.json not found. Run without --from 2 first.');
      process.exit(1);
    }
    screenMap = JSON.parse(await readFile(mapPath, 'utf8'));
    console.log(`\n  ℹ  Loaded screen_map.json (${screenMap.totalScreens} screens, ${screenMap.groups.length} groups)`);
  }

  // ── Phase 2: AI content drafting ─────────────────────────────────────────
  let contentDraft;
  if (fromPhase <= 2) {
    const { runDrafter } = await import('./draft-content.mjs');
    contentDraft = await runDrafter(screenMap);
    await printDraftSummary();

    if (!noPublish) {
      console.log('  Review the draft above.');
      console.log('  To edit: open output/content_draft.json and modify, then re-run with --from 3');
      const go = await confirm('Publish this content to HelpAssistant?');
      if (!go) {
        console.log('\n  Publish skipped. You can review and re-run with:');
        console.log('  node run-pipeline.mjs --from 3');
        process.exit(0);
      }
    } else {
      console.log('\n  --no-publish set. Stopping after Phase 2.');
      console.log('  Review output/content_draft.json, then run:');
      console.log('  node run-pipeline.mjs --from 3');
      process.exit(0);
    }
  } else {
    const draftPath = join(OUTPUT_DIR, 'content_draft.json');
    if (!existsSync(draftPath)) {
      console.error('ERROR: output/content_draft.json not found. Run without --from 3 first.');
      process.exit(1);
    }
    contentDraft = JSON.parse(await readFile(draftPath, 'utf8'));
    console.log(`\n  ℹ  Loaded content_draft.json (${contentDraft.totalTutorials} tutorials)`);
  }

  // ── Phase 3: Publish ──────────────────────────────────────────────────────
  const { runPublisher } = await import('./publish.mjs');
  const result = await runPublisher(contentDraft);

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Pipeline Complete!                         ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Published: ${result.succeeded} tutorial(s)`);
  if (result.failed > 0) {
    console.log(`  Failed:    ${result.failed} tutorial(s)`);
    console.log('  Check output/publish_result.json for details');
  }
  console.log('');
  console.log(`  View at: ${config.ha.apiBase.replace(':3000', ':4200')}`);
  console.log('');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
