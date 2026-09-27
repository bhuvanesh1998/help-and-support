import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { UpperCasePipe, DecimalPipe, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AdminApiService } from '../../services/admin-api';
import { safeUUID } from '../../utils/uuid';
import type { ImageAnnotation, MediaAsset } from '../../models/admin';

type Tool = 'select' | 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'badge' | 'blur';
type LabelPos = NonNullable<ImageAnnotation['labelPos']>;

interface GroupRow { kind: 'group'; groupId: string; members: ImageAnnotation[]; }
interface ShapeRow { kind: 'shape'; shape: ImageAnnotation; }
type LayerRow = GroupRow | ShapeRow;

const PALETTE = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#000000', '#ffffff'];
const CAPTIONED = new Set<Tool>(['rect', 'ellipse', 'arrow', 'blur']);

@Component({
  selector: 'ha-image-annotator',
  imports: [UpperCasePipe, DecimalPipe, FormsModule, MatButtonModule, MatIconModule, MatTooltipModule, MatSnackBarModule],
  templateUrl: './image-annotator.html',
  styleUrl: './image-annotator.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageAnnotator implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);

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
  readonly labelPositions: Array<{ id: LabelPos; icon: string; label: string }> = [
    { id: 'top', icon: 'vertical_align_top', label: 'Caption above' },
    { id: 'bottom', icon: 'vertical_align_bottom', label: 'Caption below' },
    { id: 'left', icon: 'format_align_left', label: 'Caption left' },
    { id: 'right', icon: 'format_align_right', label: 'Caption right' },
    { id: 'none', icon: 'block', label: 'No caption' },
  ];

  readonly tool = signal<Tool>('rect');
  readonly color = signal<string>('#e53935');
  readonly thickness = signal<number>(6);
  readonly blurRadius = signal<number>(12);
  readonly zoom = signal<number>(1);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly dirty = signal(false);

  readonly mediaOpen = signal(false);
  readonly layersOpen = signal(true);
  readonly mediaList = signal<MediaAsset[]>([]);

  readonly asset = signal<MediaAsset | null>(null);
  readonly shapes = signal<ImageAnnotation[]>([]);
  readonly selectedIds = signal<Set<string>>(new Set());
  readonly collapsedGroups = signal<Set<string>>(new Set());

  altText = '';

  private img = new Image();
  private naturalW = 0;
  private naturalH = 0;
  private history: string[] = [];
  private assetId = '';

  // Drag state
  private dragging = false;
  private startPt = { x: 0, y: 0 };
  private draft: ImageAnnotation | null = null;
  private moveId: string | null = null;
  private moveOffset = { x: 0, y: 0 };

  readonly canUndo = computed(() => this.history.length > 0);
  readonly selectedShape = computed<ImageAnnotation | null>(() => {
    const ids = this.selectedIds();
    if (ids.size !== 1) return null;
    const id = [...ids][0];
    return this.shapes().find((s) => s.id === id) ?? null;
  });
  readonly canGroup = computed(() => this.selectedIds().size >= 2);
  readonly canUngroup = computed(() => {
    const sel = this.shapes().filter((s) => s.id && this.selectedIds().has(s.id));
    return sel.some((s) => s.groupId);
  });

  /** Layer rows, top of the stack first, grouped members nested. */
  readonly layerRows = computed<LayerRow[]>(() => {
    const rows: LayerRow[] = [];
    const seen = new Set<string>();
    const list = this.shapes();
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (s.groupId) {
        if (seen.has(s.groupId)) continue;
        seen.add(s.groupId);
        const members = list.filter((m) => m.groupId === s.groupId).reverse();
        rows.push({ kind: 'group', groupId: s.groupId, members });
      } else {
        rows.push({ kind: 'shape', shape: s });
      }
    }
    return rows;
  });

  ngOnInit(): void {
    this.assetId = this.route.snapshot.paramMap.get('id') ?? '';
    this.loadAsset(this.assetId);
  }

  private loadAsset(id: string): void {
    this.loading.set(true);
    this.api.getMedia(id).subscribe({
      next: ({ asset }) => {
        this.assetId = asset.id;
        this.asset.set(asset);
        this.altText = asset.altText ?? '';
        const shapes = Array.isArray(asset.annotations) ? asset.annotations : [];
        this.shapes.set(shapes.map((s) => ({ ...s, id: s.id ?? safeUUID() })));
        this.history = [];
        this.selectedIds.set(new Set());
        this.dirty.set(false);
        this.loadImage(asset.originalUrl || asset.publicUrl);
      },
      error: () => { this.loading.set(false); this.snack.open('Could not load image', 'OK', { duration: 4000 }); },
    });
  }

  private loadImage(url: string): void {
    this.img = new Image();
    this.img.crossOrigin = 'anonymous';
    this.img.onload = () => {
      this.naturalW = this.img.naturalWidth;
      this.naturalH = this.img.naturalHeight;
      queueMicrotask(() => {
        const c = this.canvasRef?.nativeElement;
        if (c) { c.width = this.naturalW; c.height = this.naturalH; }
        this.fitZoom();
        this.loading.set(false);
        this.redraw();
      });
    };
    this.img.onerror = () => { this.loading.set(false); this.snack.open('Image failed to load', 'OK', { duration: 4000 }); };
    this.img.src = url + (url.includes('?') ? '&' : '?') + 'v=' + (this.asset()?.editedAt ?? this.assetId);
  }

  // ── Toolbar ────────────────────────────────────────────────────────────────
  setTool(t: Tool): void {
    this.tool.set(t);
    if (t === 'blur') this.thickness.set(this.blurRadius());
    if (t !== 'select') this.selectedIds.set(new Set());
  }
  setColor(c: string): void {
    this.color.set(c);
    this.applyToSelection((s) => { s.color = c; });
  }
  onThickness(v: number): void {
    this.thickness.set(v);
    this.applyToSelection((s) => { if (s.type !== 'blur') s.thickness = v; });
  }
  onBlurRadius(v: number): void {
    this.blurRadius.set(v);
    this.applyToSelection((s) => { if (s.type === 'blur') { s.blurRadius = v; s.thickness = v; } });
  }

  private applyToSelection(mut: (s: ImageAnnotation) => void): void {
    const ids = this.selectedIds();
    if (!ids.size) return;
    this.pushHistory();
    const next = this.shapes().map((s) => (s.id && ids.has(s.id) ? (mut(s), { ...s }) : s));
    this.shapes.set(next);
    this.redraw();
  }

  // ── History ────────────────────────────────────────────────────────────────
  private pushHistory(): void {
    this.history = [...this.history, JSON.stringify(this.shapes())].slice(-60);
    this.dirty.set(true);
  }
  undo(): void {
    if (!this.history.length) return;
    const prev = this.history[this.history.length - 1];
    this.history = this.history.slice(0, -1);
    this.shapes.set(JSON.parse(prev) as ImageAnnotation[]);
    this.selectedIds.set(new Set());
    this.redraw();
  }
  clearAll(): void {
    if (!this.shapes().length) return;
    this.pushHistory();
    this.shapes.set([]);
    this.selectedIds.set(new Set());
    this.redraw();
  }
  deleteSelected(): void {
    const ids = this.selectedIds();
    if (!ids.size) return;
    this.pushHistory();
    this.shapes.set(this.shapes().filter((s) => !(s.id && ids.has(s.id))));
    this.selectedIds.set(new Set());
    this.redraw();
  }

  // ── Selection & layers ──────────────────────────────────────────────────────
  isSelected(id?: string): boolean { return !!id && this.selectedIds().has(id); }

  selectLayer(id: string | undefined, additive = false): void {
    if (!id) return;
    const next = new Set(additive ? this.selectedIds() : []);
    if (additive && next.has(id)) next.delete(id); else next.add(id);
    this.selectedIds.set(next);
    this.redraw();
  }
  selectGroup(groupId: string): void {
    const ids = new Set<string>();
    this.shapes().forEach((s) => { if (s.groupId === groupId && s.id) ids.add(s.id); });
    this.selectedIds.set(ids);
    this.redraw();
  }

  toggleHidden(shape: ImageAnnotation): void {
    this.pushHistory();
    this.shapes.set(this.shapes().map((s) => (s.id === shape.id ? { ...s, hidden: !s.hidden } : s)));
    this.redraw();
  }
  toggleGroupHidden(groupId: string): void {
    this.pushHistory();
    const anyVisible = this.shapes().some((s) => s.groupId === groupId && !s.hidden);
    this.shapes.set(this.shapes().map((s) => (s.groupId === groupId ? { ...s, hidden: anyVisible } : s)));
    this.redraw();
  }
  toggleCollapse(groupId: string): void {
    const next = new Set(this.collapsedGroups());
    if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
    this.collapsedGroups.set(next);
  }
  isCollapsed(groupId: string): boolean { return this.collapsedGroups().has(groupId); }
  groupVisible(groupId: string): boolean { return this.shapes().some((s) => s.groupId === groupId && !s.hidden); }

  group(): void {
    if (!this.canGroup()) return;
    const ids = this.selectedIds();
    const gid = safeUUID();
    this.pushHistory();
    this.shapes.set(this.shapes().map((s) => (s.id && ids.has(s.id) ? { ...s, groupId: gid } : s)));
  }
  ungroup(): void {
    const ids = this.selectedIds();
    this.pushHistory();
    this.shapes.set(this.shapes().map((s) => (s.id && ids.has(s.id) ? { ...s, groupId: null } : s)));
  }

  // ── Z-order (on the single selected shape) ─────────────────────────────────
  private reorder(dir: 'front' | 'forward' | 'backward' | 'back'): void {
    const sel = this.selectedShape();
    if (!sel) return;
    const list = [...this.shapes()];
    const i = list.findIndex((s) => s.id === sel.id);
    if (i < 0) return;
    this.pushHistory();
    list.splice(i, 1);
    if (dir === 'front') list.push(sel);
    else if (dir === 'back') list.unshift(sel);
    else if (dir === 'forward') list.splice(Math.min(list.length, i + 1), 0, sel);
    else list.splice(Math.max(0, i - 1), 0, sel);
    this.shapes.set(list);
    this.redraw();
  }
  toFront(): void { this.reorder('front'); }
  forward(): void { this.reorder('forward'); }
  backward(): void { this.reorder('backward'); }
  toBack(): void { this.reorder('back'); }

  // ── Caption / properties ─────────────────────────────────────────────────────
  setLabelText(text: string): void { this.applyToSelection((s) => { s.label = text; }); }
  setLabelPos(pos: LabelPos): void { this.applyToSelection((s) => { s.labelPos = pos; }); }

  layerName(s: ImageAnnotation): string {
    if (s.label) return s.label;
    if (s.type === 'text') return s.text ?? 'Text';
    if (s.type === 'badge') return 'Badge ' + (s.number ?? '');
    return s.type.charAt(0).toUpperCase() + s.type.slice(1);
  }
  layerIcon(t: ImageAnnotation['type']): string {
    return this.tools.find((x) => x.id === t)?.icon ?? 'crop_square';
  }

  // ── Zoom ────────────────────────────────────────────────────────────────────
  get canvasCssWidth(): number { return Math.round(this.naturalW * this.zoom()); }
  zoomIn(): void { this.zoom.set(Math.min(4, +(this.zoom() + 0.2).toFixed(2))); }
  zoomOut(): void { this.zoom.set(Math.max(0.1, +(this.zoom() - 0.2).toFixed(2))); }
  zoomReset(): void { this.zoom.set(1); }
  fitZoom(): void {
    const stage = this.canvasRef?.nativeElement.parentElement;
    if (!stage || !this.naturalW) { this.zoom.set(1); return; }
    const pad = 48;
    const z = Math.min((stage.clientWidth - pad) / this.naturalW, (stage.clientHeight - pad) / this.naturalH, 1);
    this.zoom.set(+Math.max(0.1, z).toFixed(2));
  }
  onWheel(e: WheelEvent): void {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (e.deltaY < 0) this.zoomIn(); else this.zoomOut();
  }

  // ── Pointer → natural pixels ─────────────────────────────────────────────────
  private toNatural(e: PointerEvent): { x: number; y: number } {
    const c = this.canvasRef!.nativeElement;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  }

  onPointerDown(e: PointerEvent): void {
    if (this.loading()) return;
    const pt = this.toNatural(e);
    this.canvasRef!.nativeElement.setPointerCapture(e.pointerId);
    const t = this.tool();

    if (t === 'select') {
      const hit = this.hitTest(pt.x, pt.y);
      if (hit) {
        if (e.shiftKey || e.ctrlKey) this.selectLayer(hit.id, true);
        else if (!this.isSelected(hit.id)) this.selectLayer(hit.id, false);
        this.moveId = hit.id ?? null;
        this.dragging = true;
        this.pushHistory();
        this.moveOffset = { x: pt.x, y: pt.y };
      } else {
        this.selectedIds.set(new Set());
        this.redraw();
      }
      return;
    }

    if (t === 'text') {
      const text = window.prompt('Text label:')?.trim();
      if (text) {
        this.pushHistory();
        this.shapes.set([...this.shapes(), { id: safeUUID(), type: 'text', color: this.color(),
          thickness: this.thickness(), x: pt.x, y: pt.y, text, fontSize: Math.max(16, this.thickness() * 4) }]);
        this.redraw();
      }
      return;
    }
    if (t === 'badge') {
      this.pushHistory();
      const n = this.shapes().filter((s) => s.type === 'badge').length + 1;
      this.shapes.set([...this.shapes(), { id: safeUUID(), type: 'badge', color: this.color(),
        thickness: this.thickness(), x: pt.x, y: pt.y, number: n }]);
      this.redraw();
      return;
    }

    this.dragging = true;
    this.startPt = pt;
    if (t === 'pen') {
      this.draft = { id: safeUUID(), type: 'pen', color: this.color(), thickness: this.thickness(), points: [pt] };
    } else {
      const tt = t as Exclude<Tool, 'select' | 'text' | 'badge' | 'pen'>;
      this.draft = { id: safeUUID(), type: tt, color: this.color(),
        thickness: tt === 'blur' ? this.blurRadius() : this.thickness(),
        blurRadius: tt === 'blur' ? this.blurRadius() : undefined,
        x: pt.x, y: pt.y, w: 0, h: 0, x2: pt.x, y2: pt.y };
    }
  }

  onPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const pt = this.toNatural(e);

    if (this.tool() === 'select' && this.moveId) {
      const dx = pt.x - this.moveOffset.x, dy = pt.y - this.moveOffset.y;
      this.moveOffset = pt;
      const ids = this.selectedIds();
      this.shapes.set(this.shapes().map((s) => (s.id && ids.has(s.id) ? this.translated(s, dx, dy) : s)));
      this.redraw();
      return;
    }

    if (!this.draft) return;
    if (this.draft.type === 'pen') this.draft.points!.push(pt);
    else if (this.draft.type === 'arrow') { this.draft.x2 = pt.x; this.draft.y2 = pt.y; }
    else {
      this.draft.x = Math.min(this.startPt.x, pt.x);
      this.draft.y = Math.min(this.startPt.y, pt.y);
      this.draft.w = Math.abs(pt.x - this.startPt.x);
      this.draft.h = Math.abs(pt.y - this.startPt.y);
    }
    this.redraw(this.draft);
  }

  onPointerUp(): void {
    if (this.tool() === 'select') { this.dragging = false; this.moveId = null; return; }
    if (!this.dragging || !this.draft) { this.dragging = false; return; }
    this.dragging = false;
    const d = this.draft;
    this.draft = null;
    const big = d.type === 'pen' ? (d.points?.length ?? 0) > 2
      : d.type === 'arrow' ? Math.hypot((d.x2 ?? 0) - (d.x ?? 0), (d.y2 ?? 0) - (d.y ?? 0)) > 6
        : (d.w ?? 0) > 5 && (d.h ?? 0) > 5;
    if (!big) { this.redraw(); return; }
    // Auto-caption for framing shapes.
    if (CAPTIONED.has(d.type as Tool)) { d.label = 'Label'; d.labelPos = 'bottom'; }
    this.pushHistory();
    this.shapes.set([...this.shapes(), d]);
    if (d.id) this.selectedIds.set(new Set([d.id]));
    this.redraw();
  }

  private translated(s: ImageAnnotation, dx: number, dy: number): ImageAnnotation {
    const n = { ...s };
    if (n.type === 'pen' && n.points) n.points = n.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    if (n.x != null) n.x += dx;
    if (n.y != null) n.y += dy;
    if (n.x2 != null) n.x2 += dx;
    if (n.y2 != null) n.y2 += dy;
    return n;
  }

  private hitTest(x: number, y: number): ImageAnnotation | null {
    const list = this.shapes();
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (s.hidden) continue;
      const pad = Math.max(8, s.thickness);
      const b = this.bounds(s);
      if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) return s;
    }
    return null;
  }

  // ── Rendering ────────────────────────────────────────────────────────────────
  private redraw(extra?: ImageAnnotation): void {
    const c = this.canvasRef?.nativeElement;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (this.naturalW) ctx.drawImage(this.img, 0, 0, c.width, c.height);
    const all = extra ? [...this.shapes(), extra] : this.shapes();
    for (const s of all) {
      if (s.hidden) continue;
      this.drawShape(ctx, s);
      if (s.id && this.selectedIds().has(s.id) && !extra) this.drawSelection(ctx, s);
    }
  }

  private drawShape(ctx: CanvasRenderingContext2D, s: ImageAnnotation): void {
    ctx.save();
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
    ctx.lineWidth = s.thickness; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    switch (s.type) {
      case 'rect': ctx.strokeRect(s.x ?? 0, s.y ?? 0, s.w ?? 0, s.h ?? 0); break;
      case 'ellipse': {
        const rx = (s.w ?? 0) / 2, ry = (s.h ?? 0) / 2;
        ctx.beginPath();
        ctx.ellipse((s.x ?? 0) + rx, (s.y ?? 0) + ry, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
        ctx.stroke(); break;
      }
      case 'arrow': this.drawArrow(ctx, s.x ?? 0, s.y ?? 0, s.x2 ?? 0, s.y2 ?? 0, s.thickness); break;
      case 'pen':
        if (s.points?.length) {
          ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y);
          s.points.forEach((p) => ctx.lineTo(p.x, p.y)); ctx.stroke();
        } break;
      case 'text':
        ctx.font = `600 ${s.fontSize ?? 20}px Inter, Arial, sans-serif`;
        ctx.textBaseline = 'top'; ctx.fillText(s.text ?? '', s.x ?? 0, s.y ?? 0); break;
      case 'badge': {
        const r = s.thickness * 3 + 8;
        ctx.beginPath(); ctx.arc(s.x ?? 0, s.y ?? 0, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `700 ${r}px Inter, Arial, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(s.number ?? 1), s.x ?? 0, (s.y ?? 0) + 1); break;
      }
      case 'blur': {
        const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 0, h = s.h ?? 0;
        if (w > 0 && h > 0 && this.naturalW) {
          ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
          ctx.filter = `blur(${Math.max(4, s.blurRadius ?? s.thickness)}px)`;
          ctx.drawImage(this.img, 0, 0, this.naturalW, this.naturalH); ctx.restore();
        } break;
      }
    }
    if (s.label && s.labelPos && s.labelPos !== 'none') this.drawCaption(ctx, s);
    ctx.restore();
  }

  private drawCaption(ctx: CanvasRenderingContext2D, s: ImageAnnotation): void {
    const b = this.bounds(s);
    const fs = Math.max(15, Math.round(this.naturalW / 60));
    ctx.font = `600 ${fs}px Inter, Arial, sans-serif`;
    const tw = ctx.measureText(s.label!).width;
    const padX = fs * 0.4, padY = fs * 0.25, gap = fs * 0.6;
    let tx = b.x + b.w / 2, ty = b.y + b.h + gap, align: CanvasTextAlign = 'center', baseline: CanvasTextBaseline = 'top';
    if (s.labelPos === 'top') { ty = b.y - gap - fs; }
    else if (s.labelPos === 'left') { tx = b.x - gap; ty = b.y + b.h / 2 - fs / 2; align = 'right'; }
    else if (s.labelPos === 'right') { tx = b.x + b.w + gap; ty = b.y + b.h / 2 - fs / 2; align = 'left'; }
    const boxX = align === 'center' ? tx - tw / 2 : align === 'right' ? tx - tw : tx;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    this.roundRect(ctx, boxX - padX, ty - padY, tw + padX * 2, fs + padY * 2, 4);
    ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = align; ctx.textBaseline = baseline;
    ctx.fillText(s.label!, tx, ty);
  }
  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private drawSelection(ctx: CanvasRenderingContext2D, s: ImageAnnotation): void {
    const b = this.bounds(s);
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#1e88e5';
    ctx.lineWidth = Math.max(1.5, this.naturalW / 700);
    ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
    ctx.restore();
  }

  private drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, th: number): void {
    const head = Math.max(10, th * 2.5), ang = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
    ctx.closePath(); ctx.fill();
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

  // ── Media panel ──────────────────────────────────────────────────────────────
  toggleMedia(): void {
    const open = !this.mediaOpen();
    this.mediaOpen.set(open);
    if (open && !this.mediaList().length) {
      this.api.listMedia(1, 60).subscribe({ next: (r) => this.mediaList.set(r.data), error: () => { /* noop */ } });
    }
  }
  switchTo(a: MediaAsset): void {
    if (a.id === this.assetId) return;
    if (this.dirty() && !confirm('Discard unsaved changes and open another image?')) return;
    void this.router.navigate(['/admin/media', a.id, 'edit']);
    this.loadAsset(a.id); // param may not re-init the component; load explicitly
  }
  onUpload(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    this.api.uploadMedia(file).subscribe({
      next: ({ asset }) => {
        this.mediaList.set([asset, ...this.mediaList()]);
        this.switchTo(asset);
      },
      error: (err) => this.snack.open(err.error?.error?.message ?? 'Upload failed', 'OK', { duration: 4000 }),
    });
  }

  // ── Save / navigation ────────────────────────────────────────────────────────
  save(): void {
    const c = this.canvasRef?.nativeElement;
    if (!c || this.saving()) return;
    this.selectedIds.set(new Set());
    this.redraw();
    this.saving.set(true);
    c.toBlob((blob) => {
      if (!blob) { this.saving.set(false); this.snack.open('Could not render image', 'OK', { duration: 4000 }); return; }
      this.api.annotateMedia(this.assetId, blob, this.shapes(), this.naturalW, this.naturalH, this.altText).subscribe({
        next: ({ asset }) => {
          this.saving.set(false);
          this.dirty.set(false);
          this.asset.set(asset);
          this.snack.open('Image saved', undefined, { duration: 2000 });
        },
        error: (err) => { this.saving.set(false); this.snack.open(err.error?.error?.message ?? 'Save failed', 'OK', { duration: 4000 }); },
      });
    }, 'image/png');
  }

  back(): void {
    if (this.dirty() && !confirm('Leave without saving? Your changes will be lost.')) return;
    if (window.history.length > 1) this.location.back();
    else void this.router.navigate(['/admin/media']);
  }
}
