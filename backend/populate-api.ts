/**
 * One-off: capture a screen's live API calls and attach them to an existing
 * user-manual page (replaces that page's API endpoints).
 *
 * Usage: tsx populate-api.ts <pageId> <startPath> [sessionToken] [tmToken]
 */
import { prisma } from './src/lib/prisma.js';
import { runScraper } from './src/services/ai-pipeline/scraper.service.js';
import type { ApiCall, CapturedScreen } from './src/services/ai-pipeline/types.js';

const pageId = process.argv[2] ?? '';
const startPath = process.argv[3] ?? '/';
const sessionToken = process.argv[4] ?? '';
const tmToken = process.argv[5] ?? '';

const page = await prisma.page.findUnique({ where: { id: pageId } });
if (!page) {
  console.error(`No page with id ${pageId}`);
  process.exit(1);
}

const localStorage: Record<string, string> = {};
if (sessionToken) localStorage['token'] = sessionToken;
if (tmToken) localStorage['tm_token'] = tmToken;

const captured: CapturedScreen[] = [];
await runScraper({
  baseUrl: 'https://qa.twixor.digital',
  appName: 'Twixor',
  email: '',
  password: '',
  navDepth: 0,
  headed: false,
  session: { localStorage, startPath },
  signal: new AbortController().signal,
  saveScreenshot: async () => ({ imageUrl: null, mediaId: null }), // don't need new media here
  onScreen: (s) => captured.push(s),
  onLog: (level, msg) => console.log(`   [${level}] ${msg}`),
});

// Aggregate API calls across every captured screen in the flow, de-duped by
// method+path (so the full set of real endpoints the screen exercised is kept).
const seen = new Set<string>();
const calls: ApiCall[] = [];
for (const s of captured) {
  for (const c of s.apiCalls) {
    const k = `${c.method} ${c.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    calls.push(c);
  }
}

console.log(`\nCaptured screens: ${captured.map((s) => s.name).join(', ') || 'none'}`);
console.log(`API calls captured (deduped): ${calls.length}`);
for (const c of calls) console.log(`   ${c.method.padEnd(6)} ${c.path}${c.query ? '?' + c.query : ''}  → ${c.status ?? '-'}`);

if (!calls.length) {
  console.log('\nNo API calls captured — nothing to attach. (Auth may have failed for this route.)');
  process.exit(0);
}

await prisma.apiEndpoint.deleteMany({ where: { pageId } });
await prisma.apiEndpoint.createMany({
  data: calls.map((c, i) => ({
    pageId,
    method: c.method.toUpperCase().slice(0, 10),
    path: c.path,
    query: c.query,
    host: c.host,
    requestBody: c.requestBody,
    status: c.status,
    contentType: c.contentType,
    responseSample: c.responseSample,
    order: i,
  })),
});

console.log(`\n✓ Attached ${calls.length} API endpoint(s) to "${page.title}" (${page.routePath}).`);
process.exit(0);
