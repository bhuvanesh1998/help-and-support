import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Inject,
  OnInit,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AdminApiService } from '../../services/admin-api';
import type { ImageAnnotation, MediaAsset } from '../../models/admin';

type Tool = 'select' | 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'badge' | 'blur';

export interface ImageAnnotatorData {
  asset: MediaAsset;
}

const PALETTE = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#000000', '#ffffff'];

@Component({
  selector: 'ha-image-annotator',
  imports: [UpperCasePipe, FormsModule, MatDialogModule, MatButtonModule, MatIconModule, MatTooltipModule],
  templateUrl: './image-annotator.html',
  styleUrl: './image-annotator.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageAnnotator implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);
  private readonly dialogRef = inject<MatDialogRef<ImageAnnotator, boolean>>(MatDialogRef);

  @ViewChild('canvas', { static: false }) private canvasRef?: ElementRef<HTMLCanvasElement>;

  readonly palette = PALETTE;
  readonly tools: Array<{ id: Tool; icon: string; label: string }> = [
    { id: 'select', icon: 'near_me', label: 'Select / move' },
    { id: 'rect', icon: 'crop_square', label: 'Highlight box' },
    { id: 'ellipse', icon: 'radio_button_unchecked', label: 'Circle' },
    { id: 'arrow', icon: 'north_east', label: 'Arrow' },
    { id: 'pen', icon: 'gesture', label: 'Freehand' },
    { id: 'text', icon: 'title', label: 'Text label' },
    { id: 'badge', icon: 'looks_one', label: 'Number badge' },
    { id: 'blur', icon: 'blur_on', label: 'Blur / redact' },
  ];

  readonly tool = signal<Tool>('rect');
  readonly color = signal<string>('#e53935');
  readonly thickness = signal<number>(6);
  readonly canUndo = signal(false);
  readonly hasSelection = signal(false);
  readonly loading = signal(true);
  readonly saving = signal(false);

  altText = '';
  readonly asset: MediaAsset;

  private img = new Image();
  private naturalW = 0;
  private naturalH = 0;
  private shapes: ImageAnnotation[] = [];
  private history: string[] = [];
  private selected = -1;

  // Drag state
  private dragging = false;
  private start = { x: 0, y: 0 };
  private draft: ImageAnnotation | null = null;
  private moveOffset = { x: 0, y: 0 };

  constructor(@Inject(MAT_DIALOG_DATA) data: ImageAnnotatorData) {
    this.asset = data.asset;
    this.altText = data.asset.altText ?? '';
  }

  ngOnInit(): void {
    // Fetch the full record (annotations + untouched original) then load the base.
    this.api.getMedia(this.asset.id).subscribe({
      next: ({ asset }) => {
        this.altText = asset.altText ?? this.altText;
        this.shapes = Array.isArray(asset.annotations) ? asset.annotations.map((s) => ({ ...s })) : [];
        this.loadImage(asset.originalUrl || asset.publicUrl);
      },
      error: () => this.loadImage(this.asset.originalUrl || this.asset.publicUrl),
    });
  }

  private loadImage(url: string): void {
    this.img.crossOrigin = 'anonymous';
    this.img.onload = () => {
      this.naturalW = this.img.naturalWidth;
      this.naturalH = this.img.naturalHeight;
      // Scale default stroke to the image so it reads well on large screenshots.
      this.thickness.set(Math.max(4, Math.round(this.naturalW / 320)));
      queueMicrotask(() => {
        const c = this.canvasRef?.nativeElement;
        if (c) { c.width = this.naturalW; c.height = this.naturalH; }
        this.loading.set(false);
        this.redraw();
      });
    };
    this.img.onerror = () => { this.loading.set(false); this.snack.open('Could not load image', 'OK', { duration: 4000 }); };
    // Cache-bust so a freshly re-rendered image doesn't load a stale copy.
    this.img.src = url + (url.includes('?') ? '&' : '?') + 'ts=' + this.asset.id;
  }

  // ── Toolbar ──────────────────────────────────────────────────────────────
  setTool(t: Tool): void { this.tool.set(t); if (t !== 'select') this.clearSelection(); }
  setColor(c: string): void {
    this.color.set(c);
    if (this.selected >= 0) { this.pushHistory(); this.shapes[this.selected].color = c; this.redraw(); }
  }
  onThickness(v: number): void {
    this.thickness.set(v);
    if (this.selected >= 0) { this.pushHistory(); this.shapes[this.selected].thickness = v; this.redraw(); }
  }

  undo(): void {
    const prev = this.history.pop();
    if (prev === undefined) return;
    this.shapes = JSON.parse(prev) as ImageAnnotation[];
    this.canUndo.set(this.history.length > 0);
    this.clearSelection();
    this.redraw();
  }
  clearAll(): void {
    if (!this.shapes.length) return;
    this.pushHistory();
    this.shapes = [];
    this.clearSelection();
    this.redraw();
  }
  deleteSelected(): void {
    if (this.selected < 0) return;
    this.pushHistory();
    this.shapes.splice(this.selected, 1);
    this.clearSelection();
    this.redraw();
  }

  private pushHistory(): void {
    this.history.push(JSON.stringify(this.shapes));
    if (this.history.length > 50) this.history.shift();
    this.canUndo.set(true);
  }
  private clearSelection(): void { this.selected = -1; this.hasSelection.set(false); }

  // ── Pointer → natural-pixel mapping ────────────────────────────────────────
  private toNatural(e: PointerEvent): { x: number; y: number } {
    const c = this.canvasRef!.nativeElement;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
    };
  }

  onPointerDown(e: PointerEvent): void {
    if (this.loading()) return;
    const pt = this.toNatural(e);
    this.canvasRef!.nativeElement.setPointerCapture(e.pointerId);

    if (this.tool() === 'select') {
      const hit = this.hitTest(pt.x, pt.y);
      this.selected = hit;
      this.hasSelection.set(hit >= 0);
      if (hit >= 0) {
        this.dragging = true;
        this.pushHistory();
        const s = this.shapes[hit];
        this.moveOffset = { x: pt.x - (s.x ?? 0), y: pt.y - (s.y ?? 0) };
      }
      this.redraw();
      return;
    }

    if (this.tool() === 'text') {
      const text = window.prompt('Label text:')?.trim();
      if (text) {
        this.pushHistory();
        this.shapes.push({ type: 'text', color: this.color(), thickness: this.thickness(),
          x: pt.x, y: pt.y, text, fontSize: Math.max(16, this.thickness() * 4) });
        this.redraw();
      }
      return;
    }

    if (this.tool() === 'badge') {
      this.pushHistory();
      const n = this.shapes.filter((s) => s.type === 'badge').length + 1;
      this.shapes.push({ type: 'badge', color: this.color(), thickness: this.thickness(),
        x: pt.x, y: pt.y, number: n });
      this.redraw();
      return;
    }

    // Draggable shapes: rect / ellipse / arrow / pen / blur
    this.dragging = true;
    this.start = pt;
    if (this.tool() === 'pen') {
      this.draft = { type: 'pen', color: this.color(), thickness: this.thickness(), points: [pt] };
    } else {
      // Only rect / ellipse / arrow / blur reach here (select/text/badge/pen handled above).
      const t = this.tool() as Exclude<Tool, 'select'>;
      this.draft = { type: t, color: this.color(), thickness: this.thickness(),
        x: pt.x, y: pt.y, w: 0, h: 0, x2: pt.x, y2: pt.y };
    }
  }

  onPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const pt = this.toNatural(e);

    if (this.tool() === 'select' && this.selected >= 0) {
      const s = this.shapes[this.selected];
      const nx = pt.x - this.moveOffset.x;
      const ny = pt.y - this.moveOffset.y;
      this.translateShape(s, nx - (s.x ?? 0), ny - (s.y ?? 0));
      this.redraw();
      return;
    }

    if (!this.draft) return;
    if (this.draft.type === 'pen') {
      this.draft.points!.push(pt);
    } else if (this.draft.type === 'arrow') {
      this.draft.x2 = pt.x; this.draft.y2 = pt.y;
    } else {
      this.draft.x = Math.min(this.start.x, pt.x);
      this.draft.y = Math.min(this.start.y, pt.y);
      this.draft.w = Math.abs(pt.x - this.start.x);
      this.draft.h = Math.abs(pt.y - this.start.y);
    }
    this.redraw(this.draft);
  }

  onPointerUp(): void {
    if (this.tool() === 'select') { this.dragging = false; return; }
    if (!this.dragging || !this.draft) { this.dragging = false; return; }
    this.dragging = false;
    const d = this.draft;
    this.draft = null;
    // Ignore accidental micro-drags.
    const big = d.type === 'pen'
      ? (d.points?.length ?? 0) > 2
      : d.type === 'arrow'
        ? Math.hypot((d.x2 ?? 0) - (d.x ?? 0), (d.y2 ?? 0) - (d.y ?? 0)) > 6
        : (d.w ?? 0) > 5 && (d.h ?? 0) > 5;
    if (!big) { this.redraw(); return; }
    this.pushHistory();
    this.shapes.push(d);
    this.redraw();
  }

  private translateShape(s: ImageAnnotation, dx: number, dy: number): void {
    if (s.type === 'pen' && s.points) { s.points = s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })); return; }
    if (s.x != null) s.x += dx;
    if (s.y != null) s.y += dy;
    if (s.x2 != null) s.x2 += dx;
    if (s.y2 != null) s.y2 += dy;
  }

  private hitTest(x: number, y: number): number {
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      const pad = Math.max(8, s.thickness);
      if (s.type === 'pen' && s.points) {
        if (s.points.some((p) => Math.hypot(p.x - x, p.y - y) < pad)) return i;
      } else if (s.type === 'arrow') {
        if (this.distToSeg(x, y, s.x ?? 0, s.y ?? 0, s.x2 ?? 0, s.y2 ?? 0) < pad) return i;
      } else if (s.type === 'text' || s.type === 'badge') {
        const r = s.type === 'badge' ? (s.thickness * 3 + 10) : (s.fontSize ?? 20);
        if (Math.abs(x - (s.x ?? 0)) < r * 3 && Math.abs(y - (s.y ?? 0)) < r) return i;
      } else {
        const sx = s.x ?? 0, sy = s.y ?? 0, sw = s.w ?? 0, sh = s.h ?? 0;
        if (x >= sx - pad && x <= sx + sw + pad && y >= sy - pad && y <= sy + sh + pad) return i;
      }
    }
    return -1;
  }
  private distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  private redraw(extra?: ImageAnnotation): void {
    const c = this.canvasRef?.nativeElement;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (this.naturalW) ctx.drawImage(this.img, 0, 0, c.width, c.height);
    const all = extra ? [...this.shapes, extra] : this.shapes;
    all.forEach((s, i) => this.drawShape(ctx, s, i === this.selected && !extra));
  }

  private drawShape(ctx: CanvasRenderingContext2D, s: ImageAnnotation, selected: boolean): void {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.thickness;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    switch (s.type) {
      case 'rect':
        ctx.strokeRect(s.x ?? 0, s.y ?? 0, s.w ?? 0, s.h ?? 0);
        break;
      case 'ellipse': {
        const rx = (s.w ?? 0) / 2, ry = (s.h ?? 0) / 2;
        ctx.beginPath();
        ctx.ellipse((s.x ?? 0) + rx, (s.y ?? 0) + ry, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'arrow':
        this.drawArrow(ctx, s.x ?? 0, s.y ?? 0, s.x2 ?? 0, s.y2 ?? 0, s.thickness);
        break;
      case 'pen':
        if (s.points?.length) {
          ctx.beginPath();
          ctx.moveTo(s.points[0].x, s.points[0].y);
          s.points.forEach((p) => ctx.lineTo(p.x, p.y));
          ctx.stroke();
        }
        break;
      case 'text':
        ctx.font = `600 ${s.fontSize ?? 20}px Inter, Arial, sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(s.text ?? '', s.x ?? 0, s.y ?? 0);
        break;
      case 'badge': {
        const r = s.thickness * 3 + 8;
        ctx.beginPath();
        ctx.arc(s.x ?? 0, s.y ?? 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `700 ${r}px Inter, Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(s.number ?? 1), s.x ?? 0, (s.y ?? 0) + 1);
        break;
      }
      case 'blur': {
        const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 0, h = s.h ?? 0;
        if (w > 0 && h > 0 && this.naturalW) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
          ctx.filter = `blur(${Math.max(6, s.thickness * 2)}px)`;
          ctx.drawImage(this.img, 0, 0, this.naturalW, this.naturalH);
          ctx.restore();
        }
        break;
      }
    }

    if (selected) {
      const b = this.bounds(s);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#1e88e5';
      ctx.lineWidth = Math.max(1.5, s.thickness / 3);
      ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
    }
    ctx.restore();
  }

  private drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, th: number): void {
    const head = Math.max(10, th * 2.5);
    const ang = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  private bounds(s: ImageAnnotation): { x: number; y: number; w: number; h: number } {
    if (s.type === 'pen' && s.points?.length) {
      const xs = s.points.map((p) => p.x), ys = s.points.map((p) => p.y);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
    }
    if (s.type === 'arrow') {
      const minX = Math.min(s.x ?? 0, s.x2 ?? 0), minY = Math.min(s.y ?? 0, s.y2 ?? 0);
      return { x: minX, y: minY, w: Math.abs((s.x2 ?? 0) - (s.x ?? 0)), h: Math.abs((s.y2 ?? 0) - (s.y ?? 0)) };
    }
    if (s.type === 'text') return { x: s.x ?? 0, y: s.y ?? 0, w: (s.text?.length ?? 4) * (s.fontSize ?? 20) * 0.55, h: s.fontSize ?? 20 };
    if (s.type === 'badge') { const r = s.thickness * 3 + 8; return { x: (s.x ?? 0) - r, y: (s.y ?? 0) - r, w: r * 2, h: r * 2 }; }
    return { x: s.x ?? 0, y: s.y ?? 0, w: s.w ?? 0, h: s.h ?? 0 };
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  save(): void {
    const c = this.canvasRef?.nativeElement;
    if (!c || this.saving()) return;
    // Re-render without the selection outline, then export.
    this.clearSelection();
    this.redraw();
    this.saving.set(true);
    c.toBlob((blob) => {
      if (!blob) { this.saving.set(false); this.snack.open('Could not render image', 'OK', { duration: 4000 }); return; }
      this.api.annotateMedia(this.asset.id, blob, this.shapes, this.naturalW, this.naturalH, this.altText).subscribe({
        next: ({ asset }) => {
          this.saving.set(false);
          this.snack.open('Image saved', undefined, { duration: 2000 });
          this.dialogRef.close(true); // signal caller to refresh; asset carries new publicUrl
          void asset;
        },
        error: (err) => {
          this.saving.set(false);
          this.snack.open(err.error?.error?.message ?? 'Save failed', 'OK', { duration: 4000 });
        },
      });
    }, 'image/png');
  }

  cancel(): void { this.dialogRef.close(false); }
}
