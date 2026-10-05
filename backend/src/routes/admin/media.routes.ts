import { Router } from 'express';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app-error.js';
import { upload, uploadDir } from '../../lib/upload.js';
import { env } from '../../config/env.js';

export const mediaRouter: Router = Router();

/** Trashed assets are permanently purged this many days after deletion. */
const TRASH_RETENTION_DAYS = 30;

function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** Most ids a single bulk request may name. */
const BULK_MAX_IDS = 1000;
/** Zip download caps — the archive is built in memory. */
const DOWNLOAD_MAX_FILES = 2000;
const DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

/** Category filter value for images not used in any categorised guide. */
const NO_CATEGORY = '__none__';
const NO_CATEGORY_FOLDER = 'Not in a guide';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MediaView = 'library' | 'trash';

function parseView(v: unknown): MediaView {
  return v === 'trash' ? 'trash' : 'library';
}

/** Parse an optional ISO date bound; rejects garbage instead of silently ignoring it. */
function parseDate(v: unknown, field: string): Date | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw AppError.badRequest(`${field} must be an ISO date string`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw AppError.badRequest(`${field} is not a valid date`);
  return d;
}

/**
 * Where-clause for a media view, optionally narrowed to an upload-date range
 * and a guide category. `from`/`to` are inclusive instants — the client sends
 * local start/end of day. An image belongs to a category when a step on a page
 * in that category uses it; `__none__` matches images in no category.
 */
function viewWhere(
  view: MediaView,
  fromRaw?: unknown,
  toRaw?: unknown,
  categoryRaw?: unknown,
): Prisma.MediaAssetWhereInput {
  const from = parseDate(fromRaw, 'from');
  const to = parseDate(toRaw, 'to');
  if (from && to && from > to) throw AppError.badRequest('"from" must be on or before "to"');
  const where: Prisma.MediaAssetWhereInput = { deletedAt: view === 'trash' ? { not: null } : null };
  if (from || to) where.createdAt = { ...(from && { gte: from }), ...(to && { lte: to }) };

  const category = typeof categoryRaw === 'string' ? categoryRaw.trim() : '';
  if (category === NO_CATEGORY) where.steps = { none: { page: { category: { not: null } } } };
  else if (category) where.steps = { some: { page: { category } } };
  return where;
}

/** Query/body filter fields shared by every list, bulk and download call. */
function filterWhere(view: MediaView, src: Record<string, unknown>): Prisma.MediaAssetWhereInput {
  return viewWhere(view, src['from'], src['to'], src['category']);
}

/** Validate a list of asset ids from a request body (array) or query string (comma-separated). */
function parseIds(v: unknown): string[] {
  const list = typeof v === 'string' ? v.split(',') : v;
  if (!Array.isArray(list)) throw AppError.badRequest('ids must be an array');
  const ids = [
    ...new Set(
      list.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean),
    ),
  ];
  if (!ids.length) throw AppError.badRequest('No ids given');
  if (ids.length > BULK_MAX_IDS) throw AppError.badRequest(`At most ${BULK_MAX_IDS} items per request`);
  if (ids.some((id) => !UUID_RE.test(id))) throw AppError.badRequest('ids must be UUIDs');
  return ids;
}

/**
 * Resolve a bulk target: explicit `ids`, or `all: true` meaning every asset in
 * `view` matching the `from`/`to` range. Always scoped to the view, so a stale
 * selection can never act on items that have since moved.
 */
function bulkWhere(src: Record<string, unknown>): Prisma.MediaAssetWhereInput {
  const base = filterWhere(parseView(src['view']), src);
  if (src['all'] === true || src['all'] === 'true') return base;
  return { ...base, id: { in: parseIds(src['ids']) } };
}

/** Zip entry name that is filesystem-safe and unique within the archive. */
function uniqueEntryName(name: string, used: Set<string>): string {
  const clean = path.basename(name).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim() || 'image';
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let candidate = clean;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Remove an asset's files from disk (render + preserved original). */
function removeAssetFiles(asset: { storagePath: string; originalStoragePath: string | null }): void {
  for (const filePath of [asset.storagePath, asset.originalStoragePath]) {
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch { /* noop */ }
    }
  }
}

/**
 * Lazy sweep: permanently delete trashed assets past the retention window.
 * Runs opportunistically whenever a media list is requested — no scheduler
 * required, and self-healing across restarts/scale-out.
 */
async function purgeExpiredTrash(): Promise<void> {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await prisma.mediaAsset.findMany({
    where: { deletedAt: { lt: cutoff } },
    select: { id: true, storagePath: true, originalStoragePath: true },
  });
  if (!expired.length) return;

  await prisma.mediaAsset.deleteMany({ where: { id: { in: expired.map((a) => a.id) } } });
  for (const asset of expired) removeAssetFiles(asset);
}

/** POST /api/admin/media — upload a single image */
mediaRouter.post('/', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw AppError.badRequest('No file uploaded. Use form-data field "file".');

  const filePath = path.join(uploadDir, req.file.filename);
  const fileBuffer = fs.readFileSync(filePath);
  const checksum = createHash('sha256').update(fileBuffer).digest('hex');
  const publicUrl = `${env.publicBaseUrl}/uploads/${req.file.filename}`;

  const asset = await prisma.mediaAsset.create({
    data: {
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      storagePath: filePath,
      publicUrl,
      checksum,
      uploadedById: req.user!.id,
    },
  });

  res.status(201).json({ asset });
});

const LIST_SELECT = {
  id: true,
  filename: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  publicUrl: true,
  altText: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
} as const;

/** GET /api/admin/media?page=1&limit=20&from&to — live assets only (trash excluded). */
mediaRouter.get('/', async (req: Request, res: Response) => {
  await purgeExpiredTrash();

  const page = Math.max(1, Number(req.query['page'] ?? 1));
  const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? 20)));
  const skip = (page - 1) * limit;
  const where = filterWhere('library', req.query as Record<string, unknown>);

  const [total, assets] = await Promise.all([
    prisma.mediaAsset.count({ where }),
    prisma.mediaAsset.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: LIST_SELECT,
    }),
  ]);

  res.json({ data: assets, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
});

/**
 * GET /api/admin/media/trash?page=1&limit=20&from&to — trashed assets, most recently
 * deleted first. Registered before `/:id` so "trash" is not read as an id.
 */
mediaRouter.get('/trash', async (req: Request, res: Response) => {
  await purgeExpiredTrash();

  const page = Math.max(1, Number(req.query['page'] ?? 1));
  const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? 20)));
  const skip = (page - 1) * limit;
  const where = filterWhere('trash', req.query as Record<string, unknown>);

  const [total, assets] = await Promise.all([
    prisma.mediaAsset.count({ where }),
    prisma.mediaAsset.findMany({
      where,
      skip,
      take: limit,
      orderBy: { deletedAt: 'desc' },
      select: LIST_SELECT,
    }),
  ]);

  res.json({
    data: assets,
    meta: { total, page, limit, pages: Math.ceil(total / limit), retentionDays: TRASH_RETENTION_DAYS },
  });
});

/** Guide categories of each asset, via the steps that use it (live pages only). */
async function categoriesByAsset(assetIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (let i = 0; i < assetIds.length; i += BULK_MAX_IDS) {
    const steps = await prisma.tutorialStep.findMany({
      where: { mediaAssetId: { in: assetIds.slice(i, i + BULK_MAX_IDS) }, page: { category: { not: null } } },
      select: { mediaAssetId: true, page: { select: { category: true } } },
    });
    for (const st of steps) {
      if (!st.mediaAssetId || !st.page.category) continue;
      const set = out.get(st.mediaAssetId) ?? new Set<string>();
      set.add(st.page.category);
      out.set(st.mediaAssetId, set);
    }
  }
  return out;
}

/**
 * GET /api/admin/media/categories?view=library&from&to — guide categories that
 * have images in this view, with image counts, plus the uncategorised count.
 * Lives here (not /categories) so it needs only `media.view`.
 */
mediaRouter.get('/categories', async (req: Request, res: Response) => {
  const view = parseView(req.query['view']);
  const base = viewWhere(view, req.query['from'], req.query['to']);
  const assets = await prisma.mediaAsset.findMany({ where: base, select: { id: true } });
  const byAsset = await categoriesByAsset(assets.map((a) => a.id));

  const counts = new Map<string, number>();
  for (const cats of byAsset.values()) for (const c of cats) counts.set(c, (counts.get(c) ?? 0) + 1);

  // Order like the help centre: Category.order, then name; unknown names last.
  const defined = await prisma.category.findMany({ select: { name: true, order: true } });
  const order = new Map(defined.map((c) => [c.name, c.order]));
  const data = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (order.get(a.name) ?? 1e6) - (order.get(b.name) ?? 1e6) || a.name.localeCompare(b.name));

  res.json({ data, uncategorised: assets.length - byAsset.size, noCategoryKey: NO_CATEGORY });
});

/**
 * GET /api/admin/media/download?view=library&ids=a,b — or `all=true&from&to&category` —
 * a zip of the selected images. `groupBy=category` puts each image in a folder
 * per guide category (an image used in two categories appears in both).
 * A GET so it needs only `media.view`; registered before `/:id`.
 */
mediaRouter.get('/download', async (req: Request, res: Response) => {
  const query = req.query as Record<string, unknown>;
  const assets = await prisma.mediaAsset.findMany({
    where: bulkWhere(query),
    orderBy: { createdAt: 'desc' },
    take: DOWNLOAD_MAX_FILES + 1,
    select: { id: true, originalName: true, filename: true, storagePath: true, sizeBytes: true },
  });
  if (!assets.length) throw AppError.notFound('No matching images');
  if (assets.length > DOWNLOAD_MAX_FILES) {
    throw AppError.badRequest(`Too many images — download at most ${DOWNLOAD_MAX_FILES} at a time`);
  }
  if (assets.reduce((sum, a) => sum + a.sizeBytes, 0) > DOWNLOAD_MAX_BYTES) {
    throw AppError.badRequest('Selection is larger than 500 MB — download it in smaller batches');
  }

  // Folder(s) per asset when grouping; a category filter narrows to that folder.
  const grouped = query['groupBy'] === 'category';
  const onlyCategory = typeof query['category'] === 'string' && query['category'] !== NO_CATEGORY
    ? query['category'] : '';
  const byAsset = grouped ? await categoriesByAsset(assets.map((a) => a.id)) : new Map<string, Set<string>>();
  const foldersFor = (id: string): string[] => {
    if (!grouped) return [''];
    const cats = [...(byAsset.get(id) ?? [])].filter((c) => !onlyCategory || c === onlyCategory);
    return cats.length ? cats.map((c) => `${uniqueEntryName(c, new Set())}/`) : [`${NO_CATEGORY_FOLDER}/`];
  };

  const root = path.resolve(uploadDir) + path.sep;
  const zip = new AdmZip();
  const usedByFolder = new Map<string, Set<string>>();
  let added = 0;
  const missing: string[] = [];
  for (const a of assets) {
    // storagePath is server-generated, but never read outside the upload dir.
    const resolved = path.resolve(a.storagePath);
    if (!resolved.startsWith(root) || !fs.existsSync(resolved)) {
      missing.push(a.originalName || a.filename);
      continue;
    }
    const data = fs.readFileSync(resolved);
    for (const folder of foldersFor(a.id)) {
      const used = usedByFolder.get(folder) ?? new Set<string>();
      usedByFolder.set(folder, used);
      const entryName = folder + uniqueEntryName(a.originalName || a.filename, used);
      zip.addFile(entryName, data);
      // Images are already compressed — store them instead of re-deflating.
      const entry = zip.getEntry(entryName);
      if (entry) entry.header.method = 0;
    }
    added++;
  }
  if (!added) throw AppError.notFound('The selected image files are missing on the server');
  // Say what was skipped rather than silently shipping a short archive.
  if (missing.length) {
    zip.addFile(
      'MISSING-FILES.txt',
      Buffer.from(
        `These images are in the library but their files were not found on the server:\n\n${missing.join('\n')}\n`,
        'utf8',
      ),
    );
  }

  const buffer = zip.toBuffer();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="media-${new Date().toISOString().slice(0, 10)}.zip"`,
  );
  res.send(buffer);
});

/**
 * POST /api/admin/media/bulk — act on many assets at once.
 * body: { action: 'trash' | 'restore' | 'purge', view: 'library' | 'trash',
 *         ids?: string[], all?: boolean, from?: ISO, to?: ISO }
 * `all: true` targets every asset in `view` matching the date range.
 */
mediaRouter.post('/bulk', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = body['action'];
  const view = parseView(body['view']);
  const where = bulkWhere(body);

  if (action === 'trash') {
    if (view !== 'library') throw AppError.badRequest('Only library items can be moved to the trash');
    const { count } = await prisma.mediaAsset.updateMany({ where, data: { deletedAt: new Date() } });
    res.json({ count });
    return;
  }

  if (action === 'restore') {
    if (view !== 'trash') throw AppError.badRequest('Only trashed items can be restored');
    const { count } = await prisma.mediaAsset.updateMany({ where, data: { deletedAt: null } });
    res.json({ count });
    return;
  }

  if (action === 'purge') {
    const targets = await prisma.mediaAsset.findMany({
      where,
      select: { id: true, storagePath: true, originalStoragePath: true },
    });
    // Chunked so a large "all matching" purge stays inside bind-parameter limits.
    for (let i = 0; i < targets.length; i += BULK_MAX_IDS) {
      const chunk = targets.slice(i, i + BULK_MAX_IDS).map((t) => t.id);
      await prisma.mediaAsset.deleteMany({ where: { id: { in: chunk } } });
    }
    for (const t of targets) removeAssetFiles(t);
    res.json({ count: targets.length });
    return;
  }

  throw AppError.badRequest('action must be "trash", "restore" or "purge"');
});

/** GET /api/admin/media/:id */
mediaRouter.get('/:id', async (req: Request, res: Response) => {
  const id = p(req, 'id');
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset) throw AppError.notFound('Media asset not found');
  res.json({ asset });
});

/** PATCH /api/admin/media/:id — update alt text */
mediaRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = p(req, 'id');
  const existing = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Media asset not found');

  const body = req.body as { altText?: unknown };
  if (typeof body.altText !== 'string') throw AppError.badRequest('altText must be a string');

  const updated = await prisma.mediaAsset.update({
    where: { id },
    data: { altText: body.altText },
  });

  res.json({ asset: updated });
});

/**
 * POST /api/admin/media/:id/annotate — save an annotated render.
 * Non-destructive: the untouched base is preserved on first edit, the previous
 * render is replaced, editable annotations (JSON) are stored, and any steps that
 * use this asset get their denormalised imageUrl refreshed.
 * form-data: file (rendered PNG), annotations (JSON string), width, height, altText?
 */
mediaRouter.post('/:id/annotate', upload.single('file'), async (req: Request, res: Response) => {
  const id = p(req, 'id');
  if (!req.file) throw AppError.badRequest('No rendered image uploaded. Use form-data field "file".');

  const newFilePath = path.join(uploadDir, req.file.filename);
  const cleanupUpload = () => { if (fs.existsSync(newFilePath)) { try { fs.unlinkSync(newFilePath); } catch { /* noop */ } } };

  const existing = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!existing) { cleanupUpload(); throw AppError.notFound('Media asset not found'); }

  const body = req.body as { annotations?: unknown; width?: unknown; height?: unknown; altText?: unknown };

  let annotations: Prisma.InputJsonValue | undefined;
  if (typeof body.annotations === 'string' && body.annotations.trim()) {
    try { annotations = JSON.parse(body.annotations) as Prisma.InputJsonValue; }
    catch { cleanupUpload(); throw AppError.badRequest('annotations must be valid JSON'); }
  }

  const width = Number(body.width) || existing.width || null;
  const height = Number(body.height) || existing.height || null;

  const buf = fs.readFileSync(newFilePath);
  const checksum = createHash('sha256').update(buf).digest('hex');
  const newPublicUrl = `${env.publicBaseUrl}/uploads/${req.file.filename}`;

  // Preserve the untouched original the first time this asset is edited.
  const originalStoragePath = existing.originalStoragePath ?? existing.storagePath;
  const originalUrl = existing.originalUrl ?? existing.publicUrl;

  // Replace the previous *render* on disk — but never the preserved original.
  if (existing.storagePath !== originalStoragePath && fs.existsSync(existing.storagePath)) {
    try { fs.unlinkSync(existing.storagePath); } catch { /* noop */ }
  }

  const updated = await prisma.mediaAsset.update({
    where: { id },
    data: {
      filename: req.file.filename,
      mimeType: 'image/png',
      sizeBytes: req.file.size,
      storagePath: newFilePath,
      publicUrl: newPublicUrl,
      checksum,
      width,
      height,
      originalStoragePath,
      originalUrl,
      editedAt: new Date(),
      ...(annotations !== undefined && { annotations }),
      ...(typeof body.altText === 'string' && { altText: body.altText }),
    },
  });

  // Keep tutorial steps that embed this image pointing at the new render.
  await prisma.tutorialStep.updateMany({ where: { mediaAssetId: id }, data: { imageUrl: newPublicUrl } });

  res.json({ asset: updated });
});

/**
 * POST /api/admin/media/:id/restore — bring a trashed asset back to the library.
 */
mediaRouter.post('/:id/restore', async (req: Request, res: Response) => {
  const id = p(req, 'id');
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset) throw AppError.notFound('Media asset not found');
  if (!asset.deletedAt) throw AppError.badRequest('Asset is not in the trash');

  const restored = await prisma.mediaAsset.update({
    where: { id },
    data: { deletedAt: null },
    select: LIST_SELECT,
  });

  res.json({ asset: restored });
});

/**
 * DELETE /api/admin/media/:id/permanent — irreversibly remove the DB record and
 * files from disk. Used from the trash view.
 */
mediaRouter.delete('/:id/permanent', async (req: Request, res: Response) => {
  const id = p(req, 'id');
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset) throw AppError.notFound('Media asset not found');

  await prisma.mediaAsset.delete({ where: { id } });
  removeAssetFiles(asset);

  res.status(204).send();
});

/**
 * DELETE /api/admin/media/:id — move the asset to the trash (soft delete).
 * Files stay on disk (so any steps still referencing the image keep working)
 * until it is restored, permanently deleted, or purged after 30 days.
 */
mediaRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = p(req, 'id');
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset) throw AppError.notFound('Media asset not found');

  if (!asset.deletedAt) {
    await prisma.mediaAsset.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  res.status(204).send();
});
