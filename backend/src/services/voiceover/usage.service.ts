/**
 * usage.service.ts — What the Voiceover Studio spent, per call.
 * ────────────────────────────────────────────────────────────
 * One row per billable API call, recorded in the units the provider bills in:
 * tokens for the vision models, characters for text-to-speech.
 *
 * Deliberately not priced. Provider rates change and differ per account, and a
 * hardcoded price silently reporting the wrong cost is worse than reporting the
 * units and letting the reader apply their own rates.
 *
 * Recording is best-effort: a usage write must never fail the run it measures.
 */

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

/**
 * What kind of call produced this usage. Timeline assembly is local ffmpeg work
 * and costs nothing at a provider, so it is not recorded.
 */
export type UsageKind = 'script' | 'tts' | 'sample';

export interface RecordUsageInput {
  scriptId?: string | null;
  kind: UsageKind;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  frames?: number;
  characters?: number;
  ok?: boolean;
}

export async function recordUsage(input: RecordUsageInput): Promise<void> {
  try {
    await prisma.voiceoverUsage.create({
      data: {
        scriptId: input.scriptId ?? null,
        kind: input.kind,
        provider: input.provider,
        model: input.model,
        inputTokens: Math.max(0, Math.round(input.inputTokens ?? 0)),
        outputTokens: Math.max(0, Math.round(input.outputTokens ?? 0)),
        frames: Math.max(0, Math.round(input.frames ?? 0)),
        characters: Math.max(0, Math.round(input.characters ?? 0)),
        ok: input.ok ?? true,
      },
    });
  } catch (err) {
    logger.warn('voiceover: could not record usage', { error: (err as Error).message });
  }
}

export interface UsageTotals {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  frames: number;
  characters: number;
}

export interface UsageBreakdown extends UsageTotals {
  key: string;
}

export interface UsageReport {
  days: number;
  since: string;
  totals: UsageTotals;
  byProvider: UsageBreakdown[];
  byModel: UsageBreakdown[];
  byKind: UsageBreakdown[];
  byDay: UsageBreakdown[];
  /** Heaviest scripts, so a runaway job is obvious. */
  topScripts: Array<UsageBreakdown & { videoName: string | null; tone: string | null }>;
}

const EMPTY: UsageTotals = {
  calls: 0,
  failed: 0,
  inputTokens: 0,
  outputTokens: 0,
  frames: 0,
  characters: 0,
};

interface UsageRow {
  scriptId: string | null;
  kind: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  frames: number;
  characters: number;
  ok: boolean;
  createdAt: Date;
}

function accumulate(target: UsageTotals, row: UsageRow): void {
  target.calls += 1;
  if (!row.ok) target.failed += 1;
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.frames += row.frames;
  target.characters += row.characters;
}

/** Group rows by a key, summing each group. */
function groupBy(rows: UsageRow[], key: (row: UsageRow) => string): UsageBreakdown[] {
  const map = new Map<string, UsageBreakdown>();
  for (const row of rows) {
    const k = key(row);
    let entry = map.get(k);
    if (!entry) {
      entry = { key: k, ...EMPTY };
      map.set(k, entry);
    }
    accumulate(entry, row);
  }
  // Heaviest first, except days which the caller re-sorts chronologically.
  return [...map.values()].sort(
    (a, b) => b.inputTokens + b.outputTokens + b.characters - (a.inputTokens + a.outputTokens + a.characters),
  );
}

/**
 * Aggregate the window in one query and fold in memory: the row count here is
 * small (a few per job) and it keeps the shaping in one readable place.
 */
export async function getUsageReport(days = 30): Promise<UsageReport> {
  const window = Math.min(Math.max(days, 1), 365);
  const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000);

  const rows = (await prisma.voiceoverUsage.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
  })) as UsageRow[];

  const totals: UsageTotals = { ...EMPTY };
  for (const row of rows) accumulate(totals, row);

  const byDay = groupBy(rows, (r) => r.createdAt.toISOString().slice(0, 10)).sort((a, b) =>
    a.key.localeCompare(b.key),
  );

  // Name the heaviest scripts. Rows whose script was deleted keep counting but
  // have no name to show.
  const scriptGroups = groupBy(
    rows.filter((r) => r.scriptId),
    (r) => r.scriptId!,
  ).slice(0, 10);

  const names = scriptGroups.length
    ? await prisma.voiceoverScript.findMany({
        where: { id: { in: scriptGroups.map((g) => g.key) } },
        select: { id: true, videoName: true, tone: true },
      })
    : [];
  const nameById = new Map(names.map((n) => [n.id, n]));

  return {
    days: window,
    since: since.toISOString(),
    totals,
    byProvider: groupBy(rows, (r) => r.provider),
    byModel: groupBy(rows, (r) => r.model),
    byKind: groupBy(rows, (r) => r.kind),
    byDay,
    topScripts: scriptGroups.map((g) => ({
      ...g,
      videoName: nameById.get(g.key)?.videoName ?? null,
      tone: nameById.get(g.key)?.tone ?? null,
    })),
  };
}
