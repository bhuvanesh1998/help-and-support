import { marked } from 'marked';

/** Loosely normalize a heading/title for equality: drop case, emphasis markers,
 *  trailing punctuation and redundant whitespace. */
function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`]/g, '')          // strip Markdown emphasis markers
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s:.\-–—!?]+$/g, ''); // trailing punctuation / colon
}

/**
 * Render a step's Markdown instructions to an HTML string for [innerHTML]
 * (Angular's sanitizer strips anything unsafe — never bypassSecurityTrustHtml).
 *
 * If the body's first line is a heading that merely repeats the step title,
 * it is dropped: the reader/card already renders the title above the body, so
 * keeping it would show the title twice.
 */
export function renderStepMarkdown(instructionsMd: string, title?: string): string {
  let md = (instructionsMd ?? '').replace(/^\s+/, '');

  if (title) {
    // Leading ATX heading, e.g. "## Enter your Email Id"
    const m = md.match(/^#{1,6}[ \t]+(.+?)[ \t]*(?:\r?\n|$)/);
    if (m && normalizeHeading(m[1]) === normalizeHeading(title)) {
      md = md.slice(m[0].length).replace(/^\s*\r?\n/, '');
    }
  }

  const html = marked.parse(md);
  return typeof html === 'string' ? html : '';
}
