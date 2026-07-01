import { Router } from 'express';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app-error.js';
import { upload, uploadDir } from '../../lib/upload.js';
import { env } from '../../config/env.js';

export const mediaRouter: Router = Router();

function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
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

/** GET /api/admin/media?page=1&limit=20 */
mediaRouter.get('/', async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query['page'] ?? 1));
  const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? 20)));
  const skip = (page - 1) * limit;

  const [total, assets] = await Promise.all([
    prisma.mediaAsset.count(),
    prisma.mediaAsset.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        filename: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        publicUrl: true,
        altText: true,
        createdAt: true,
        editedAt: true,
      },
    }),
  ]);

  res.json({ data: assets, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
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

/** DELETE /api/admin/media/:id — removes DB record and file from disk */
mediaRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = p(req, 'id');
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset) throw AppError.notFound('Media asset not found');

  await prisma.mediaAsset.delete({ where: { id } });

  for (const filePath of [asset.storagePath, asset.originalStoragePath]) {
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch { /* noop */ }
    }
  }

  res.status(204).send();
});
