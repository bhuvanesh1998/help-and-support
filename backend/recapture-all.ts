/**
 * Re-capture EVERY step of the manuals matching a route prefix with per-step
 * highlighted screenshots. The highlight target for each step is auto-derived
 * from the first **bold** UI term in its Markdown (e.g. **Search**, **Export**).
 *
 * Usage: tsx recapture-all.ts <routePrefix>   (default: /chat)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { revealToken } from './src/services/mcp/connector.service.js';
import { prisma } from './src/lib/prisma.js';

const PREFIX = process.argv[2] ?? '/chat';
const WAIT_MS = Math.min(Math.max(Number(process.argv[3]) || 15000, 0), 30000); // settle before each shot

/** First bold UI term → highlight target (drop route paths and menu prefixes). */
function targetFor(md: string): string | null {
  const matches = [...md.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!.replace(/`/g, '').trim());
  for (let t of matches) {
    if (t.includes('→')) t = t.split('→').pop()!.trim(); // "Chat → Meetings" → "Meetings"
    if (!t || t.startsWith('/')) continue;
    if (t.length > 32) continue; // skip long phrases that won't match an element
    return t;
  }
  return null;
}

const pages = await prisma.page.findMany({
  where: { routePath: { startsWith: PREFIX } },
  include: { steps: { orderBy: { stepNumber: 'asc' } } },
  orderBy: { routePath: 'asc' },
});
console.log(`${pages.length} manuals under ${PREFIX}`);

const token = await revealToken();
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'recapture-all', version: '1.0.0' });
await client.connect(transport);
const txt = (r: any) => r.content?.find((c: any) => c.type === 'text')?.text ?? '';
const parse = (r: any, what: string) => {
  const t = txt(r);
  try { return JSON.parse(t); } catch { console.error(`⚠ ${what}: ${t}`); return null; }
};

let checkedBuild = false;
for (const page of pages) {
  console.log(`\n▸ ${page.routePath} — ${page.title}`);
  await client.callTool({ name: 'drive_action', arguments: { action: 'navigate', url: page.routePath } }, undefined, { timeout: 30000 });

  for (const step of page.steps) {
    const target = targetFor(step.instructionsMd);
    const highlight: any = { label: target ?? step.title };
    if (target) highlight.text = target;
    const cap = parse(await client.callTool(
      { name: 'capture_live_screen', arguments: { name: `${page.title} — ${step.title}`, highlight, waitMs: WAIT_MS } },
      undefined, { timeout: 90000 },
    ), `capture ${page.routePath} step ${step.stepNumber}`);
    if (!cap) continue;

    if (!checkedBuild) {
      checkedBuild = true;
      if (cap.highlighted === null || cap.highlighted === undefined) {
        console.error('\n⚠ Extension highlight build not active — reload the extension from F:\\twixor_docs\\inapp-help-assistant\\extension and Connect, then re-run.');
        process.exit(2);
      }
    }
    await prisma.tutorialStep.updateMany({
      where: { pageId: page.id, stepNumber: step.stepNumber },
      data: { mediaAssetId: cap.mediaId, imageUrl: cap.imageUrl },
    });
    console.log(`   step ${step.stepNumber} [${target ?? '—'}] hl=${cap.highlighted}`);
  }
}

console.log('\n✓ Done.');
await client.close();
process.exit(0);
