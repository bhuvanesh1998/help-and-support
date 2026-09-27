/**
 * Parse whatever YouTube link an admin pastes into a bare video id + start.
 *
 * Accepts watch?v=, youtu.be/, /shorts/, /embed/, /live/, /v/ links (with or
 * without www./m./music. and the -nocookie host), or a bare 11-char id. Only
 * the id is stored, so a hostile URL can never reach an <iframe src>.
 */
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be', 'www.youtu.be',
]);
const PATH_PREFIXES = new Set(['shorts', 'embed', 'live', 'v']);
const MAX_START_SEC = 24 * 3600;

export interface YoutubeRef {
  youtubeId: string;
  startSec: number;
}

/** "90", "90s", "1m30s", "1h2m3s" → seconds; anything else → 0. */
function parseStart(raw: string | null): number {
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export function parseYoutubeUrl(input: string): YoutubeRef | null {
  const raw = input.trim();
  if (YOUTUBE_ID_RE.test(raw)) return { youtubeId: raw, startSec: 0 };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;

  const segs = url.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  if (host.endsWith('youtu.be')) id = segs[0];
  else if (segs[0] === 'watch') id = url.searchParams.get('v') ?? undefined;
  else if (segs[0] && PATH_PREFIXES.has(segs[0])) id = segs[1];

  if (!id || !YOUTUBE_ID_RE.test(id)) return null;
  const startSec = parseStart(url.searchParams.get('t') ?? url.searchParams.get('start'));
  return { youtubeId: id, startSec: Math.min(startSec, MAX_START_SEC) };
}
