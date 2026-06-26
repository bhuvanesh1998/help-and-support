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
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { AdminApiService } from '../../../../core/services/admin-api';
import { ImageViewer } from '../../../../core/components/image-viewer/image-viewer';
import type { MediaAsset, PaginatedResponse } from '../../../../core/models/admin';

@Component({
  selector: 'ha-media-manager',
  imports: [
    FormsModule,
    MatButtonModule, MatIconModule, MatProgressBarModule,
    MatSnackBarModule, MatTooltipModule, MatFormFieldModule,
    MatInputModule, MatPaginatorModule, ImageViewer,
  ],
  templateUrl: './media-manager.html',
  styleUrl: './media-manager.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaManager implements OnInit {
  private readonly api   = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);

  @ViewChild('fileInput') fileInputRef!: ElementRef<HTMLInputElement>;

  readonly loading    = signal(true);
  readonly uploading  = signal(false);
  readonly dragOver   = signal(false);
  readonly data       = signal<PaginatedResponse<MediaAsset> | null>(null);
  readonly search     = signal('');
  readonly editingId  = signal<string | null>(null);
  readonly previewUrl = signal<string | null>(null);

  altText  = '';
  private currentPage = 1;

  readonly filtered = computed(() => {
    const q      = this.search().toLowerCase().trim();
    const assets = this.data()?.data ?? [];
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

  ngOnInit(): void { this.load(); }

  load(page = 1): void {
    this.currentPage = page;
    this.loading.set(true);
    this.api.listMedia(page, 24).subscribe({
      next:  res => { this.data.set(res); this.loading.set(false); },
      error: ()  => this.loading.set(false),
    });
  }

  onPage(e: PageEvent): void { this.load(e.pageIndex + 1); }

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
        this.load(this.currentPage);
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

  startEdit(asset: MediaAsset): void {
    this.editingId.set(asset.id);
    this.altText = asset.altText ?? '';
  }

  saveAlt(asset: MediaAsset): void {
    this.api.updateMedia(asset.id, this.altText).subscribe({
      next: () => {
        this.editingId.set(null);
        this.snack.open('Alt text saved', undefined, { duration: 2000 });
        this.load(this.currentPage);
      },
      error: () => this.snack.open('Update failed', 'OK', { duration: 3000 }),
    });
  }

  cancelEdit(): void { this.editingId.set(null); }

  delete(asset: MediaAsset): void {
    if (!confirm(`Delete "${asset.originalName}"? This cannot be undone.`)) return;
    this.api.deleteMedia(asset.id).subscribe({
      next:  () => { this.snack.open('Deleted', undefined, { duration: 2000 }); this.load(this.currentPage); },
      error: () => this.snack.open('Delete failed', 'OK', { duration: 3000 }),
    });
  }

  copyUrl(asset: MediaAsset): void {
    void navigator.clipboard.writeText(asset.publicUrl);
    this.snack.open('URL copied', undefined, { duration: 1500 });
  }

  openPreview(url: string): void  { this.previewUrl.set(url); }
  closePreview(): void            { this.previewUrl.set(null); }

  formatBytes(bytes: number): string {
    if (bytes < 1024)         return `${bytes} B`;
    if (bytes < 1024 * 1024)  return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  extBadge(mime: string): string {
    if (mime.includes('png'))  return 'PNG';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'JPG';
    if (mime.includes('gif'))  return 'GIF';
    if (mime.includes('webp')) return 'WEBP';
    return mime.split('/')[1]?.toUpperCase() ?? 'IMG';
  }
}
