import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [, , mcpToken, sessionToken, startPath = '/dashboard', navDepthArg, tmToken] = process.argv;
const navDepth = Number(navDepthArg ?? 0);

const localStorageEntries = { token: sessionToken };
if (tmToken) localStorageEntries.tm_token = tmToken;

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
});
const client = new Client({ name: 'twixor-doc-run', version: '1.0.0' });

try {
  await client.connect(transport);
  console.log('✓ connected');
  const res = await client.callTool(
    {
      name: 'capture_screens',
      arguments: {
        url: 'https://qa.twixor.digital',
        appName: 'Twixor',
        navDepth,
        session: { localStorage: localStorageEntries, startPath },
      },
    },
    undefined,
    { timeout: 180000 },
  );
  if (res.isError) {
    console.error('✗ tool error:', res.content?.find((c) => c.type === 'text')?.text);
    process.exit(1);
  }
  const summary = JSON.parse(res.content.find((c) => c.type === 'text').text);
  console.log(`✓ captured ${summary.totalScreens} screens (groups: ${summary.groups.map((g) => g.name).join(', ')})`);
  for (const s of summary.screens) {
    console.log(`   ${s.id} | ${s.name} | ${s.url}`);
    console.log(`        file: uploads/${s.imageUrl?.split('/uploads/')[1]}  mediaId: ${s.mediaId}`);
  }
  await client.close();
  process.exit(0);
} catch (err) {
  console.error('✗ FAIL:', err?.message ?? err);
  process.exit(1);
}
