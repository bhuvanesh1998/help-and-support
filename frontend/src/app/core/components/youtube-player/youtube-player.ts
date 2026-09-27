import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Click-to-play YouTube embed. Shows the video thumbnail until the viewer asks
 * for it, so a manual with many videos loads no third-party iframes up front,
 * and uses the youtube-nocookie host so nothing is tracked before playback.
 *
 * The id is re-validated here, and it is the only thing that goes into the
 * trusted URL — no stored or pasted URL is ever framed.
 */
@Component({
  selector: 'ha-youtube-player',
  template: `
    @if (valid()) {
      <div class="yt-frame">
        @if (playing()) {
          <iframe [src]="embedUrl()" [title]="title()" loading="lazy"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
        } @else {
          <button type="button" class="yt-facade" (click)="play()" [attr.aria-label]="'Play video: ' + title()">
            <img [src]="thumbUrl()" [alt]="" loading="lazy" (error)="thumbFallback($event)" />
            <span class="yt-play" aria-hidden="true">
              <svg viewBox="0 0 68 48" width="68" height="48">
                <path d="M66.5 7.7A8.5 8.5 0 0 0 60.5 1.7C55.2.3 34 .3 34 .3s-21.2 0-26.5 1.4A8.5 8.5 0 0 0 1.5 7.7C.1 13 .1 24 .1 24s0 11 1.4 16.3a8.5 8.5 0 0 0 6 6c5.3 1.4 26.5 1.4 26.5 1.4s21.2 0 26.5-1.4a8.5 8.5 0 0 0 6-6C67.9 35 67.9 24 67.9 24s0-11-1.4-16.3z" fill="#f00"/>
                <path d="M45 24 27 14v20z" fill="#fff"/>
              </svg>
            </span>
            @if (badge()) { <span class="yt-dur">{{ badge() }}</span> }
          </button>
        }
      </div>
    }
  `,
  styles: `
    :host { display: block; }
    .yt-frame {
      position: relative; aspect-ratio: 16 / 9; width: 100%;
      border-radius: 10px; overflow: hidden; background: #000;
    }
    iframe, .yt-facade { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
    .yt-facade { padding: 0; cursor: pointer; background: #000; }
    .yt-facade img { width: 100%; height: 100%; object-fit: cover; display: block; opacity: .92; transition: opacity .2s; }
    .yt-facade:hover img, .yt-facade:focus-visible img { opacity: 1; }
    .yt-facade:focus-visible { outline: 3px solid var(--mat-sys-primary); outline-offset: -3px; }
    .yt-play {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      filter: drop-shadow(0 2px 8px rgba(0,0,0,.4)); transition: transform .15s;
    }
    .yt-facade:hover .yt-play { transform: translate(-50%, -50%) scale(1.08); }
    .yt-dur {
      position: absolute; right: 8px; bottom: 8px; padding: 2px 6px; border-radius: 4px;
      font: 600 12px/1.4 Inter, system-ui, sans-serif; color: #fff; background: rgba(0,0,0,.75);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class YoutubePlayer {
  private readonly sanitizer = inject(DomSanitizer);

  readonly videoId = input.required<string>();
  readonly title = input<string>('Tutorial video');
  readonly startSec = input<number>(0);
  /** Optional label for the thumbnail badge, e.g. "Overview". */
  readonly badge = input<string>('');
  /** Emits once when the viewer starts playback (for analytics). */
  readonly started = output<void>();

  readonly playing = signal(false);
  readonly valid = computed(() => ID_RE.test(this.videoId()));

  readonly thumbUrl = computed(() => `https://i.ytimg.com/vi/${this.videoId()}/hqdefault.jpg`);

  readonly embedUrl = computed<SafeResourceUrl>(() => {
    const id = this.videoId();
    if (!ID_RE.test(id)) return '';
    const start = Math.max(0, Math.floor(this.startSec() || 0));
    const qs = `autoplay=1&rel=0&modestbranding=1${start ? `&start=${start}` : ''}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(`https://www.youtube-nocookie.com/embed/${id}?${qs}`);
  });

  constructor() {
    // A reused player that is handed a different video goes back to its thumbnail.
    effect(() => {
      this.videoId();
      this.playing.set(false);
    });
  }

  play(): void {
    this.playing.set(true);
    this.started.emit();
  }

  /** Some uploads have no hq thumbnail yet; fall back to the always-present default. */
  thumbFallback(e: Event): void {
    const img = e.target as HTMLImageElement;
    const fallback = `https://i.ytimg.com/vi/${this.videoId()}/default.jpg`;
    if (img.src !== fallback) img.src = fallback;
  }
}
