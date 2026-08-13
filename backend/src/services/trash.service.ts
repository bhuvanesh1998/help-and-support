/**
 * trash.service.ts — Deleting is reversible for 30 days.
 * ─────────────────────────────────────────────────────
 * Two mechanisms sit behind one screen:
 *
 *   • **Captured** types (voiceover scripts, pages, categories) have their rows
 *     serialised into `trash_items` and removed from their own tables. Every
 *     existing list, count and join therefore stays correct with no
 *     `deletedAt IS NULL` filter to remember — a filter missed in one query is
 *     exactly how "deleted" content reappears.
 *   • **Flagged** types — media assets — already had a soft-delete of their own
 *     (`media_assets.deletedAt`), because a still may be referenced by a page
 *     that is still published. That is left alone and adapted into this view
 *     rather than rewritten, so nothing that works today breaks.
 *
 * Files on disk are never touched when something is trashed; they are removed
 * only on a permanent delete or when the retention window expires. Restoring
 * would be pointless if the media had already gone.
 */

import fs from 'node:fs';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../utils/app-error.js';

/** How long a deleted item stays restorable. */
export const TRASH_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type TrashEntityType = 'voiceoverScript' | 'page' | 'category' | 'media';

export interface TrashEntry {
  /** Opaque handle for restore/purge; not the original record's id. */
  id: string;
  entityType: TrashEntityType;
  typeLabel: string;
  icon: string;
  label: string;
  description: string;
  deletedAt: string;
  expiresAt: string;
  /** Whole days left before the sweeper removes it; 0 means "today". */
  daysLeft: number;
}

interface TrashAdapter {
  type: TrashEntityType;
  typeLabel: string;
  icon: string;
  /** Permission needed to see, restore and purge this type. */
  permission: string;
  list(): Promise<TrashEntry[]>;
  restore(handle: string): Promise<void>;
  purge(handle: string): Promise<void>;
  /**
   * Permanently remove whatever is past its retention.
   *
   * No cutoff is passed in: captured types store an absolute `expiresAt` while
   * media stores `deletedAt`, so one shared cutoff would be wrong for one of
   * them — and it was, purging captured items 60 days late.
   */
  sweep(): Promise<number>;
}

function daysLeft(expiresAt: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / DAY_MS));
}

function expiryFrom(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS);
}

function unlinkQuietly(filePath: string | null | undefined): void {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* best effort — a stray file is harmless next to a lost restore */
  }
}

// ── Captured types ──────────────────────────────────────────────────────────

/** Serialise a record (and children) into the trash, then remove the original. */
async function capture(input: {
  entityType: TrashEntityType;
  entityId: string;
  label: string;
  description: string;
  payload: Prisma.InputJsonValue;
  userId?: string | null;
  remove: () => Promise<void>;
}): Promise<void> {
  const deletedAt = new Date();

  await prisma.trashItem.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      label: input.label,
      description: input.description,
      payload: input.payload,
      deletedById: input.userId ?? null,
      deletedAt,
      expiresAt: expiryFrom(deletedAt),
    },
  });

  // Written first, removed second: if the removal fails the item is still listed
  // in the trash, which is recoverable. The reverse order could lose it.
  await input.remove();
}

async function requireItem(handle: string, type: TrashEntityType) {
  const item = await prisma.trashItem.findUnique({ where: { id: handle } });
  if (!item || item.entityType !== type) throw AppError.notFound('That trash item is gone');
  return item;
}

function capturedList(
  type: TrashEntityType,
  typeLabel: string,
  icon: string,
): () => Promise<TrashEntry[]> {
  return async () => {
    const rows = await prisma.trashItem.findMany({
      where: { entityType: type },
      orderBy: { deletedAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      entityType: type,
      typeLabel,
      icon,
      label: row.label,
      description: row.description,
      deletedAt: row.deletedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      daysLeft: daysLeft(row.expiresAt),
    }));
  };
}

// ── Voiceover scripts ───────────────────────────────────────────────────────

interface ScriptPayload {
  script: Record<string, unknown>;
  segments: Record<string, unknown>[];
  versions: Record<string, unknown>[];
  frames: Record<string, unknown>[];
  audio: Record<string, unknown>[];
}

export async function trashVoiceoverScript(id: string, userId?: string | null): Promise<boolean> {
  const script = await prisma.voiceoverScript.findUnique({ where: { id } });
  if (!script) return false;

  const [segments, versions, frames, audio] = await Promise.all([
    prisma.voiceoverSegment.findMany({ where: { scriptId: id } }),
    prisma.voiceoverSegmentVersion.findMany({ where: { scriptId: id } }),
    prisma.voiceoverFrame.findMany({ where: { scriptId: id } }),
    prisma.voiceoverAudio.findMany({ where: { scriptId: id } }),
  ]);

  const clips = audio.filter((a) => a.kind === 'segment').length;
  await capture({
    entityType: 'voiceoverScript',
    entityId: id,
    label: `${script.appName} — ${script.tone}`,
    description: [
      script.videoName,
      `${segments.length} lines`,
      clips > 0 ? `${clips} takes` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    payload: { script, segments, versions, frames, audio } as unknown as Prisma.InputJsonValue,
    userId,
    // Children cascade from the script row. The MP3s and frame stills stay on
    // disk, which is what makes the restore complete rather than silent.
    remove: async () => {
      await prisma.voiceoverScript.delete({ where: { id } });
    },
  });

  return true;
}

const voiceoverScriptAdapter: TrashAdapter = {
  type: 'voiceoverScript',
  typeLabel: 'Voiceover script',
  icon: 'graphic_eq',
  permission: 'voiceover.view',
  list: capturedList('voiceoverScript', 'Voiceover script', 'graphic_eq'),

  async restore(handle) {
    const item = await requireItem(handle, 'voiceoverScript');
    const data = item.payload as unknown as ScriptPayload;

    await prisma.$transaction(async (tx) => {
      // The parent first, then children, or the foreign keys reject the inserts.
      await tx.voiceoverScript.create({ data: data.script as never });
      if (data.segments.length) {
        await tx.voiceoverSegment.createMany({ data: data.segments as never });
      }
      if (data.versions.length) {
        await tx.voiceoverSegmentVersion.createMany({ data: data.versions as never });
      }
      if (data.frames.length) {
        await tx.voiceoverFrame.createMany({ data: data.frames as never });
      }
      if (data.audio.length) {
        await tx.voiceoverAudio.createMany({ data: data.audio as never });
      }
      await tx.trashItem.delete({ where: { id: handle } });
    });
  },

  async purge(handle) {
    const item = await requireItem(handle, 'voiceoverScript');
    const data = item.payload as unknown as ScriptPayload;

    // Narration MP3s are ours alone. Frame stills are MediaAssets the library
    // owns and may be used by a manual page, so they are left behind.
    for (const clip of data.audio) unlinkQuietly(clip['storagePath'] as string);
    await prisma.trashItem.delete({ where: { id: handle } });
  },

  async sweep() {
    const expired = await prisma.trashItem.findMany({
      where: { entityType: 'voiceoverScript', expiresAt: { lt: new Date() } },
      select: { id: true },
    });
    // Purged one by one rather than in bulk: each has MP3s to unlink.
    for (const row of expired) await voiceoverScriptAdapter.purge(row.id);
    return expired.length;
  },
};

// ── Pages ───────────────────────────────────────────────────────────────────

interface PagePayload {
  page: Record<string, unknown>;
  steps: Record<string, unknown>[];
  apiEndpoints: Record<string, unknown>[];
}

export async function trashPage(id: string, userId?: string | null): Promise<boolean> {
  const page = await prisma.page.findUnique({ where: { id } });
  if (!page) return false;

  const [steps, apiEndpoints] = await Promise.all([
    prisma.tutorialStep.findMany({ where: { pageId: id } }),
    prisma.apiEndpoint.findMany({ where: { pageId: id } }),
  ]);

  await capture({
    entityType: 'page',
    entityId: id,
    label: page.title,
    description: [page.routePath, `${steps.length} steps`].filter(Boolean).join(' · '),
    payload: { page, steps, apiEndpoints } as unknown as Prisma.InputJsonValue,
    userId,
    remove: async () => {
      await prisma.page.delete({ where: { id } });
    },
  });

  return true;
}

const pageAdapter: TrashAdapter = {
  type: 'page',
  typeLabel: 'Manual page',
  icon: 'article',
  permission: 'pages.view',
  list: capturedList('page', 'Manual page', 'article'),

  async restore(handle) {
    const item = await requireItem(handle, 'page');
    const data = item.payload as unknown as PagePayload;

    await prisma.$transaction(async (tx) => {
      await tx.page.create({ data: data.page as never });
      if (data.steps.length) await tx.tutorialStep.createMany({ data: data.steps as never });
      if (data.apiEndpoints.length) {
        await tx.apiEndpoint.createMany({ data: data.apiEndpoints as never });
      }
      await tx.trashItem.delete({ where: { id: handle } });
    });
  },

  async purge(handle) {
    // Step images are MediaAssets and stay in the library; only the record goes.
    await requireItem(handle, 'page');
    await prisma.trashItem.delete({ where: { id: handle } });
  },

  async sweep() {
    const result = await prisma.trashItem.deleteMany({
      where: { entityType: 'page', expiresAt: { lt: new Date() } },
    });
    return result.count;
  },
};

// ── Categories ──────────────────────────────────────────────────────────────

interface CategoryPayload {
  category: Record<string, unknown>;
  /** Pages that were filed under it, so a restore puts them back. */
  pages: Array<{ id: string; categoryOrder: number }>;
}

export async function trashCategory(id: string, userId?: string | null): Promise<boolean> {
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) return false;

  const pages = await prisma.page.findMany({
    where: { category: category.name },
    select: { id: true, categoryOrder: true },
  });

  await capture({
    entityType: 'category',
    entityId: id,
    label: category.name,
    description: pages.length ? `${pages.length} page(s) were filed here` : 'No pages',
    payload: { category, pages } as unknown as Prisma.InputJsonValue,
    userId,
    remove: async () => {
      await prisma.$transaction([
        prisma.page.updateMany({
          where: { category: category.name },
          data: { category: null, categoryOrder: 99 },
        }),
        prisma.category.delete({ where: { id } }),
      ]);
    },
  });

  return true;
}

const categoryAdapter: TrashAdapter = {
  type: 'category',
  typeLabel: 'Category',
  icon: 'category',
  permission: 'categories.view',
  list: capturedList('category', 'Category', 'category'),

  async restore(handle) {
    const item = await requireItem(handle, 'category');
    const data = item.payload as unknown as CategoryPayload;
    const name = data.category['name'] as string;

    await prisma.$transaction(async (tx) => {
      await tx.category.create({ data: data.category as never });
      // Re-file the pages, but only those still uncategorised: one that has been
      // moved somewhere else in the meantime should stay where it was put.
      for (const page of data.pages) {
        await tx.page.updateMany({
          where: { id: page.id, category: null },
          data: { category: name, categoryOrder: page.categoryOrder },
        });
      }
      await tx.trashItem.delete({ where: { id: handle } });
    });
  },

  async purge(handle) {
    await requireItem(handle, 'category');
    await prisma.trashItem.delete({ where: { id: handle } });
  },

  async sweep() {
    const result = await prisma.trashItem.deleteMany({
      where: { entityType: 'category', expiresAt: { lt: new Date() } },
    });
    return result.count;
  },
};

// ── Media (pre-existing soft delete, adapted) ───────────────────────────────

const mediaAdapter: TrashAdapter = {
  type: 'media',
  typeLabel: 'Media',
  icon: 'photo_library',
  permission: 'media.view',

  async list() {
    const rows = await prisma.mediaAsset.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
      select: {
        id: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        deletedAt: true,
      },
    });

    return rows.map((row) => {
      const deletedAt = row.deletedAt!;
      const expiresAt = expiryFrom(deletedAt);
      return {
        id: row.id,
        entityType: 'media' as const,
        typeLabel: 'Media',
        icon: 'photo_library',
        label: row.originalName,
        description: `${row.mimeType} · ${Math.max(1, Math.round(row.sizeBytes / 1024))} KB`,
        deletedAt: deletedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        daysLeft: daysLeft(expiresAt),
      };
    });
  },

  async restore(handle) {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: handle } });
    if (!asset?.deletedAt) throw AppError.notFound('That trash item is gone');
    await prisma.mediaAsset.update({ where: { id: handle }, data: { deletedAt: null } });
  },

  async purge(handle) {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: handle } });
    if (!asset?.deletedAt) throw AppError.notFound('That trash item is gone');

    await prisma.mediaAsset.delete({ where: { id: handle } });
    unlinkQuietly(asset.storagePath);
    unlinkQuietly(asset.originalStoragePath);
  },

  async sweep() {
    // Media flags `deletedAt` in place, so its cutoff is retention ago.
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * DAY_MS);
    const expired = await prisma.mediaAsset.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true, storagePath: true, originalStoragePath: true },
    });
    if (expired.length === 0) return 0;

    await prisma.mediaAsset.deleteMany({ where: { id: { in: expired.map((a) => a.id) } } });
    for (const asset of expired) {
      unlinkQuietly(asset.storagePath);
      unlinkQuietly(asset.originalStoragePath);
    }
    return expired.length;
  },
};

const ADAPTERS: TrashAdapter[] = [
  voiceoverScriptAdapter,
  pageAdapter,
  categoryAdapter,
  mediaAdapter,
];

function adapterFor(type: string): TrashAdapter {
  const adapter = ADAPTERS.find((a) => a.type === type);
  if (!adapter) throw AppError.badRequest(`Unknown trash type: ${type}`);
  return adapter;
}

/** Permission a caller needs to act on one type — used by the routes. */
export function permissionForType(type: string): string {
  return adapterFor(type).permission;
}

/** The types a caller can see, so the list never offers a forbidden restore. */
export interface TrashListOptions {
  can: (permission: string) => Promise<boolean>;
}

export async function listTrash(options: TrashListOptions): Promise<{
  items: TrashEntry[];
  retentionDays: number;
}> {
  // Sweep opportunistically, as the media trash already did: no scheduler
  // needed for correctness, and it self-heals across restarts.
  await sweepExpired();

  const items: TrashEntry[] = [];
  for (const adapter of ADAPTERS) {
    if (!(await options.can(adapter.permission))) continue;
    items.push(...(await adapter.list()));
  }

  items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  return { items, retentionDays: TRASH_RETENTION_DAYS };
}

export async function restoreFromTrash(type: string, handle: string): Promise<void> {
  await adapterFor(type).restore(handle);
}

export async function purgeFromTrash(type: string, handle: string): Promise<void> {
  await adapterFor(type).purge(handle);
}

/** Permanently delete everything past the retention window. */
export async function sweepExpired(): Promise<number> {
  let removed = 0;

  for (const adapter of ADAPTERS) {
    try {
      removed += await adapter.sweep();
    } catch (err) {
      // One type failing must not stop the others from being swept.
      logger.warn('trash: sweep failed', { type: adapter.type, error: (err as Error).message });
    }
  }

  if (removed > 0) logger.info('trash: purged expired items', { count: removed });
  return removed;
}
