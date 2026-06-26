/**
 * Re-capture a manual's steps with per-step highlighted screenshots.
 * Navigates to the screen once, then for each step draws a red highlight box
 * around the relevant element and captures — attaching the shot to that step.
 *
 * Requires the extension to be RELOADED with the highlight build.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { revealToken } from './src/services/mcp/connector.service.js';
import { prisma } from './src/lib/prisma.js';

// ── Config: which manual + per-step highlight targets ────────────────────────
const CONFIG = {
  pageId: '6c2ae719-488c-4251-9593-6a312b88a98c', // /chat/history
  route: '/chat/history',
  steps: [
    { stepNumber: 1, text: 'Chat history', label: 'Open Chat history' },
    { stepNumber: 2, text: 'From', label: 'Set the date range' },
    { stepNumber: 3, text: 'Status', label: 'Apply filters' },
    { stepNumber: 4, text: 'Search', label: 'Search' },
    { stepNumber: 5, text: 'Export', label: 'Export' },
  ] as Array<{ stepNumber: number; selector?: string; text?: string; placeholder?: string; label: string }>,
};

const token = await revealToken();
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'recapture-steps', version: '1.0.0' });
await client.connect(transport);
const txt = (r: any) => r.content?.find((c: any) => c.type === 'text')?.text ?? '';
const parse = (r: any, what: string) => {
  const t = txt(r);
  try { return JSON.parse(t); } catch { console.error(`\n⚠ ${what}: ${t}`); process.exit(2); }
};

const sessions = parse(await client.callTool({ name: 'list_connected_browsers', arguments: {} }), 'list_connected_browsers');
if (!sessions.sessions?.length) {
  console.error('\n⚠ No connected browser. Reload the extension (chrome://extensions → ↻) and ensure the dot is green, then re-run.');
  process.exit(2);
}
console.log('connected:', sessions.sessions[0].url);

console.log(`navigating to ${CONFIG.route}…`);
await client.callTool({ name: 'drive_action', arguments: { action: 'navigate', url: CONFIG.route } }, undefined, { timeout: 30000 });

let first = true;
for (const s of CONFIG.steps) {
  const highlight: any = { label: s.label };
  if (s.selector) highlight.selector = s.selector;
  if (s.text) highlight.text = s.text;
  if (s.placeholder) highlight.placeholder = s.placeholder;

  const cap = parse(await client.callTool(
    { name: 'capture_live_screen', arguments: { name: `${CONFIG.route} step ${s.stepNumber}`, highlight } },
    undefined,
    { timeout: 60000 },
  ), `capture step ${s.stepNumber}`);

  if (first) {
    first = false;
    if (cap.highlighted === null || cap.highlighted === undefined) {
      console.error('\n⚠ The extension has NOT been reloaded with the highlight build.');
      console.error('  Open chrome://extensions → click ↻ Reload on "HelpAssistant Connector", then re-run.');
      process.exit(2);
    }
  }

  await prisma.tutorialStep.updateMany({
    where: { pageId: CONFIG.pageId, stepNumber: s.stepNumber },
    data: { mediaAssetId: cap.mediaId, imageUrl: cap.imageUrl },
  });
  console.log(`step ${s.stepNumber}: highlighted=${cap.highlighted} → ${cap.imageUrl}`);
}

console.log('\n✓ Re-captured all steps with highlights.');
await client.close();
process.exit(0);
