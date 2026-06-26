/**
 * bridge.ts — In-memory command bus between the browser extension and Claude.
 * ───────────────────────────────────────────────────────────────────────────
 * The extension cannot be reached directly (it lives in a browser behind NAT),
 * so it OPENS the connection: it registers, then long-polls for commands. MCP
 * tools (driven by Claude) enqueue a command via `dispatch()` and await its
 * result, which the extension posts back after running it over the DevTools
 * Protocol (CDP). State is process-local — the MCP server and these routes run
 * in the same Node process.
 */

import { randomUUID } from 'node:crypto';

export interface ConnectorCommand {
  id: string;
  action: 'captureScreen' | 'navigate' | 'click' | 'type' | 'listTabs' | 'ping';
  params: Record<string, unknown>;
}

interface Session {
  id: string;
  label: string;
  url: string | null;
  connectedAt: number;
  lastSeen: number;
  queue: ConnectorCommand[];
  /** Resolver for an in-flight long-poll, so a command can be pushed instantly. */
  waiter?: (cmd: ConnectorCommand | null) => void;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SESSION_TTL_MS = 60_000; // a session with no poll for this long is dead
const API_BUFFER_MAX = 200; // recent API calls kept per session
const sessions = new Map<string, Session>();
const pending = new Map<string, Pending>();
const apiBuffer = new Map<string, unknown[]>(); // sessionId → recent captured API calls

/** Append API calls the extension pushed proactively (capped ring buffer). */
export function addApiCalls(sessionId: string, calls: unknown[]): void {
  const buf = apiBuffer.get(sessionId) ?? [];
  buf.push(...calls);
  if (buf.length > API_BUFFER_MAX) buf.splice(0, buf.length - API_BUFFER_MAX);
  apiBuffer.set(sessionId, buf);
}

/** Read (and clear) the buffered API calls for a session. */
export function drainApiCalls(sessionId: string): unknown[] {
  const buf = apiBuffer.get(sessionId) ?? [];
  apiBuffer.set(sessionId, []);
  return buf;
}

function prune(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      s.waiter?.(null);
      sessions.delete(id);
    }
  }
}

export function registerSession(label: string): string {
  const id = randomUUID();
  const now = Date.now();
  sessions.set(id, { id, label: label || 'browser', url: null, connectedAt: now, lastSeen: now, queue: [] });
  return id;
}

export function touch(id: string, url?: string | null): void {
  const s = sessions.get(id);
  if (!s) return;
  s.lastSeen = Date.now();
  if (url !== undefined) s.url = url;
}

export function disconnect(id: string): void {
  const s = sessions.get(id);
  s?.waiter?.(null);
  sessions.delete(id);
}

export interface PublicSession {
  id: string;
  label: string;
  url: string | null;
  connectedAt: string;
  lastSeen: string;
}

export function listSessions(): PublicSession[] {
  prune();
  return [...sessions.values()].map((s) => ({
    id: s.id,
    label: s.label,
    url: s.url,
    connectedAt: new Date(s.connectedAt).toISOString(),
    lastSeen: new Date(s.lastSeen).toISOString(),
  }));
}

export function hasSession(id: string): boolean {
  prune();
  return sessions.has(id);
}

/** Resolve a session id, defaulting to the most-recently-seen live one. */
export function resolveSessionId(preferred?: string): string | null {
  prune();
  if (preferred && sessions.has(preferred)) return preferred;
  if (preferred) return null;
  let best: Session | null = null;
  for (const s of sessions.values()) if (!best || s.lastSeen > best.lastSeen) best = s;
  return best?.id ?? null;
}

/** Long-poll: resolve with the next queued command, or null on timeout. */
export function nextCommand(id: string, timeoutMs = 25_000): Promise<ConnectorCommand | null> {
  const s = sessions.get(id);
  if (!s) return Promise.resolve(null);
  s.lastSeen = Date.now();
  const queued = s.queue.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (s.waiter) s.waiter = undefined;
      resolve(null);
    }, timeoutMs);
    s.waiter = (cmd) => {
      clearTimeout(timer);
      s.waiter = undefined;
      resolve(cmd);
    };
  });
}

/** Enqueue a command for the extension and await its result (used by MCP tools). */
export function dispatch(
  sessionId: string,
  action: ConnectorCommand['action'],
  params: Record<string, unknown> = {},
  timeoutMs = 45_000,
): Promise<unknown> {
  const s = sessions.get(sessionId);
  if (!s) return Promise.reject(new Error('No connected browser session'));
  const cmd: ConnectorCommand = { id: randomUUID(), action, params };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(cmd.id);
      reject(new Error(`Command "${action}" timed out`));
    }, timeoutMs);
    pending.set(cmd.id, { resolve, reject, timer });
    if (s.waiter) s.waiter(cmd);
    else s.queue.push(cmd);
  });
}

export function resolveResult(commandId: string, ok: boolean, data: unknown, error?: string): void {
  const p = pending.get(commandId);
  if (!p) return;
  pending.delete(commandId);
  clearTimeout(p.timer);
  if (ok) p.resolve(data);
  else p.reject(new Error(error || 'Command failed in the browser'));
}
