/**
 * Reusable: drive the connected browser to a screen (click a sidebar label, or
 * navigate to a path) and capture it live. Prints a JSON manifest including the
 * local screenshot path so it can be read + documented.
 *
 * Usage: tsx connector-capture.ts "<label or /path>"
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { revealToken } from './src/services/mcp/connector.service.js';

const arg = process.argv[2] ?? '';
if (!arg) { console.error('pass a sidebar label or /path'); process.exit(1); }

const token = await revealToken();
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'connector-capture', version: '1.0.0' });
await client.connect(transport);
const txt = (r: any) => r.content?.find((c: any) => c.type === 'text')?.text ?? '';

if (arg.startsWith('/')) {
  await client.callTool({ name: 'drive_action', arguments: { action: 'navigate', url: arg } }, undefined, { timeout: 30000 });
} else {
  await client.callTool({ name: 'drive_action', arguments: { action: 'click', text: arg } }, undefined, { timeout: 30000 });
}

const cap = JSON.parse(txt(await client.callTool(
  { name: 'capture_live_screen', arguments: { name: arg, waitMs: 12000 } },
  undefined,
  { timeout: 90000 },
)));

const file = cap.imageUrl ? 'uploads/' + String(cap.imageUrl).split('/uploads/')[1] : null;
console.log(JSON.stringify({ url: cap.url, title: cap.title, mediaId: cap.mediaId, imageUrl: cap.imageUrl, file, apiCalls: cap.apiCalls ?? [] }, null, 2));

await client.close();
process.exit(0);
