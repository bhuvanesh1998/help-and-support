import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { Router } from '@angular/router';
import {
  AdminApiService,
  type MediaBulkAction,
  type MediaBulkTarget,
  type MediaCategoriesResponse,
  type MediaDateRange,
} from '../../../../core/services/admin-api';
import { downloadFile, safeFilename, saveBlob } from '../../../../core/utils/download-file';
import { ConfirmService } from '../../../../core/services/confirm.service';
import { ImageViewer } from '../../../../core/components/image-viewer/image-viewer';
import type { MediaAsset, PaginatedResponse } from '../../../../core/models/admin';

const PAGE_SIZE = 24;

/** `YYYY-MM-DD` for a local date — the value format of `<input type="date">`. */
function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Pull the API's error message out of a JSON or blob (`responseType: 'blob'`) error body. */
async function errorMessage(err: unknown, fallback: string): Promise<string> {
  const body = (err as { error?: unknown })?.error;
  try {
    const json = body instanceof Blob ? JSON.parse(await body.text()) : body;
    return (json as { error?: { message?: string } })?.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

@Component({
  selector: 'ha-media-manager',
  imports: [
    MatButtonModule, MatIconModule, MatProgressBarModule,
    MatSnackBarModule, MatTooltipModule, MatFormFieldModule,
    MatInputModule, MatPaginatorModule, MatCheckboxModule, ImageViewer,
  ],
  templateUrl: './media-manager.html',
  styleUrl: './media-manager.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaManager implements OnInit {
  private readonly api    = inject(AdminApiService);
  private readonly confirm = inject(ConfirmService);
  private readonly snack  = inject(MatSnackBar);
  private readonly router = inject(Router);

  @ViewChild('fileInput') fileInputRef!: ElementRef<HTMLInputElement>;

  readonly pageSize = PAGE_SIZE;

  readonly loading    = signal(true);
  readonly uploading  = signal(false);
  readonly dragOver   = signal(false);
  readonly data       = signal<PaginatedResponse<MediaAsset> | null>(null);
  readonly trash      = signal<PaginatedResponse<MediaAsset> | null>(null);
  readonly search     = signal('');
  readonly showTrash  = signal(false);

  /** Upload-date filter, as `<input type="date">` values (local days). */
  readonly dateFrom   = signal('');
  readonly dateTo     = signal('');
  readonly today      = isoDay(new Date());

  /** Guide-category filter ('' = all) and the options for it. */
  readonly category   = signal('');
  readonly categories = signal<MediaCategoriesResponse | null>(null);

  /** Bulk selection. Explicit ids persist across pages; `allMatching` means every item in the filter. */
  readonly selected    = signal<ReadonlySet<string>>(new Set());
  readonly allMatching = signal(false);
  readonly bulkBusy    = signal(false);

  /** Full-screen viewer state. */
  readonly previewUrl = signal<string | null>(null);
  readonly viewerUrl  = signal<string | null>(null);

  private livePage  = 1;
  private trashPage = 1;

  /** The paginated response backing whichever view is active. */
  readonly active = computed(() => (this.showTrash() ? this.trash() : this.data()));

  readonly filtered = computed(() => {
    const q      = this.search().toLowerCase().trim();
    const assets = this.active()?.data ?? [];
    if (!q) return assets;
    return assets.filter(
      a =>
        a.originalName.toLowerCase().includes(q) ||
        (a.altText ?? '').toLowerCase().includes(q) ||
        a.mimeType.toLowerCase().includes(q),
    );
  });

  /** All visible image URLs — lets the viewer page through the gallery. */
  readonly galleryUrls = computed(() => this.filtered().map((a) => a.publicUrl));

  /** The asset currently shown in the viewer (matched by URL for prev/next). */
  readonly viewerAsset = computed(
    () => this.filtered().find((a) => a.publicUrl === this.viewerUrl()) ?? null,
  );

  readonly hasDateFilter = computed(() => !!(this.dateFrom() || this.dateTo()));
  readonly hasFilter     = computed(() => this.hasDateFilter() || !!this.category());

  /** Human label of the active filter, for the bulk bar and empty state. */
  readonly filterLabel = computed(() => {
    const parts: string[] = [];
    const cat = this.category();
    if (cat) parts.push(cat === this.categories()?.noCategoryKey ? 'not in a guide' : `in ${cat}`);
    if (this.hasDateFilter()) parts.push('in date range');
    return parts.join(', ');
  });

  /** Number of items a bulk action would touch. */
  readonly selectionCount = computed(() =>
    this.allMatching() ? (this.active()?.meta.total ?? 0) : this.selected().size,
  );
  readonly selectionMode = computed(() => this.selectionCount() > 0);

  /** Whether every visible card is selected (drives the header checkbox). */
  readonly pageAllSelected = computed(() => {
    const items = this.filtered();
    if (!items.length) return false;
    if (this.allMatching()) return true;
    const sel = this.selected();
    return items.every((a) => sel.has(a.id));
  });
  readonly pageSomeSelected = computed(
    () => !this.pageAllSelected() && this.filtered().some((a) => this.isSelected(a)),
  );

  /** Offer "select all N" when the whole page is selected but more items match. */
  readonly canSelectAllMatching = computed(() => {
    const total = this.active()?.meta.total ?? 0;
    return !this.allMatching() && !this.search() && this.pageAllSelected() && total > this.filtered().length;
  });

  /** Days a trashed item is kept before automatic permanent deletion. */
  readonly retentionDays = computed(() => this.trash()?.meta.retentionDays ?? 30);

  ngOnInit(): void { this.load(); this.loadCategories(); }

  /** Esc leaves selection mode (the viewer handles its own Esc while open). */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.previewUrl() && this.selectionMode()) this.clearSelection();
  }

  // ── Loading ─────────────────────────────────────────────────────────────────
  /** The date inputs as inclusive instants: local start of `from`, local end of `to`. */
  private range(): MediaDateRange {
    const from = this.dateFrom();
    const to = this.dateTo();
    const category = this.category();
    return {
      ...(from && { from: new Date(`${from}T00:00:00`).toISOString() }),
      ...(to && { to: new Date(`${to}T23:59:59.999`).toISOString() }),
      ...(category && { category }),
    };
  }

  /** Category options for the active view and date range. */
  private loadCategories(): void {
    this.api.listMediaCategories(this.showTrash() ? 'trash' : 'library', this.range()).subscribe({
      next: (res) => {
        // Keep the active choice listed even if the new range has none of it.
        const cat = this.category();
        const listed = !cat || cat === res.noCategoryKey || res.data.some((c) => c.name === cat);
        this.categories.set(listed ? res : { ...res, data: [...res.data, { name: cat, count: 0 }] });
      },
      error: () => this.categories.set(null),
    });
  }

  load(page = 1): void {
    this.livePage = page;
    this.loading.set(true);
    this.api.listMedia(page, PAGE_SIZE, this.range()).subscribe({
      next:  res => { this.data.set(res); this.loading.set(false); },
      error: ()  => this.loading.set(false),
    });
  }

  loadTrash(page = 1): void {
    this.trashPage = page;
    this.loading.set(true);
    this.api.listMediaTrash(page, PAGE_SIZE, this.range()).subscribe({
      next:  res => { this.trash.set(res); this.loading.set(false); },
      error: ()  => this.loading.set(false),
    });
  }

  toggleTrash(show: boolean): void {
    if (this.showTrash() === show) return;
    this.showTrash.set(show);
    this.search.set('');
    this.clearSelection();
    if (show) this.loadTrash(1); else this.load(1);
    this.loadCategories();
  }

  // ── Date filter ─────────────────────────────────────────────────────────────
  setDateFrom(value: string): void {
    this.dateFrom.set(value);
    if (value && this.dateTo() && value > this.dateTo()) this.dateTo.set(value);
    this.applyDateFilter();
  }

  setDateTo(value: string): void {
    this.dateTo.set(value);
    if (value && this.dateFrom() && value < this.dateFrom()) this.dateFrom.set(value);
    this.applyDateFilter();
  }

  /** Quick range ending today; `days = 1` is today only. */
  setPreset(days: number): void {
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    this.dateFrom.set(isoDay(start));
    this.dateTo.set(this.today);
    this.applyDateFilter();
  }

  isPreset(days: number): boolean {
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    return this.dateFrom() === isoDay(start) && this.dateTo() === this.today;
  }

  clearDateFilter(): void {
    if (!this.hasDateFilter()) return;
    this.dateFrom.set('');
    this.dateTo.set('');
    this.applyDateFilter();
  }

  setCategory(value: string): void {
    this.category.set(value);
    this.applyFilter();
  }

  clearFilters(): void {
    this.dateFrom.set('');
    this.dateTo.set('');
    this.category.set('');
    this.applyDateFilter();
  }

  /** Dates changed: category counts depend on the range, so refresh them too. */
  private applyDateFilter(): void {
    this.loadCategories();
    this.applyFilter();
  }

  private applyFilter(): void {
    this.clearSelection();
    // The other view's cached page was fetched under the old range.
    if (this.showTrash()) { this.data.set(null); this.loadTrash(1); }
    else { this.trash.set(null); this.load(1); }
  }

  // ── Selection ───────────────────────────────────────────────────────────────
  isSelected(asset: MediaAsset): boolean {
    return this.allMatching() || this.selected().has(asset.id);
  }

  toggleSelect(asset: MediaAsset): void {
    if (this.allMatching()) {
      // Leaving "all matching" — keep the visible page selected, minus this one.
      this.allMatching.set(false);
      this.selected.set(new Set(this.filtered().map((a) => a.id).filter((id) => id !== asset.id)));
      return;
    }
    const next = new Set(this.selected());
    if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id);
    this.selected.set(next);
  }

  togglePage(): void {
    if (this.pageAllSelected()) {
      if (this.allMatching()) { this.clearSelection(); return; }
      const next = new Set(this.selected());
      for (const a of this.filtered()) next.delete(a.id);
      this.selected.set(next);
    } else {
      const next = new Set(this.selected());
      for (const a of this.filtered()) next.add(a.id);
      this.selected.set(next);
    }
  }

  selectAllMatching(): void { this.allMatching.set(true); }

  clearSelection(): void {
    this.allMatching.set(false);
    if (this.selected().size) this.selected.set(new Set());
  }

  /** In selection mode a click on the thumbnail toggles it; otherwise it opens the viewer. */
  onThumbClick(asset: MediaAsset): void {
    if (this.selectionMode()) this.toggleSelect(asset);
    else this.openViewer(asset);
  }

  private bulkTarget(): MediaBulkTarget {
    const view = this.showTrash() ? 'trash' : 'library';
    return this.allMatching()
      ? { view, all: true, ...this.range() }
      : { view, ids: [...this.selected()] };
  }

  private selectionLabel(): string {
    const n = this.selectionCount();
    return `${n} ${n === 1 ? 'image' : 'images'}`;
  }

  // ── Bulk actions ────────────────────────────────────────────────────────────
  async bulkTrash(): Promise<void> {
    const ok = await this.confirm.confirmMoveToTrash(this.selectionLabel());
    if (ok) this.runBulk('trash', (n) => `${n} moved to trash`);
  }

  bulkRestore(): void {
    this.runBulk('restore', (n) => `${n} restored`);
  }

  async bulkPurge(): Promise<void> {
    const what = this.selectionLabel();
    const ok = await this.confirm.ask({
      title: `Delete ${what} permanently?`,
      message: this.showTrash()
        ? `${what} and their files will be removed for good.`
        : `${what} will skip the trash and their files will be removed for good. ` +
          `Any guide step still using one of them will lose its image.`,
      note: 'This cannot be undone.',
      confirmLabel: 'Delete permanently',
      destructive: true,
    });
    if (ok) this.runBulk('purge', (n) => `${n} permanently deleted`);
  }

  private runBulk(action: MediaBulkAction, done: (n: number) => string): void {
    this.bulkBusy.set(true);
    this.api.bulkMedia(action, this.bulkTarget()).subscribe({
      next: ({ count }) => {
        this.bulkBusy.set(false);
        this.clearSelection();
        this.snack.open(done(count), undefined, { duration: 2500 });
        this.loadCategories();
        // Items moved between views — refetch this one, invalidate the other.
        if (this.showTrash()) { this.data.set(null); this.loadTrash(this.pageAfterRemoval(this.trashPage, count)); }
        else { this.trash.set(null); this.load(this.pageAfterRemoval(this.livePage, count)); }
      },
      error: async (err) => {
        this.bulkBusy.set(false);
        this.snack.open(await errorMessage(err, 'Bulk action failed'), 'OK', { duration: 4000 });
      },
    });
  }

  /** Stay on the current page unless removing items would leave it past the end. */
  private pageAfterRemoval(page: number, removed: number): number {
    const total = Math.max(0, (this.active()?.meta.total ?? 0) - removed);
    return Math.min(page, Math.max(1, Math.ceil(total / PAGE_SIZE)));
  }

  bulkDownload(): void {
    this.bulkBusy.set(true);
    this.api.downloadMediaZip(this.bulkTarget()).subscribe({
      next: (blob) => {
        this.bulkBusy.set(false);
        saveBlob(blob, `media-${this.today}.zip`);
      },
      error: async (err) => {
        this.bulkBusy.set(false);
        this.snack.open(await errorMessage(err, 'Download failed'), 'OK', { duration: 4000 });
      },
    });
  }

  /**
   * Everything matching the current filters (all categories unless one is
   * picked), zipped into one folder per guide category.
   */
  downloadByCategory(): void {
    const view = this.showTrash() ? 'trash' : 'library';
    const cat = this.category();
    const name = cat && cat !== this.categories()?.noCategoryKey ? safeFilename(cat) : 'by-category';
    this.bulkBusy.set(true);
    this.api.downloadMediaZip({ view, all: true, ...this.range() }, true).subscribe({
      next: (blob) => {
        this.bulkBusy.set(false);
        saveBlob(blob, `media-${name}-${this.today}.zip`);
      },
      error: async (err) => {
        this.bulkBusy.set(false);
        this.snack.open(await errorMessage(err, 'Download failed'), 'OK', { duration: 4000 });
      },
    });
  }

  downloadOne(asset: MediaAsset): void {
    downloadFile(asset.publicUrl, asset.originalName || asset.filename).catch(() =>
      this.snack.open('Download failed', 'OK', { duration: 3000 }),
    );
  }

  onPage(e: PageEvent): void {
    if (this.showTrash()) this.loadTrash(e.pageIndex + 1);
    else this.load(e.pageIndex + 1);
  }

  private reloadActive(): void {
    if (this.showTrash()) this.loadTrash(this.trashPage);
    else this.load(this.livePage);
  }

  // ── Upload ──────────────────────────────────────────────────────────────────
  triggerInput(): void { this.fileInputRef.nativeElement.click(); }

  onFileChange(e: Event): void {
    const files = (e.target as HTMLInputElement).files;
    if (files?.length) this.uploadFiles(Array.from(files));
    (e.target as HTMLInputElement).value = '';
  }

  onDragOver(e: DragEvent): void { e.preventDefault(); this.dragOver.set(true); }
  onDragLeave(): void             { this.dragOver.set(false); }
  onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) this.uploadFiles(files);
  }

  private uploadFiles(files: File[]): void {
    const valid = files.filter(f => f.type.startsWith('image/'));
    if (!valid.length) {
      this.snack.open('Only image files are supported', 'OK', { duration: 3000 });
      return;
    }
    this.uploading.set(true);
    // Upload files one by one
    const uploadNext = (index: number) => {
      if (index >= valid.length) {
        this.uploading.set(false);
        this.load(this.livePage);
        this.snack.open(
          valid.length === 1 ? 'Uploaded successfully' : `${valid.length} files uploaded`,
          undefined, { duration: 2500 },
        );
        return;
      }
      this.api.uploadMedia(valid[index]).subscribe({
        next:  () => uploadNext(index + 1),
        error: err => {
          this.uploading.set(false);
          this.snack.open(err.error?.error?.message ?? 'Upload failed', 'OK', { duration: 4000 });
        },
      });
    };
    uploadNext(0);
  }

  // ── Viewer + alt text ─────────────────────────────────────────────────────────
  openViewer(asset: MediaAsset): void {
    this.viewerUrl.set(asset.publicUrl);
    this.previewUrl.set(asset.publicUrl);
  }
  onViewerCurrentChange(url: string): void { this.viewerUrl.set(url); }
  closePreview(): void { this.previewUrl.set(null); }

  onAltSaved(altText: string): void {
    const asset = this.viewerAsset();
    if (!asset || altText === (asset.altText ?? '')) return;
    this.api.updateMedia(asset.id, altText).subscribe({
      next: () => {
        this.patchAssetAlt(asset.id, altText);
        this.snack.open('Alt text saved', undefined, { duration: 2000 });
      },
      error: () => this.snack.open('Update failed', 'OK', { duration: 3000 }),
    });
  }

  /** Optimistically update alt text in place so the viewer stays open. */
  private patchAssetAlt(id: string, altText: string): void {
    this.data.update(res =>
      res ? { ...res, data: res.data.map(a => (a.id === id ? { ...a, altText } : a)) } : res,
    );
  }

  // ── Trash actions ─────────────────────────────────────────────────────────────
  async delete(asset: MediaAsset): Promise<void> {
    const ok = await this.confirm.confirmMoveToTrash(`"${asset.originalName}"`);
    if (!ok) return;
    this.api.deleteMedia(asset.id).subscribe({
      next: () => {
        this.dropFromSelection(asset.id);
        this.snack.open('Moved to trash', undefined, { duration: 2000 });
        this.load(this.livePage);
        this.trash.set(null); // force a fresh trash count next time it's opened
      },
      error: () => this.snack.open('Delete failed', 'OK', { duration: 3000 }),
    });
  }

  restore(asset: MediaAsset): void {
    this.api.restoreMedia(asset.id).subscribe({
      next: () => {
        this.dropFromSelection(asset.id);
        this.snack.open('Restored', undefined, { duration: 2000 });
        this.loadTrash(this.trashPage);
        this.data.set(null); // library will refetch on return
      },
      error: () => this.snack.open('Restore failed', 'OK', { duration: 3000 }),
    });
  }

  async purge(asset: MediaAsset): Promise<void> {
    const ok = await this.confirm.confirmPermanentDelete(`"${asset.originalName}"`);
    if (!ok) return;
    this.api.purgeMedia(asset.id).subscribe({
      next: () => {
        this.dropFromSelection(asset.id);
        this.snack.open('Permanently deleted', undefined, { duration: 2000 });
        this.loadTrash(this.trashPage);
      },
      error: () => this.snack.open('Delete failed', 'OK', { duration: 3000 }),
    });
  }

  private dropFromSelection(id: string): void {
    if (!this.selected().has(id)) return;
    const next = new Set(this.selected());
    next.delete(id);
    this.selected.set(next);
  }

  copyUrl(asset: MediaAsset): void {
    void navigator.clipboard.writeText(asset.publicUrl);
    this.snack.open('URL copied', undefined, { duration: 1500 });
  }

  /** Open the full-screen annotation editor for an image. */
  editImage(asset: MediaAsset): void {
    void this.router.navigate(['/admin/media', asset.id, 'edit']);
  }

  // ── Formatting ─────────────────────────────────────────────────────────────────
  formatBytes(bytes: number): string {
    if (bytes < 1024)         return `${bytes} B`;
    if (bytes < 1024 * 1024)  return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** Upload date, short and locale-aware — what the date filter matches on. */
  formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** Days remaining before a trashed asset is auto-purged. */
  daysLeft(asset: MediaAsset): number {
    if (!asset.deletedAt) return this.retentionDays();
    const elapsedMs = Date.now() - new Date(asset.deletedAt).getTime();
    const left = this.retentionDays() - Math.floor(elapsedMs / 86_400_000);
    return Math.max(0, left);
  }

  extBadge(mime: string): string {
    if (mime.includes('png'))  return 'PNG';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'JPG';
    if (mime.includes('gif'))  return 'GIF';
    if (mime.includes('webp')) return 'WEBP';
    return mime.split('/')[1]?.toUpperCase() ?? 'IMG';
  }
}
