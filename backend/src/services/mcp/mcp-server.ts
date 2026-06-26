/**
 * mcp-server.ts — In-app MCP server exposing the HelpAssistant pipeline as tools.
 * ───────────────────────────────────────────────────────────────────────────────
 * This is the INVERTED architecture (vs. the key-based AI Pipeline): the Claude
 * host (Claude Code / Desktop / claude.ai) runs inference on the user's own plan
 * and calls THESE tools to scrape and publish. No Anthropic API key lives here.
 *
 * Tools:
 *   list_pages       — existing tutorial pages (so Claude avoids duplicates)
 *   capture_screens  — Playwright-map the target app; returns screenshots so the
 *                      host's Claude can SEE each screen and draft tutorials itself
 *   get_screenshot   — re-fetch one screenshot by media id (capture truncates)
 *   publish_tutorial — create a page + ordered steps from Claude's draft
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { uploadDir } from '../../lib/upload.js';
import { logger } from '../../lib/logger.js';
import { runScraper } from '../ai-pipeline/scraper.service.js';
import type { CapturedScreen } from '../ai-pipeline/types.js';
import { dispatch, drainApiCalls, listSessions, resolveSessionId } from '../connector/bridge.js';

// ── Tool catalogue (also surfaced to the admin status endpoint) ──────────────

export const MCP_TOOLS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'list_pages', description: 'List existing user-manual pages so you avoid creating duplicates.' },
  { name: 'capture_screens', description: 'Map a target app with a headless browser and return screenshots of each screen.' },
  { name: 'get_screenshot', description: 'Re-fetch a single screenshot by its media id.' },
  { name: 'publish_tutorial', description: 'Create a user-manual page with ordered, Markdown step-by-step instructions.' },
  { name: 'list_connected_browsers', description: 'List live browser-extension sessions (the operator\'s real, logged-in browser).' },
  { name: 'capture_live_screen', description: 'Capture the current screen of a connected browser via the extension (CDP): screenshot + URL + API calls.' },
  { name: 'drive_action', description: 'Drive an action (navigate / click / type) in a connected browser via the extension.' },
];

// ── Recent-call telemetry (in-memory ring buffer for the admin screen) ───────

export interface McpCallLog {
  tool: string;
  ok: boolean;
  detail: string;
  at: string;
}

const RECENT: McpCallLog[] = [];

export function recentCalls(): McpCallLog[] {
  return [...RECENT].reverse();
}

function record(tool: string, ok: boolean, detail: string): void {
  RECENT.push({ tool, ok, detail, at: new Date().toISOString() });
  if (RECENT.length > 100) RECENT.shift();
}

// ── Screenshot persistence (mirror of the job-manager helper) ────────────────

async function saveScreenshot(
  userId: string | null,
  buffer: Buffer,
  screenId: string,
  name: string,
): Promise<{ imageUrl: string | null; mediaId: string | null }> {
  try {
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
        uploadedById: userId, // null for MCP-originated captures (not tied to an admin user)
      },
    });
    return { imageUrl: asset.publicUrl, mediaId: asset.id };
  } catch (err) {
    logger.warn('mcp: screenshot save failed', { error: (err as Error).message });
    return { imageUrl: null, mediaId: null };
  }
}

// ── Server factory (one per stateless request) ───────────────────────────────

const MAX_INLINE_IMAGES = 10;

export function buildMcpServer(userId: string | null): McpServer {
  const server = new McpServer({ name: 'helpassistant', version: '1.0.0' });

  // ── list_pages ─────────────────────────────────────────────────────────────
  server.registerTool(
    'list_pages',
    {
      title: 'List tutorial pages',
      description: 'List existing HelpAssistant tutorial pages (route, title, step count) so you avoid creating duplicates.',
      inputSchema: {},
    },
    async () => {
      const pages = await prisma.page.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { _count: { select: { steps: true } } },
      });
      record('list_pages', true, `${pages.length} pages`);
      const rows = pages.map((p) => ({ id: p.id, routePath: p.routePath, title: p.title, steps: p._count.steps }));
      return { content: [{ type: 'text', text: JSON.stringify({ totalPages: rows.length, pages: rows }, null, 2) }] };
    },
  );

  // ── capture_screens ──────────────────────────────────────────────────────────
  server.registerTool(
    'capture_screens',
    {
      title: 'Capture app screens',
      description:
        'Drive a browser against a target web app and capture each distinct screen (login, signup, forgot-password, then post-login pages if credentials are given). Returns the screenshots so you can read each screen and write the tutorial yourself. Screenshots are also saved as media assets; reference their mediaId in publish_tutorial. Three ways to reach authed screens: (1) email+password for auto-login; (2) headed=true to solve a captcha/2FA by hand in a visible window; (3) a pre-authenticated session (cookies/localStorage from a logged-in browser) to skip login and captcha entirely.',
      inputSchema: {
        url: z.string().describe('Base URL of the target app, e.g. https://qa.twixor.digital'),
        email: z.string().optional().describe('Demo login email (omit to capture only pre-auth screens)'),
        password: z.string().optional().describe('Demo login password'),
        navDepth: z.number().int().min(0).max(3).optional().describe('Post-login crawl depth (0 = auth screens only, default 1)'),
        appName: z.string().optional().describe('Display name of the app'),
        headed: z.boolean().optional().describe('Open a visible browser so a human can solve a captcha / finish login by hand (server runs it on its own machine).'),
        manualTimeoutSec: z.number().int().min(30).max(600).optional().describe('When headed, seconds to wait for the human to finish login (default 180).'),
        session: z
          .object({
            cookies: z
              .array(
                z.object({
                  name: z.string(),
                  value: z.string(),
                  domain: z.string().optional(),
                  path: z.string().optional(),
                }),
              )
              .optional(),
            localStorage: z.record(z.string(), z.string()).optional(),
            startPath: z.string().optional(),
          })
          .optional()
          .describe(
            'Pre-authenticated session to skip login + captcha entirely: session cookies and/or localStorage tokens copied from a browser already logged into the target app. Optionally startPath (where to land, e.g. /dashboard).',
          ),
      },
    },
    async ({ url, email, password, navDepth, appName, headed, manualTimeoutSec, session }) => {
      let baseUrl: string;
      try {
        const u = new URL(url);
        baseUrl = `${u.protocol}//${u.host}`;
      } catch {
        record('capture_screens', false, 'invalid url');
        return { isError: true, content: [{ type: 'text', text: `Invalid url: ${url}` }] };
      }

      const manualTimeoutMs = (manualTimeoutSec ?? 180) * 1000;
      // Bound the whole capture so a stalled (or unattended headed) run can't hang
      // the request forever: the crawl budget plus the manual-login window.
      const ac = new AbortController();
      const killer = setTimeout(() => ac.abort(), manualTimeoutMs + 180_000);

      const screens: CapturedScreen[] = [];
      try {
        const { groups } = await runScraper({
          baseUrl,
          appName: appName?.trim() || new URL(baseUrl).hostname,
          email: email?.trim() ?? '',
          password: password ?? '',
          navDepth: navDepth ?? 1,
          headed: headed ?? false,
          manualTimeoutMs,
          session,
          signal: ac.signal,
          saveScreenshot: (buffer, screenId, name) => saveScreenshot(userId, buffer, screenId, name),
          onScreen: (s) => screens.push(s),
          onLog: () => {},
        });

        const summary = {
          appName: appName?.trim() || new URL(baseUrl).hostname,
          baseUrl,
          totalScreens: screens.length,
          groups: groups.map((g) => ({ name: g.name, routePath: g.routePath, screenIds: g.screenIds })),
          screens: screens.map((s) => ({
            id: s.id,
            name: s.name,
            group: s.group,
            url: s.url,
            mediaId: s.mediaId,
            imageUrl: s.imageUrl,
            heading: s.dom.heading,
            apiCalls: s.apiCalls,
          })),
        };

        const content: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string }
        > = [{ type: 'text', text: JSON.stringify(summary, null, 2) }];

        let shown = 0;
        for (const s of screens) {
          if (shown >= MAX_INLINE_IMAGES) break;
          if (!s.base64) continue;
          content.push({ type: 'text', text: `Screen ${s.id} — ${s.name} (mediaId: ${s.mediaId ?? 'n/a'})` });
          content.push({ type: 'image', data: s.base64, mimeType: 'image/png' });
          shown++;
        }
        if (screens.length > shown) {
          content.push({
            type: 'text',
            text: `(${screens.length - shown} more screenshots not inlined — call get_screenshot with their mediaId to view.)`,
          });
        }

        record('capture_screens', true, `${screens.length} screens from ${baseUrl}`);
        return { content };
      } catch (err) {
        record('capture_screens', false, (err as Error).message);
        return { isError: true, content: [{ type: 'text', text: `Capture failed: ${(err as Error).message}` }] };
      } finally {
        clearTimeout(killer);
      }
    },
  );

  // ── get_screenshot ───────────────────────────────────────────────────────────
  server.registerTool(
    'get_screenshot',
    {
      title: 'Get one screenshot',
      description: 'Re-fetch a single captured screenshot by its media id (from capture_screens).',
      inputSchema: { mediaId: z.string().describe('The mediaId returned by capture_screens') },
    },
    async ({ mediaId }) => {
      const asset = await prisma.mediaAsset.findUnique({ where: { id: mediaId } });
      if (!asset || !fs.existsSync(asset.storagePath)) {
        record('get_screenshot', false, mediaId);
        return { isError: true, content: [{ type: 'text', text: `No screenshot for mediaId ${mediaId}` }] };
      }
      const data = fs.readFileSync(asset.storagePath).toString('base64');
      record('get_screenshot', true, mediaId);
      return {
        content: [
          { type: 'text', text: `${asset.altText ?? asset.originalName} (${asset.publicUrl})` },
          { type: 'image', data, mimeType: asset.mimeType },
        ],
      };
    },
  );

  // ── publish_tutorial ─────────────────────────────────────────────────────────
  server.registerTool(
    'publish_tutorial',
    {
      title: 'Publish a tutorial',
      description:
        'Create a HelpAssistant tutorial page with ordered, Markdown step instructions. Reference a screenshot per step via mediaId (from capture_screens). Use **bold** for UI element names in instructionsMd.',
      inputSchema: {
        routePath: z.string().describe('Route the help applies to, e.g. /login'),
        title: z.string().describe('Action-oriented tutorial title'),
        description: z.string().optional().describe('1-2 sentence summary'),
        steps: z
          .array(
            z.object({
              stepNumber: z.number().int().min(1),
              title: z.string(),
              instructionsMd: z.string(),
              mediaId: z.string().optional().describe('Screenshot media id for this step'),
            }),
          )
          .min(1)
          .describe('Ordered steps'),
        apiEndpoints: z
          .array(
            z.object({
              method: z.string().describe('HTTP method, e.g. GET / POST'),
              path: z.string().describe('Endpoint path, e.g. /api/chat/active'),
              query: z.string().optional(),
              host: z.string().optional().describe('Host if cross-origin to the app'),
              requestBody: z.string().optional(),
              status: z.number().int().optional(),
              contentType: z.string().optional(),
              responseSample: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .optional()
          .describe('API reference for this screen (e.g. the apiCalls returned by capture_screens). Rendered in the manual\'s API tab.'),
      },
    },
    async ({ routePath, title, description, steps, apiEndpoints }) => {
      try {
        const existing = await prisma.page.findUnique({ where: { routePath: routePath.trim() } });
        if (existing) {
          record('publish_tutorial', false, `route in use: ${routePath}`);
          return {
            isError: true,
            content: [{ type: 'text', text: `A page already exists for route "${routePath}" (id ${existing.id}). Pick a different route or update it.` }],
          };
        }

        const page = await prisma.page.create({
          data: { routePath: routePath.trim(), title: title.trim(), description: description ?? null },
        });

        const mediaIds = steps.map((s) => s.mediaId).filter((m): m is string => !!m);
        const assets = mediaIds.length
          ? await prisma.mediaAsset.findMany({ where: { id: { in: mediaIds } } })
          : [];
        const urlByMedia = new Map(assets.map((a) => [a.id, a.publicUrl]));

        for (const s of steps) {
          await prisma.tutorialStep.create({
            data: {
              pageId: page.id,
              stepNumber: s.stepNumber,
              title: s.title.trim(),
              instructionsMd: s.instructionsMd,
              mediaAssetId: s.mediaId ?? null,
              imageUrl: s.mediaId ? urlByMedia.get(s.mediaId) ?? null : null,
            },
          });
        }

        if (apiEndpoints?.length) {
          await prisma.apiEndpoint.createMany({
            data: apiEndpoints.map((e, i) => ({
              pageId: page.id,
              method: e.method.toUpperCase().slice(0, 10),
              path: e.path,
              query: e.query ?? null,
              host: e.host ?? null,
              requestBody: e.requestBody ?? null,
              status: e.status ?? null,
              contentType: e.contentType ?? null,
              responseSample: e.responseSample ?? null,
              description: e.description ?? null,
              order: i,
            })),
          });
        }

        const viewUrl = `${env.corsOrigin.split(',')[0] ?? ''}/admin/pages/${page.id}`;
        record('publish_tutorial', true, `${title} (${steps.length} steps)`);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ pageId: page.id, routePath: page.routePath, steps: steps.length, viewUrl }, null, 2) },
          ],
        };
      } catch (err) {
        record('publish_tutorial', false, (err as Error).message);
        return { isError: true, content: [{ type: 'text', text: `Publish failed: ${(err as Error).message}` }] };
      }
    },
  );

  // ── list_connected_browsers ────────────────────────────────────────────────
  server.registerTool(
    'list_connected_browsers',
    {
      title: 'List connected browsers',
      description:
        'List live browser-extension sessions (the operator\'s real, logged-in browser). Use a session id with capture_live_screen / drive_action.',
      inputSchema: {},
    },
    async () => {
      const list = listSessions();
      record('list_connected_browsers', true, `${list.length} session(s)`);
      return { content: [{ type: 'text', text: JSON.stringify({ sessions: list }, null, 2) }] };
    },
  );

  // ── capture_live_screen ────────────────────────────────────────────────────
  server.registerTool(
    'capture_live_screen',
    {
      title: 'Capture the live browser screen',
      description:
        'Capture the current screen of a connected browser via the extension (CDP): a pixel-perfect screenshot (saved as a media asset) plus the URL, title, and the API calls the screen recently made. Use the mediaId in publish_tutorial.',
      inputSchema: {
        sessionId: z.string().optional().describe('Target browser session (from list_connected_browsers). Omit to use the most-recent one.'),
        name: z.string().optional().describe('A label for the captured screen, e.g. "Chat — Conversation".'),
        highlight: z
          .object({
            selector: z.string().optional().describe('CSS selector of the element to highlight'),
            text: z.string().optional().describe('Visible text of the element to highlight (button/tab/label)'),
            placeholder: z.string().optional().describe('Input placeholder text to highlight a field'),
            label: z.string().optional().describe('Caption shown on the red highlight callout'),
          })
          .optional()
          .describe('Draw a red highlight box (+ label) around one element before capturing — for per-step screenshots.'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(30000)
          .optional()
          .describe('Milliseconds to wait for the screen’s data to finish loading before capturing (e.g. 15000 for dashboards/reports).'),
      },
    },
    async ({ sessionId, name, highlight, waitMs }) => {
      const sid = resolveSessionId(sessionId);
      if (!sid) {
        record('capture_live_screen', false, 'no session');
        return { isError: true, content: [{ type: 'text', text: 'No connected browser. Open the extension and click Connect.' }] };
      }
      try {
        const params: Record<string, unknown> = {};
        if (highlight) params.highlight = highlight;
        if (typeof waitMs === 'number') params.waitMs = waitMs;
        // Allow time for the settle wait (up to 30s) plus capture overhead.
        const result = (await dispatch(sid, 'captureScreen', params, 60_000)) as {
          screenshotBase64?: string;
          url?: string;
          title?: string;
          apiCalls?: unknown[];
          highlighted?: boolean;
        };
        const label = (name ?? result.title ?? 'Screen').slice(0, 80);
        let mediaId: string | null = null;
        let imageUrl: string | null = null;
        if (result.screenshotBase64) {
          const buf = Buffer.from(result.screenshotBase64, 'base64');
          const saved = await saveScreenshot(userId, buf, 'live', label);
          mediaId = saved.mediaId;
          imageUrl = saved.imageUrl;
        }
        const apiCalls = Array.isArray(result.apiCalls) ? result.apiCalls : drainApiCalls(sid);
        record('capture_live_screen', true, `${result.url ?? ''}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ url: result.url, title: result.title, mediaId, imageUrl, highlighted: result.highlighted ?? null, apiCalls }, null, 2),
            },
            ...(result.screenshotBase64
              ? [{ type: 'image' as const, data: result.screenshotBase64, mimeType: 'image/png' }]
              : []),
          ],
        };
      } catch (err) {
        record('capture_live_screen', false, (err as Error).message);
        return { isError: true, content: [{ type: 'text', text: `Capture failed: ${(err as Error).message}` }] };
      }
    },
  );

  // ── drive_action ───────────────────────────────────────────────────────────
  server.registerTool(
    'drive_action',
    {
      title: 'Drive an action in the browser',
      description:
        'Perform an action in a connected browser via the extension (CDP): navigate to a URL, click an element (by CSS selector or visible text), or type into a field. Returns the resulting URL so you can chain steps and map flows.',
      inputSchema: {
        sessionId: z.string().optional().describe('Target browser session. Omit to use the most-recent one.'),
        action: z.enum(['navigate', 'click', 'type']).describe('What to do'),
        url: z.string().optional().describe('For navigate: the URL or path to open'),
        selector: z.string().optional().describe('For click/type: a CSS selector'),
        text: z.string().optional().describe('For click: visible text to match; for type: the text to enter'),
      },
    },
    async ({ sessionId, action, url, selector, text }) => {
      const sid = resolveSessionId(sessionId);
      if (!sid) {
        record('drive_action', false, 'no session');
        return { isError: true, content: [{ type: 'text', text: 'No connected browser. Open the extension and click Connect.' }] };
      }
      try {
        const result = await dispatch(sid, action, { url, selector, text });
        record('drive_action', true, `${action} ${url ?? selector ?? text ?? ''}`);
        return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
      } catch (err) {
        record('drive_action', false, (err as Error).message);
        return { isError: true, content: [{ type: 'text', text: `Action failed: ${(err as Error).message}` }] };
      }
    },
  );

  return server;
}
