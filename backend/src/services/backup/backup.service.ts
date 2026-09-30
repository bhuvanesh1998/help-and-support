/**
 * backup.service.ts — Full content backup & restore as a portable .zip.
 * ───────────────────────────────────────────────────────────────────────────
 * The archive bundles a `backup.json` manifest (categories, pages + steps + API
 * endpoints, media metadata, widget config) and every uploaded image under
 * `uploads/`. Restoring writes the images back into the uploads directory and
 * upserts the content by natural keys (category name, page route), remapping
 * media IDs and rewriting image URLs to this server's origin.
 *
 * Deliberately NOT included (security / privacy):
 *   • users, AI credentials, MCP connector tokens (secrets)
 *   • analytics events (hashed PII)
 *   • api-endpoint requestBody / responseSample (may contain captured PII) —
 *     these aren't rendered anywhere, so dropping them keeps the export clean.
 */

import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { YOUTUBE_ID_RE } from '../../lib/youtube.js';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { uploadDir } from '../../lib/upload.js';
import { getWidgetConfig, sanitizeWidgetConfig, type WidgetConfigData } from '../widget/config.js';
import { IMAGE_EXTENSIONS, isSafeMediaFilename, resolveInUploads, uploadPathFor } from './safe-path.js';

const BACKUP_VERSION = 1;

/** Per-file and whole-archive caps on uncompressed image data during restore. */
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

interface BackupManifest {
  version: number;
  exportedAt: string;
  counts: { categories: number; pages: number; steps: number; apiEndpoints: number; media: number };
  categories: Array<{ name: string; order: number; icon: string | null; description: string | null }>;
  pages: Array<{
    routePath: string;
    slug: string | null;
    title: string;
    description: string | null;
    category: string | null;
    categoryOrder: number;
    metaTitle: string | null;
    metaDescription: string | null;
    keywords: string[];
    canonicalUrl: string | null;
    ogImageUrl: string | null;
    noIndex: boolean;
    structuredData: unknown;
    steps: Array<{ stepNumber: number; title: string; instructionsMd: string; imageUrl: string | null; mediaAssetId: string | null }>;
    apiEndpoints: Array<{ method: string; path: string; query: string | null; host: string | null; status: number | null; contentType: string | null; description: string | null; order: number }>;
    /** Step link is by stepNumber (ids are not portable). Absent in older backups. */
    videos?: Array<{ title: string; description: string | null; youtubeId: string; startSec: number; order: number; stepNumber: number | null }>;
  }>;
  media: Array<{ id: string; filename: string; originalName: string; mimeType: string; sizeBytes: number; width: number | null; height: number | null; altText: string | null; checksum: string | null }>;
  widgetConfig: WidgetConfigData;
}

/** Disk path for a stored media file (prefers the canonical uploads/<filename>). */
function mediaFilePath(filename: string, storagePath?: string | null): string | null {
  const canonical = uploadPathFor(filename);
  if (canonical && fs.existsSync(canonical)) return canonical;
  const stored = resolveInUploads(storagePath);
  if (stored && fs.existsSync(stored)) return stored;
  return null;
}

/** Rewrite any `/uploads/<file>` URL to this server's origin (cross-env safe). */
function normalizeUploadsUrl(url: string | null | undefined): string | null {
  if (!url) return url ?? null;
  const m = /\/uploads\/([^/?#]+)/.exec(url);
  return m ? `${env.publicBaseUrl}/uploads/${m[1]}` : url;
}

function stamp(): string {
  // Backend code (not a workflow) — real time is available.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export async function createBackup(): Promise<{ filename: string; buffer: Buffer }> {
  const [categories, pages, media, widgetConfig] = await Promise.all([
    prisma.category.findMany({ orderBy: [{ order: 'asc' }, { name: 'asc' }] }),
    prisma.page.findMany({
      orderBy: [{ categoryOrder: 'asc' }, { title: 'asc' }],
      include: {
        steps: { orderBy: { stepNumber: 'asc' } },
        apiEndpoints: { orderBy: { order: 'asc' } },
        videos: { orderBy: { order: 'asc' }, include: { step: { select: { stepNumber: true } } } },
      },
    }),
    prisma.mediaAsset.findMany({ orderBy: { createdAt: 'asc' } }),
    getWidgetConfig(),
  ]);

  let stepCount = 0;
  let apiCount = 0;
  const manifest: BackupManifest = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: { categories: categories.length, pages: pages.length, steps: 0, apiEndpoints: 0, media: media.length },
    categories: categories.map((c) => ({ name: c.name, order: c.order, icon: c.icon, description: c.description })),
    pages: pages.map((p) => {
      stepCount += p.steps.length;
      apiCount += p.apiEndpoints.length;
      return {
        routePath: p.routePath,
        slug: p.slug,
        title: p.title,
        description: p.description,
        category: p.category,
        categoryOrder: p.categoryOrder,
        metaTitle: p.metaTitle,
        metaDescription: p.metaDescription,
        keywords: p.keywords,
        canonicalUrl: p.canonicalUrl,
        ogImageUrl: p.ogImageUrl,
        noIndex: p.noIndex,
        structuredData: p.structuredData ?? null,
        steps: p.steps.map((s) => ({
          stepNumber: s.stepNumber,
          title: s.title,
          instructionsMd: s.instructionsMd,
          imageUrl: s.imageUrl,
          mediaAssetId: s.mediaAssetId,
        })),
        // requestBody / responseSample intentionally omitted (PII-safe).
        apiEndpoints: p.apiEndpoints.map((a) => ({
          method: a.method,
          path: a.path,
          query: a.query,
          host: a.host,
          status: a.status,
          contentType: a.contentType,
          description: a.description,
          order: a.order,
        })),
        videos: p.videos.map((v) => ({
          title: v.title,
          description: v.description,
          youtubeId: v.youtubeId,
          startSec: v.startSec,
          order: v.order,
          stepNumber: v.step?.stepNumber ?? null,
        })),
      };
    }),
    media: media.map((m) => ({
      id: m.id,
      filename: m.filename,
      originalName: m.originalName,
      mimeType: m.mimeType,
      sizeBytes: m.sizeBytes,
      width: m.width,
      height: m.height,
      altText: m.altText,
      checksum: m.checksum,
    })),
    widgetConfig,
  };
  manifest.counts.steps = stepCount;
  manifest.counts.apiEndpoints = apiCount;

  const zip = new AdmZip();
  zip.addFile('backup.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  for (const m of media) {
    if (!isSafeMediaFilename(m.filename)) continue;
    const filePath = mediaFilePath(m.filename, m.storagePath);
    if (filePath) zip.addLocalFile(filePath, 'uploads', m.filename);
  }

  return { filename: `help-assistant-backup-${stamp()}.zip`, buffer: zip.toBuffer() };
}

export interface RestoreSummary {
  categories: number;
  pages: number;
  steps: number;
  apiEndpoints: number;
  media: number;
  filesWritten: number;
}

export async function restoreBackup(buffer: Buffer): Promise<RestoreSummary> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new Error('Not a valid .zip archive');
  }

  const manifestEntry = zip.getEntry('backup.json');
  if (!manifestEntry) throw new Error('Invalid backup: backup.json is missing');

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as BackupManifest;
  } catch {
    throw new Error('Invalid backup: backup.json could not be parsed');
  }
  if (manifest.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version ${manifest.version} (expected ${BACKUP_VERSION})`);
  }

  // 1) Validate image entries up front (nothing is written yet). Only bare,
  //    safe image filenames are accepted, and uncompressed sizes are capped
  //    (from the header, before inflating) against zip bombs.
  const pendingFiles: Array<{ target: string; entry: AdmZip.IZipEntry }> = [];
  let totalBytes = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.startsWith('uploads/')) continue;
    const base = path.basename(entry.entryName);
    if (!isSafeMediaFilename(base) || !IMAGE_EXTENSIONS.has(path.extname(base).toLowerCase())) continue;
    const target = uploadPathFor(base);
    if (!target) continue;
    const size = entry.header.size;
    if (size > MAX_ENTRY_BYTES) {
      throw new Error(`Invalid backup: ${base} exceeds the ${MAX_ENTRY_BYTES / (1024 * 1024)} MB per-file limit`);
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Invalid backup: images exceed the 2 GB total limit');
    pendingFiles.push({ target, entry });
  }

  // 2) Restore content. One transaction so a failure leaves the DB unchanged;
  //    files are only written once it has committed.
  const summary: RestoreSummary = { categories: 0, pages: 0, steps: 0, apiEndpoints: 0, media: 0, filesWritten: 0 };

  await prisma.$transaction(
    async (tx) => {
      for (const c of manifest.categories ?? []) {
        if (!c.name) continue;
        await tx.category.upsert({
          where: { name: c.name },
          create: { name: c.name, order: c.order ?? 99, icon: c.icon ?? null, description: c.description ?? null },
          update: { order: c.order ?? 99, icon: c.icon ?? null, description: c.description ?? null },
        });
        summary.categories += 1;
      }

      const mediaIdMap = new Map<string, string>();
      for (const m of manifest.media ?? []) {
        // Untrusted manifest: skip anything that isn't a bare, safe image name.
        const storagePath = uploadPathFor(m.filename);
        if (!storagePath) continue;
        const publicUrl = `${env.publicBaseUrl}/uploads/${m.filename}`;
        const row = await tx.mediaAsset.upsert({
          where: { filename: m.filename },
          create: {
            filename: m.filename, originalName: m.originalName ?? m.filename, mimeType: m.mimeType ?? 'image/png',
            sizeBytes: m.sizeBytes ?? 0, width: m.width ?? null, height: m.height ?? null,
            storagePath, publicUrl, altText: m.altText ?? null, checksum: m.checksum ?? null,
          },
          update: {
            originalName: m.originalName ?? m.filename, mimeType: m.mimeType ?? 'image/png',
            sizeBytes: m.sizeBytes ?? 0, width: m.width ?? null, height: m.height ?? null,
            storagePath, publicUrl, altText: m.altText ?? null, checksum: m.checksum ?? null,
          },
        });
        if (m.id) mediaIdMap.set(m.id, row.id);
        summary.media += 1;
      }

      for (const p of manifest.pages ?? []) {
        if (!p.routePath) continue;

        // Avoid a unique-slug clash with a different existing page.
        let slug = p.slug ?? null;
        if (slug) {
          const clash = await tx.page.findFirst({ where: { slug, routePath: { not: p.routePath } } });
          if (clash) slug = null;
        }

        const data = {
          slug,
          title: p.title ?? p.routePath,
          description: p.description ?? null,
          category: p.category ?? null,
          categoryOrder: p.categoryOrder ?? 99,
          metaTitle: p.metaTitle ?? null,
          metaDescription: p.metaDescription ?? null,
          keywords: Array.isArray(p.keywords) ? p.keywords : [],
          canonicalUrl: p.canonicalUrl ?? null,
          ogImageUrl: p.ogImageUrl ?? null,
          noIndex: !!p.noIndex,
          structuredData:
            p.structuredData == null ? Prisma.JsonNull : (p.structuredData as Prisma.InputJsonValue),
        };

        const page = await tx.page.upsert({
          where: { routePath: p.routePath },
          create: { routePath: p.routePath, ...data },
          update: data,
        });

        // Replace children wholesale so the restore is idempotent.
        await tx.tutorialStep.deleteMany({ where: { pageId: page.id } });
        for (const s of p.steps ?? []) {
          await tx.tutorialStep.create({
            data: {
              pageId: page.id,
              stepNumber: s.stepNumber,
              title: s.title,
              instructionsMd: s.instructionsMd ?? '',
              imageUrl: normalizeUploadsUrl(s.imageUrl),
              mediaAssetId: s.mediaAssetId ? mediaIdMap.get(s.mediaAssetId) ?? null : null,
            },
          });
          summary.steps += 1;
        }

        await tx.apiEndpoint.deleteMany({ where: { pageId: page.id } });
        for (const a of p.apiEndpoints ?? []) {
          await tx.apiEndpoint.create({
            data: {
              pageId: page.id,
              method: a.method ?? 'GET',
              path: a.path ?? '',
              query: a.query ?? null,
              host: a.host ?? null,
              status: a.status ?? null,
              contentType: a.contentType ?? null,
              description: a.description ?? null,
              order: a.order ?? 0,
            },
          });
          summary.apiEndpoints += 1;
        }

        await tx.pageVideo.deleteMany({ where: { pageId: page.id } });
        if (p.videos?.length) {
          const stepIds = new Map(
            (await tx.tutorialStep.findMany({ where: { pageId: page.id }, select: { id: true, stepNumber: true } }))
              .map((s) => [s.stepNumber, s.id]),
          );
          for (const v of p.videos) {
            if (!YOUTUBE_ID_RE.test(v.youtubeId ?? '')) continue;
            await tx.pageVideo.create({
              data: {
                pageId: page.id,
                stepId: v.stepNumber != null ? stepIds.get(v.stepNumber) ?? null : null,
                title: v.title || 'Tutorial video',
                description: v.description ?? null,
                youtubeId: v.youtubeId,
                startSec: v.startSec ?? 0,
                order: v.order ?? 0,
              },
            });
          }
        }

        summary.pages += 1;
      }

      if (manifest.widgetConfig) {
        const w = sanitizeWidgetConfig(manifest.widgetConfig as unknown as Record<string, unknown>);
        await tx.widgetConfig.upsert({
          where: { name: 'default' },
          create: { name: 'default', ...w },
          update: { ...w },
        });
      }
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  // 3) Write the image files. On a write failure, remove what this restore
  //    wrote so no half-restored file set is left behind.
  fs.mkdirSync(uploadDir, { recursive: true });
  const written: string[] = [];
  const created: string[] = [];
  try {
    for (const { target, entry } of pendingFiles) {
      const data = entry.getData();
      // Header sizes can lie; re-check the inflated length.
      if (data.length > MAX_ENTRY_BYTES) throw new Error(`Invalid backup: ${path.basename(target)} is too large`);
      const existed = fs.existsSync(target);
      fs.writeFileSync(target, data);
      written.push(target);
      if (!existed) created.push(target);
    }
  } catch (err) {
    // Only files this restore created — never ones that pre-existed.
    for (const f of created) {
      try { fs.unlinkSync(f); } catch { /* noop */ }
    }
    throw err;
  }
  summary.filesWritten = written.length;

  return summary;
}
