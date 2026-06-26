/**
 * Crawl a module: click each submenu label (passed as args), capture each screen
 * live, and write a manifest (PII-safe — endpoints without response bodies).
 * Usage: tsx crawl-module.ts "Activity List" "Approved" "Rejected" ...
 */
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { revealToken } from './src/services/mcp/connector.service.js';

const LABELS = process.argv.slice(2);
if (!LABELS.length) { console.error('pass submenu labels'); process.exit(1); }

const token = await revealToken();
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'crawl-module', version: '1.0.0' });
await client.connect(transport);
const txt = (r: any) => r.content?.find((c: any) => c.type === 'text')?.text ?? '';
const parse = (r: any) => { try { return JSON.parse(txt(r)); } catch { return null; } };

const out: any[] = [];
for (const label of LABELS) {
  await client.callTool({ name: 'drive_action', arguments: { action: 'click', text: label } }, undefined, { timeout: 30000 });
  const cap = parse(await client.callTool({ name: 'capture_live_screen', arguments: { name: label, waitMs: 12000 } }, undefined, { timeout: 90000 }));
  if (!cap) { console.log(`${label.padEnd(26)} → capture failed`); out.push({ label, error: true }); continue; }
  const file = cap.imageUrl ? 'uploads/' + String(cap.imageUrl).split('/uploads/')[1] : null;
  const apiCalls = (cap.apiCalls ?? []).map((c: any) => ({ method: c.method, path: c.path, query: c.query, status: c.status }));
  out.push({ label, url: cap.url, mediaId: cap.mediaId, imageUrl: cap.imageUrl, file, apiCalls });
  console.log(`${label.padEnd(26)} → ${cap.url}  | ${apiCalls.length} calls | ${file}`);
}

writeFileSync('crawl-manifest.json', JSON.stringify(out, null, 2));
console.log('\nmanifest → crawl-manifest.json');
await client.close();
process.exit(0);
