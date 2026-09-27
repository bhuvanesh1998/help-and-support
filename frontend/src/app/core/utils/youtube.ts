/**
 * Client mirror of backend/src/lib/youtube.ts, used only for the admin form's
 * live preview. The server re-parses every link and is the source of truth.
 */
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be', 'www.youtu.be',
]);
const PATH_PREFIXES = new Set(['shorts', 'embed', 'live', 'v']);

export function parseYoutubeId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (ID_RE.test(raw)) return raw;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (!HOSTS.has(host)) return null;
    const segs = url.pathname.split('/').filter(Boolean);
    let id: string | null | undefined;
    if (host.endsWith('youtu.be')) id = segs[0];
    else if (segs[0] === 'watch') id = url.searchParams.get('v');
    else if (segs[0] && PATH_PREFIXES.has(segs[0])) id = segs[1];
    return id && ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Canonical watch link for an id (+ optional start), for "Open on YouTube". */
export function youtubeWatchUrl(id: string, startSec = 0): string {
  return `https://www.youtube.com/watch?v=${id}${startSec ? `&t=${startSec}s` : ''}`;
}
