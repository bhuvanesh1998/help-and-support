/**
 * export.service.ts — Server-side Word/PDF export of selected tutorials.
 * ───────────────────────────────────────────────────────────────────────
 * Generation is async (kicked off, status tracked in the `exports` table) so
 * large batches don't block the request. PDF is rendered with headless
 * Chromium (JS disabled — the document is data only); "Word" is an HTML .doc
 * that Word opens with formatting intact. Screenshots are embedded as data
 * URIs so the file is self-contained.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';
import { prisma } from '../../lib/prisma.js';
import { uploadDir } from '../../lib/upload.js';
import { logger } from '../../lib/logger.js';

export type ExportFormat = 'pdf' | 'doc';

const exportsDir = join(uploadDir, 'exports');

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mimeFor(path: string): string {
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

interface StepLike {
  stepNumber: number;
  title: string;
  instructionsMd: string;
  imageUrl: string | null;
  mediaAssetId: string | null;
}

/** Resolve a step's screenshot to a base64 data URI (or null). */
async function imageDataUri(step: StepLike): Promise<string | null> {
  let path: string | null = null;
  if (step.mediaAssetId) {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: step.mediaAssetId } });
    if (asset) path = asset.storagePath;
  }
  if (!path && step.imageUrl) {
    const fn = step.imageUrl.split('/uploads/')[1];
    if (fn) path = join(uploadDir, fn);
  }
  if (!path || !existsSync(path)) return null;
  try {
    const buf = await readFile(path);
    return `data:${mimeFor(path)};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

interface PageLike {
  title: string;
  routePath: string;
  description: string | null;
  category?: string | null;
  categoryOrder?: number;
  steps: StepLike[];
}

async function buildHtml(
  pages: PageLike[],
  onProgress?: (done: number) => void,
): Promise<string> {
  // Organise the document by module category, then title.
  const ordered = [...pages].sort(
    (a, b) =>
      (a.categoryOrder ?? 99) - (b.categoryOrder ?? 99) ||
      (a.category ?? '').localeCompare(b.category ?? '') ||
      a.title.localeCompare(b.title),
  );

  const sections: string[] = [];
  const toc: { id: string; title: string; category: string }[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const page = ordered[i]!;
    const id = `sec-${i + 1}`;
    const steps: string[] = [];
    for (const step of page.steps) {
      const body = String(marked.parse(step.instructionsMd ?? ''));
      const img = await imageDataUri(step);
      steps.push(`
        <section class="step">
          <h2><span class="num">${step.stepNumber}</span> ${escapeHtml(step.title)}</h2>
          <div class="md">${body}</div>
          ${img ? `<figure><img src="${img}" alt="${escapeHtml(step.title)}" /></figure>` : ''}
        </section>`);
    }

    sections.push(`
      <article class="tutorial" id="${id}">
        <div class="route">${escapeHtml(page.routePath)}</div>
        <h1>${escapeHtml(page.title)}</h1>
        ${page.description ? `<p class="desc">${escapeHtml(page.description)}</p>` : ''}
        <hr/>
        ${steps.join('\n')}
      </article>`);

    toc.push({ id, title: page.title, category: page.category ?? 'General' });
    onProgress?.(sections.length);
  }

  // Contents page, grouped by category, with a per-manual page number
  // (Chromium computes target-counter() during PDF pagination).
  const byCat = new Map<string, typeof toc>();
  for (const e of toc) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category)!.push(e);
  }
  const tocHtml = [...byCat.entries()]
    .map(
      ([cat, items]) => `
      <div class="toc-cat">${escapeHtml(cat)}</div>
      ${items
        .map(
          (it) =>
            `<a class="toc-row" href="#${it.id}"><span class="toc-title">${escapeHtml(it.title)}</span><span class="toc-dots"></span><span class="toc-pg"></span></a>`,
        )
        .join('')}`,
    )
    .join('');

  const generatedOn = new Date().toISOString().slice(0, 10);

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>HelpAssistant tutorials</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a202c; line-height: 1.6; margin: 0; padding: 32px; }
  .cover { text-align: center; padding: 80px 0 40px; }
  .cover h1 { font-size: 30px; margin: 0 0 8px; }
  .cover p { color: #667085; margin: 0; }
  .tutorial { page-break-before: always; padding-top: 8px; }
  .route { display: inline-block; font-family: 'Consolas', monospace; font-size: 12px; color: #0f766e; background: #f0fdfa; padding: 2px 10px; border-radius: 12px; }
  .toc { page-break-before: always; }
  .toc h2 { font-size: 22px; margin: 0 0 14px; }
  .toc-cat { font-weight: 700; color: #0d9488; margin: 16px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  .toc-row { display: flex; align-items: baseline; gap: 6px; text-decoration: none; color: #1a202c; font-size: 13px; padding: 3px 0; }
  .toc-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 78%; }
  .toc-dots { flex: 1; border-bottom: 1px dotted #cbd5e1; transform: translateY(-3px); }
  .toc-pg::after { content: target-counter(attr(href url), page); color: #475467; font-variant-numeric: tabular-nums; }
  h1 { font-size: 24px; margin: 10px 0 6px; }
  .desc { color: #475467; margin: 0 0 12px; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 14px 0 22px; }
  .step { margin: 0 0 26px; page-break-inside: avoid; }
  .step h2 { font-size: 17px; margin: 0 0 8px; }
  .num { display: inline-block; width: 24px; height: 24px; line-height: 24px; text-align: center; border-radius: 50%; background: #0d9488; color: #fff; font-size: 13px; margin-right: 8px; }
  .md { margin: 0 0 10px; }
  .md code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-family: 'Consolas', monospace; font-size: 0.9em; }
  .md pre { background: #f3f4f6; padding: 12px; border-radius: 6px; overflow-x: auto; }
  figure { margin: 10px 0 0; }
  img { max-width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; }
</style></head>
<body>
  <div class="cover">
    <h1>HelpAssistant — User Manuals</h1>
    <p>${pages.length} manual${pages.length === 1 ? '' : 's'} · generated ${generatedOn}</p>
  </div>
  <section class="toc">
    <h2>Contents</h2>
    ${tocHtml}
  </section>
  ${sections.join('\n')}
</body></html>`;
}

async function renderPdf(html: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    // JS disabled: the document is static data — nothing to execute.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%; font-size:8px; color:#94a3b8; padding:0 12mm; display:flex; justify-content:space-between;">' +
        '<span>HelpAssistant — User Manuals</span>' +
        '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>' +
        '</div>',
      margin: { top: '14mm', bottom: '18mm', left: '12mm', right: '12mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}

export function exportFilePath(row: { id: string; format: string }): string {
  return join(exportsDir, `${row.id}.${row.format}`);
}

async function runExport(id: string, format: ExportFormat, pageIds: string[]): Promise<void> {
  try {
    const pages = await prisma.page.findMany({
      where: { id: { in: pageIds } },
      include: { steps: { orderBy: { stepNumber: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });

    // Throttle progress writes to ~20 updates max for large batches.
    const total = pages.length;
    const every = Math.max(1, Math.floor(total / 20));
    const html = await buildHtml(pages, (done) => {
      if (done % every === 0 || done === total) {
        void prisma.export.update({ where: { id }, data: { progress: done } }).catch(() => {});
      }
    });
    const buffer = format === 'pdf' ? await renderPdf(html) : Buffer.from(html, 'utf8');

    await mkdir(exportsDir, { recursive: true });
    await writeFile(join(exportsDir, `${id}.${format}`), buffer);

    const friendly = `helpassistant-tutorials-${pageIds.length}.${format === 'pdf' ? 'pdf' : 'doc'}`;
    await prisma.export.update({
      where: { id },
      data: {
        status: 'ready',
        progress: pageIds.length,
        filename: friendly,
        sizeBytes: buffer.length,
        completedAt: new Date(),
      },
    });
    logger.info('export ready', { id, format, pages: pageIds.length, bytes: buffer.length });
  } catch (err) {
    logger.error('export failed', { id, error: (err as Error).message });
    await prisma.export
      .update({ where: { id }, data: { status: 'error', error: (err as Error).message } })
      .catch(() => {});
  }
}

export async function startExport(input: {
  format: ExportFormat;
  pageIds?: string[];
  userId: string;
}): Promise<{ id: string }> {
  const ids =
    input.pageIds && input.pageIds.length
      ? input.pageIds
      : (await prisma.page.findMany({ select: { id: true } })).map((p) => p.id);

  if (!ids.length) throw new Error('No tutorials to export.');

  const row = await prisma.export.create({
    data: {
      format: input.format,
      status: 'pending',
      title: `${ids.length} tutorial${ids.length === 1 ? '' : 's'}`,
      pageCount: ids.length,
      requestedById: input.userId,
    },
  });

  void runExport(row.id, input.format, ids);
  return { id: row.id };
}

export async function listExports() {
  return prisma.export.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
}

export async function getExport(id: string) {
  return prisma.export.findUnique({ where: { id } });
}

export async function deleteExport(id: string): Promise<void> {
  const row = await prisma.export.findUnique({ where: { id } });
  if (!row) return;
  await prisma.export.delete({ where: { id } });
  const { unlink } = await import('node:fs/promises');
  await unlink(join(exportsDir, `${id}.${row.format}`)).catch(() => {});
}
