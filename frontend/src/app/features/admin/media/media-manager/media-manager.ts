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
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { Router } from '@angular/router';
import { AdminApiService } from '../../../../core/services/admin-api';
import { ImageViewer } from '../../../../core/components/image-viewer/image-viewer';
import type { MediaAsset, PaginatedResponse } from '../../../../core/models/admin';

const PAGE_SIZE = 24;

@Component({
  selector: 'ha-media-manager',
  imports: [
    MatButtonModule, MatIconModule, MatProgressBarModule,
    MatSnackBarModule, MatTooltipModule, MatFormFieldModule,
    MatInputModule, MatPaginatorModule, ImageViewer,
  ],
  templateUrl: './media-manager.html',
  styleUrl: './media-manager.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaManager implements OnInit {
  private readonly api    = inject(AdminApiService);
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

  /** Days a trashed item is kept before automatic permanent deletion. */
  readonly retentionDays = computed(() => this.trash()?.meta.retentionDays ?? 30);

  ngOnInit(): void { this.load(); }

  // ── Loading ─────────────────────────────────────────────────────────────────
  load(page = 1): void {
    this.livePage = page;
    this.loading.set(true);
    this.api.listMedia(page, PAGE_SIZE).subscribe({
      next:  res => { this.data.set(res); this.loading.set(false); },
      error: ()  => this.loading.set(false),
    });
  }

  loadTrash(page = 1): void {
    this.trashPage = page;
    this.loading.set(true);
    this.api.listTrash(page, PAGE_SIZE).subscribe({
      next:  res => { this.trash.set(res); this.loading.set(false); },
      error: ()  => this.loading.set(false),
    });
  }

  toggleTrash(show: boolean): void {
    if (this.showTrash() === show) return;
    this.showTrash.set(show);
    this.search.set('');
    if (show) this.loadTrash(1); else this.load(1);
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
  delete(asset: MediaAsset): void {
    if (!confirm(`Move "${asset.originalName}" to the trash?`)) return;
    this.api.deleteMedia(asset.id).subscribe({
      next: () => {
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
        this.snack.open('Restored', undefined, { duration: 2000 });
        this.loadTrash(this.trashPage);
        this.data.set(null); // library will refetch on return
      },
      error: () => this.snack.open('Restore failed', 'OK', { duration: 3000 }),
    });
  }

  purge(asset: MediaAsset): void {
    if (!confirm(`Permanently delete "${asset.originalName}"? This cannot be undone.`)) return;
    this.api.purgeMedia(asset.id).subscribe({
      next: () => {
        this.snack.open('Permanently deleted', undefined, { duration: 2000 });
        this.loadTrash(this.trashPage);
      },
      error: () => this.snack.open('Delete failed', 'OK', { duration: 3000 }),
    });
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
