import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';

/** Drift (seconds) past which the narration is snapped back onto the picture. */
const MAX_DRIFT_SEC = 0.08;

/**
 * Plays the recorded video with the assembled narration track and captions, all
 * on one clock. The video stays local (picked from disk, never uploaded); the
 * video element drives time and the audio follows it, re-synced on every play,
 * seek, rate change and whenever it wanders more than MAX_DRIFT_SEC.
 */
@Component({
  selector: 'app-sync-preview',
  imports: [MatButtonModule, MatIconModule, MatSlideToggleModule],
  templateUrl: './sync-preview.html',
  styleUrl: './sync-preview.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SyncPreview implements OnDestroy {
  /** The full-length narration MP3. */
  readonly trackUrl = input.required<string>();
  /** WebVTT captions endpoint (fetched, since the API is on another origin). */
  readonly captionsUrl = input.required<string>();

  readonly videoSrc = signal<string | null>(null);
  readonly videoName = signal('');
  readonly captionsSrc = signal<string | null>(null);
  readonly captionsError = signal('');
  readonly showCaptions = signal(true);

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly audio = viewChild<ElementRef<HTMLAudioElement>>('audio');

  constructor() {
    effect((onCleanup) => {
      const url = this.captionsUrl();
      let objectUrl: string | null = null;
      let cancelled = false;
      this.captionsError.set('');
      fetch(url)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((text) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
          this.captionsSrc.set(objectUrl);
        })
        .catch(() => !cancelled && this.captionsError.set('Captions could not be loaded.'));
      onCleanup(() => {
        cancelled = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      });
    });

    // Keep the caption track's visibility in step with the toggle.
    effect(() => {
      const show = this.showCaptions();
      const v = this.video()?.nativeElement;
      if (!v || !this.captionsSrc()) return;
      for (const t of Array.from(v.textTracks)) t.mode = show ? 'showing' : 'hidden';
    });
  }

  pickVideo(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.revokeVideo();
    this.videoSrc.set(URL.createObjectURL(file));
    this.videoName.set(file.name);
  }

  onTrackLoaded(): void {
    const v = this.video()?.nativeElement;
    if (!v) return;
    for (const t of Array.from(v.textTracks)) t.mode = this.showCaptions() ? 'showing' : 'hidden';
  }

  /** Snap the narration onto the picture's clock. */
  sync(force = false): void {
    const v = this.video()?.nativeElement;
    const a = this.audio()?.nativeElement;
    if (!v || !a) return;
    a.playbackRate = v.playbackRate;
    if (force || Math.abs(a.currentTime - v.currentTime) > MAX_DRIFT_SEC) {
      a.currentTime = v.currentTime;
    }
  }

  onPlay(): void {
    this.sync(true);
    void this.audio()?.nativeElement.play().catch(() => undefined);
  }

  onPause(): void {
    this.audio()?.nativeElement.pause();
    this.sync(true);
  }

  /** Buffering on the video must hold the narration too. */
  onWaiting(): void {
    this.audio()?.nativeElement.pause();
  }

  onPlaying(): void {
    this.sync(true);
    const a = this.audio()?.nativeElement;
    if (a?.paused) void a.play().catch(() => undefined);
  }

  ngOnDestroy(): void {
    this.revokeVideo();
  }

  private revokeVideo(): void {
    const src = this.videoSrc();
    if (src) URL.revokeObjectURL(src);
  }
}
