import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import { ConfirmService } from '../../../../core/services/confirm.service';
import type { TrashItem } from '../../../../core/models/admin';

/**
 * Trash — deleted items, restorable until their retention window runs out.
 *
 * Sorted by what disappears soonest rather than by type: the useful question
 * here is "what am I about to lose", not "what kind of thing is this".
 */
@Component({
  selector: 'ha-trash-list',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
    MatSnackBarModule,
    MatTooltipModule,
  ],
  templateUrl: './trash-list.html',
  styleUrl: './trash-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashList implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly confirm = inject(ConfirmService);
  private readonly snack = inject(MatSnackBar);

  readonly loading = signal(true);
  readonly error = signal('');
  readonly items = signal<TrashItem[]>([]);
  readonly retentionDays = signal(30);
  readonly busyId = signal<string | null>(null);
  readonly search = signal('');
  readonly typeFilter = signal('');

  readonly types = computed(() => {
    const seen = new Map<string, number>();
    for (const item of this.items()) {
      seen.set(item.typeLabel, (seen.get(item.typeLabel) ?? 0) + 1);
    }
    return [...seen.entries()].map(([label, count]) => ({ label, count }));
  });

  readonly filtered = computed(() => {
    const term = this.search().trim().toLowerCase();
    const type = this.typeFilter();
    return this.items().filter((item) => {
      if (type && item.typeLabel !== type) return false;
      if (!term) return true;
      return (
        item.label.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term)
      );
    });
  });

  /** Items about to be lost, which is the only urgent thing on this screen. */
  readonly expiringSoon = computed(() => this.items().filter((i) => i.daysLeft <= 3).length);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api.listTrash().subscribe({
      next: (res) => {
        this.items.set(res.items);
        this.retentionDays.set(res.retentionDays);
        this.loading.set(false);
      },
      error: (err: { error?: { message?: string } }) => {
        this.error.set(err.error?.message ?? 'Could not load the trash.');
        this.loading.set(false);
      },
    });
  }

  restore(item: TrashItem): void {
    this.busyId.set(item.id);
    this.api.restoreFromTrash(item.entityType, item.id).subscribe({
      next: () => {
        this.busyId.set(null);
        this.items.update((list) => list.filter((i) => i.id !== item.id));
        this.snack.open(`"${item.label}" restored`, undefined, { duration: 2500 });
      },
      error: (err: { error?: { message?: string } }) => {
        this.busyId.set(null);
        this.snack.open(err.error?.message ?? 'Could not restore that item.', 'OK', {
          duration: 4000,
        });
      },
    });
  }

  async remove(item: TrashItem): Promise<void> {
    if (!(await this.confirm.confirmPermanentDelete(`"${item.label}"`))) return;

    this.busyId.set(item.id);
    this.api.deleteFromTrash(item.entityType, item.id).subscribe({
      next: () => {
        this.busyId.set(null);
        this.items.update((list) => list.filter((i) => i.id !== item.id));
        this.snack.open(`"${item.label}" deleted permanently`, undefined, { duration: 2500 });
      },
      error: (err: { error?: { message?: string } }) => {
        this.busyId.set(null);
        this.snack.open(err.error?.message ?? 'Could not delete that item.', 'OK', {
          duration: 4000,
        });
      },
    });
  }

  /** Empty everything currently listed, one request per item. */
  async emptyAll(): Promise<void> {
    const items = this.filtered();
    if (items.length === 0) return;

    const ok = await this.confirm.ask({
      title: `Empty the trash?`,
      message: `${items.length} item(s) and their files will be removed for good.`,
      note: 'This cannot be undone.',
      confirmLabel: `Delete ${items.length} item(s)`,
      destructive: true,
    });
    if (!ok) return;

    this.loading.set(true);
    let failed = 0;
    for (const item of items) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.api.deleteFromTrash(item.entityType, item.id).subscribe({
            next: () => resolve(),
            error: (err: unknown) => reject(err as Error),
          });
        });
      } catch {
        // Keep going: one item a role cannot purge should not block the rest.
        failed += 1;
      }
    }

    this.load();
    if (failed > 0) {
      this.snack.open(`${failed} item(s) could not be deleted.`, 'OK', { duration: 4000 });
    }
  }

  clearFilters(): void {
    this.search.set('');
    this.typeFilter.set('');
  }

  /** "in 12 days" reads better than a date for something on a countdown. */
  expiry(item: TrashItem): string {
    if (item.daysLeft <= 0) return 'deletes today';
    if (item.daysLeft === 1) return 'deletes tomorrow';
    return `deletes in ${item.daysLeft} days`;
  }

  when(iso: string): string {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return '';
    return then.toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
