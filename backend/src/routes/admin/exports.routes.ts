/**
 * exports.routes.ts — Start/track/download server-generated tutorial exports.
 * Mounted at /api/admin/exports (JWT-protected).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { AppError } from '../../utils/app-error.js';
import {
  startExport,
  listExports,
  getExport,
  deleteExport,
  exportFilePath,
  type ExportFormat,
} from '../../services/export/export.service.js';
import { createBackup, restoreBackup } from '../../services/backup/backup.service.js';
import { backupUpload } from '../../lib/upload.js';

export const exportsRouter: Router = Router();

function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

// ── Full backup / restore (registered before /:id so 'backup' isn't an id) ──

/** GET /api/admin/exports/backup — download all content + images as a .zip. */
exportsRouter.get('/backup', async (_req: Request, res: Response) => {
  const { filename, buffer } = await createBackup();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
});

/** POST /api/admin/exports/import — restore from a backup .zip (field "file"). */
exportsRouter.post('/import', backupUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw AppError.badRequest('No backup file uploaded (field "file")');
  try {
    const summary = await restoreBackup(req.file.buffer);
    res.json({ ok: true, summary });
  } catch (err) {
    throw AppError.badRequest((err as Error).message);
  }
});

/** POST /api/admin/exports — start an export. Body: { format, pageIds? } */
exportsRouter.post('/', async (req: Request, res: Response) => {
  const body = req.body as { format?: unknown; pageIds?: unknown };
  const format = body.format === 'pdf' || body.format === 'doc' ? (body.format as ExportFormat) : null;
  if (!format) throw AppError.badRequest("format must be 'pdf' or 'doc'");

  const pageIds = Array.isArray(body.pageIds)
    ? (body.pageIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;

  try {
    const { id } = await startExport({ format, pageIds, userId: req.user!.id });
    res.status(202).json({ id });
  } catch (err) {
    throw AppError.badRequest((err as Error).message);
  }
});

/** GET /api/admin/exports — recent exports + status. */
exportsRouter.get('/', async (_req: Request, res: Response) => {
  res.json({ data: await listExports() });
});

/** GET /api/admin/exports/:id — single export status. */
exportsRouter.get('/:id', async (req: Request, res: Response) => {
  const row = await getExport(p(req, 'id'));
  if (!row) throw AppError.notFound('Export not found');
  res.json(row);
});

/** GET /api/admin/exports/:id/download — stream the generated file. */
exportsRouter.get('/:id/download', async (req: Request, res: Response) => {
  const row = await getExport(p(req, 'id'));
  if (!row) throw AppError.notFound('Export not found');
  if (row.status !== 'ready') throw AppError.badRequest(`Export is ${row.status}, not ready`);

  const path = exportFilePath(row);
  if (!existsSync(path)) throw AppError.notFound('Export file missing — regenerate it');

  const downloadName = row.filename ?? `export-${row.id}.${row.format}`;
  res.setHeader('Content-Type', row.format === 'pdf' ? 'application/pdf' : 'application/msword');
  res.download(path, downloadName);
});

/** DELETE /api/admin/exports/:id */
exportsRouter.delete('/:id', async (req: Request, res: Response) => {
  await deleteExport(p(req, 'id'));
  res.status(204).send();
});
