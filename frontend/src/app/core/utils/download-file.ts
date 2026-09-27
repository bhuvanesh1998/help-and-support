/**
 * download-file.ts — Save a remote file to disk, reliably.
 *
 * `<a href="…" download>` looks like it does this, but the `download` attribute
 * is **ignored for cross-origin URLs**: the browser navigates to the file
 * instead, so an MP3 opens in the tab and plays. Generated media is served from
 * the API origin while the admin runs on its own, so every such link hit that
 * path.
 *
 * Fetching to a blob makes the object URL same-origin, which restores both the
 * download and the chosen filename. `/uploads` sends `Access-Control-Allow-Origin: *`,
 * so the fetch is allowed.
 */
export async function downloadFile(url: string, filename: string): Promise<void> {
  // `omit` because these are public files and the wildcard CORS header cannot be
  // combined with credentials.
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Revoking immediately can cancel the save in some browsers; a short delay
  // costs nothing and the blob is released either way.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

/** Filesystem-safe filename fragment from arbitrary text. */
export function safeFilename(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/\.[a-z0-9]{2,4}$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'download'
  );
}
