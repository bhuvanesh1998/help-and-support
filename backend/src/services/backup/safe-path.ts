/**
 * safe-path.ts — Containment helpers for files under the uploads directory.
 * ───────────────────────────────────────────────────────────────────────────
 * Media filenames and storage paths come from the database and from restored
 * backup manifests, so they are treated as untrusted: every read or unlink of
 * an upload goes through here to guarantee it stays inside `uploadDir`.
 */

import path from 'node:path';
import { uploadDir } from '../../lib/upload.js';

/** Image extensions an upload may carry (mirrors the multer MIME allowlist). */
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** A bare, safe media filename: alnum start, alnum/._- body, image extension. */
const SAFE_MEDIA_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(?:jpe?g|png|gif|webp)$/i;

/** True when `filename` is a bare basename matching the safe media pattern. */
export function isSafeMediaFilename(filename: unknown): filename is string {
  return (
    typeof filename === 'string' &&
    filename === path.basename(filename) &&
    !filename.includes('..') &&
    SAFE_MEDIA_FILENAME_RE.test(filename)
  );
}

/** True when `candidate` resolves to a path strictly inside `root`. */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve `p` (absolute, or relative to uploadDir) and return it only if it
 * stays inside uploadDir; otherwise null.
 */
export function resolveInUploads(p: string | null | undefined): string | null {
  if (!p) return null;
  const resolved = path.resolve(uploadDir, p);
  return isInside(uploadDir, resolved) ? resolved : null;
}

/** Path for a safe media filename inside uploadDir, or null if unsafe. */
export function uploadPathFor(filename: string): string | null {
  return isSafeMediaFilename(filename) ? resolveInUploads(filename) : null;
}
