export interface HighlightPart {
  text: string;
  hit: boolean;
}

/**
 * Split `text` into plain/highlighted segments for every query term (min 2 chars).
 * Returned as data so templates render it via interpolation — no innerHTML.
 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const src = text ?? '';
  const terms = (query ?? '')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length || !src) return [{ text: src, hit: false }];
  const re = new RegExp(`(${terms.join('|')})`, 'gi');
  const out: HighlightPart[] = [];
  let last = 0;
  for (const m of src.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: src.slice(last, i), hit: false });
    out.push({ text: m[0], hit: true });
    last = i + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last), hit: false });
  return out;
}
