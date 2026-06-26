/**
 * One-off: capture the Live Chat Conversation console (via session injection +
 * sidebar click) and publish a tutorial for it. Reuses the real persistence so
 * the screenshot becomes a proper MediaAsset, exactly like the MCP pipeline.
 */
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from './src/lib/prisma.js';
import { env } from './src/config/env.js';
import { uploadDir } from './src/lib/upload.js';
import { runScraper } from './src/services/ai-pipeline/scraper.service.js';
import type { CapturedScreen } from './src/services/ai-pipeline/types.js';

const sessionToken = process.argv[2] ?? '';
const tmToken = process.argv[3] ?? '';
const ROUTE = '/chat/conversation';

async function saveScreenshot(buffer: Buffer, screenId: string, name: string) {
  const filename = `${randomUUID()}.png`;
  const filePath = path.join(uploadDir, filename);
  fs.writeFileSync(filePath, buffer);
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const publicUrl = `${env.publicBaseUrl}/uploads/${filename}`;
  const asset = await prisma.mediaAsset.create({
    data: {
      filename,
      originalName: `${screenId}-${name}.png`.replace(/[^a-zA-Z0-9.\-_ ]/g, '').slice(0, 120),
      mimeType: 'image/png',
      sizeBytes: buffer.length,
      storagePath: filePath,
      publicUrl,
      checksum,
      altText: name,
      uploadedById: null,
    },
  });
  return { imageUrl: asset.publicUrl, mediaId: asset.id };
}

// 1) Guard against a duplicate route.
const existing = await prisma.page.findUnique({ where: { routePath: ROUTE } });
if (existing) {
  console.log(`A page already exists for ${ROUTE} (id ${existing.id}). Aborting to avoid duplicate.`);
  process.exit(0);
}

// 2) Capture the console screen.
const captured: CapturedScreen[] = [];
await runScraper({
  baseUrl: 'https://qa.twixor.digital',
  appName: 'Twixor',
  email: '',
  password: '',
  navDepth: 0,
  headed: false,
  session: { localStorage: { token: sessionToken, tm_token: tmToken }, startPath: ROUTE },
  signal: new AbortController().signal,
  saveScreenshot,
  onScreen: (s) => captured.push(s),
  onLog: (level, msg) => console.log(`   [${level}] ${msg}`),
});

const hero = captured.find((s) => s.url.includes('/chat/conversation')) ?? captured[0];
if (!hero || !hero.mediaId) {
  console.error('No usable screenshot captured (mediaId missing). Aborting publish.');
  process.exit(1);
}
console.log(`\nHero screenshot → mediaId ${hero.mediaId}  url ${hero.url}`);

// 3) Publish the tutorial.
const steps = [
  {
    stepNumber: 1,
    title: 'Open the Conversation console',
    instructionsMd:
      'In the left **Module** menu, click **Chat** → **Conversation**. The Live Chat agent console opens at `/chat/conversation`, where incoming customer chats are routed to you in real time.',
    mediaId: hero.mediaId,
  },
  {
    stepNumber: 2,
    title: 'Set your availability',
    instructionsMd:
      'Use the **Online / Offline** toggle at the top of the chat panel. Switch to **Online** to start receiving live chats; set **Offline** to stop new chats from being routed to you while you finish other work.',
    mediaId: undefined as string | undefined,
  },
  {
    stepNumber: 3,
    title: 'Work the conversation queue',
    instructionsMd:
      'The conversation list groups chats under three tabs:\n\n- **Active** — chats currently assigned to you and in progress.\n- **Suspended** — chats you have temporarily paused.\n- **Closed** — chats that have been resolved.\n\nWhen no chats are waiting you will see **No Available Chats**.',
    mediaId: undefined as string | undefined,
  },
  {
    stepNumber: 4,
    title: 'Navigate the Chat submenu',
    instructionsMd:
      'The **Chat** module submenu gives you the full live-chat toolset:\n\n- **Conversation** — the agent console (this screen).\n- **Analytics** and **Real-time monitor** — live and historical performance.\n- **Chat history** — past conversations.\n- **Just In Time**, **Meetings**, **Call Patch**, **Upcoming Calls** — engagement and call tools.\n- **Consent Report**, **Call Patch Report**, **Inbound Report** — compliance and call reporting.',
    mediaId: undefined as string | undefined,
  },
  {
    stepNumber: 5,
    title: 'Review customer context while you chat',
    instructionsMd:
      'The right-hand panel keeps customer context in view for the selected conversation:\n\n- **Customer Information** — profile and channel details.\n- **Additional Notes** — internal notes you add during the chat.\n- **Chat Summary** — a running summary of the conversation.\n\nExpand each section to read or update it without leaving the console.',
    mediaId: undefined as string | undefined,
  },
];

const page = await prisma.page.create({
  data: {
    routePath: ROUTE,
    title: 'Manage Live Chats in the Conversation Console',
    description:
      'Open the Chat → Conversation console to receive and reply to live customer chats, set your availability, and review customer context in real time.',
  },
});

for (const s of steps) {
  await prisma.tutorialStep.create({
    data: {
      pageId: page.id,
      stepNumber: s.stepNumber,
      title: s.title,
      instructionsMd: s.instructionsMd,
      mediaAssetId: s.mediaId ?? null,
      imageUrl: s.mediaId ? hero.imageUrl ?? null : null,
    },
  });
}

console.log(`\n✓ Published "${page.title}"`);
console.log(`   pageId   ${page.id}`);
console.log(`   route    ${page.routePath}`);
console.log(`   steps    ${steps.length}`);
console.log(`   admin    /admin/pages/${page.id}`);
process.exit(0);
