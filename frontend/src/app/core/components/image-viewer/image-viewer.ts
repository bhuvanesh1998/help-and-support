import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/**
 * Reusable full-screen image viewer (lightbox). Bind `src` to a signal; when it
 * holds a URL the overlay shows. Click the image to zoom, backdrop/✕/Esc closes.
 * Optionally pass `items` for prev/next navigation through a set of images.
 */
@Component({
  selector: 'ha-image-viewer',
  imports: [MatIconModule],
  templateUrl: './image-viewer.html',
  styleUrl: './image-viewer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageViewer {
  /** URL to show; null = hidden. */
  readonly src = input<string | null>(null);
  readonly alt = input<string>('Image');
  readonly caption = input<string>('');
  /** Optional gallery for prev/next (URLs). */
  readonly items = input<string[]>([]);
  readonly closed = output<void>();

  readonly zoomed = signal(false);
  readonly current = signal<string | null>(null);
  private readonly overlay = viewChild<ElementRef<HTMLElement>>('overlay');

  constructor() {
    effect(() => {
      const s = this.src();
      this.current.set(s);
      this.zoomed.set(false);
      if (s) queueMicrotask(() => this.overlay()?.nativeElement.focus());
    });
  }

  private index(): number {
    const cur = this.current();
    return cur ? this.items().indexOf(cur) : -1;
  }
  readonly hasNav = () => this.items().length > 1 && this.index() >= 0;

  prev(e: Event): void {
    e.stopPropagation();
    const list = this.items();
    const i = this.index();
    if (i > 0) { this.current.set(list[i - 1]!); this.zoomed.set(false); }
  }
  next(e: Event): void {
    e.stopPropagation();
    const list = this.items();
    const i = this.index();
    if (i >= 0 && i < list.length - 1) { this.current.set(list[i + 1]!); this.zoomed.set(false); }
  }
  toggleZoom(e: Event): void { e.stopPropagation(); this.zoomed.update((z) => !z); }
  close(): void { this.closed.emit(); }
}
