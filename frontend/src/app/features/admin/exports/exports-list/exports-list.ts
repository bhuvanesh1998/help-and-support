import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import type { ExportRecord } from '../../../../core/models/admin';

@Component({
  selector: 'ha-exports-list',
  imports: [DatePipe, MatButtonModule, MatIconModule, MatSnackBarModule, MatTooltipModule],
  templateUrl: './exports-list.html',
  styleUrl: './exports-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExportsList implements OnInit, OnDestroy {
  private readonly api   = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);

  readonly loading     = signal(true);
  readonly exports     = signal<ExportRecord[]>([]);
  readonly downloading = signal<string | null>(null);

  // Auto-refresh while anything is still generating.
  readonly anyPending = computed(() => this.exports().some((e) => e.status === 'pending'));
  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => {
      if (this.anyPending()) this.load(true);
    }, 3000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.api.listExports().subscribe({
      next: (res) => { this.exports.set(res.data); this.loading.set(false); },
      error: ()    => this.loading.set(false),
    });
  }

  download(exp: ExportRecord): void {
    if (exp.status !== 'ready') return;
    this.downloading.set(exp.id);
    this.api.downloadExport(exp.id).subscribe({
      next: (blob) => {
        this.downloading.set(null);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = exp.filename ?? `export.${exp.format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      },
      error: () => {
        this.downloading.set(null);
        this.snack.open('Download failed', 'OK', { duration: 3000 });
      },
    });
  }

  remove(exp: ExportRecord): void {
    if (!confirm('Delete this export file?')) return;
    this.api.deleteExport(exp.id).subscribe({
      next: () => { this.snack.open('Export deleted', undefined, { duration: 2000 }); this.load(); },
      error: () => this.snack.open('Delete failed', 'OK', { duration: 3000 }),
    });
  }

  formatBytes(bytes: number | null): string {
    if (!bytes) return '—';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
