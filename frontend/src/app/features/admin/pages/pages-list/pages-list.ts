import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
import { AdminApiService } from '../../../../core/services/admin-api';
import { PageDialog } from '../page-dialog/page-dialog';
import type { AdminPage, ExportFormat, PaginatedResponse } from '../../../../core/models/admin';

@Component({
  selector: 'ha-pages-list',
  imports: [
    DatePipe,
    MatButtonModule, MatIconModule, MatDialogModule,
    MatPaginatorModule, MatSnackBarModule, MatTooltipModule, MatMenuModule, MatDividerModule,
  ],
  templateUrl: './pages-list.html',
  styleUrl: './pages-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PagesList implements OnInit {
  private readonly api    = inject(AdminApiService);
  private readonly dialog = inject(MatDialog);
  private readonly snack  = inject(MatSnackBar);
  private readonly router = inject(Router);

  readonly data      = signal<PaginatedResponse<AdminPage> | null>(null);
  readonly loading   = signal(false);
  readonly search    = signal('');
  readonly viewMode  = signal<'grid' | 'list'>('grid');
  readonly selected  = signal<Set<string>>(new Set());
  readonly exporting = signal(false);
  readonly backingUp = signal(false);
  readonly restoring = signal(false);
  readonly categoryFilter = signal<string>(''); // '' = all categories
  readonly categoryNames  = signal<string[]>([]);
  readonly newOnly        = signal(false); // show only recently-added pages

  /** A page counts as "new" for this many days after it is created. */
  static readonly NEW_DAYS = 14;

  /** True when the page was created within the NEW_DAYS window. */
  isNew(page: AdminPage): boolean {
    const created = new Date(page.createdAt).getTime();
    if (Number.isNaN(created)) return false;
    const ageMs = Date.now() - created;
    return ageMs >= 0 && ageMs <= PagesList.NEW_DAYS * 24 * 60 * 60 * 1000;
  }

  readonly filtered = computed(() => {
    const q = this.search().toLowerCase().trim();
    let pages = this.data()?.data ?? [];
    if (q) {
      pages = pages.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.routePath.toLowerCase().includes(q) ||
          (p.category ?? '').toLowerCase().includes(q) ||
          (p.description ?? '').toLowerCase().includes(q),
      );
    }
    if (this.newOnly()) {
      pages = pages.filter((p) => this.isNew(p));
    }
    // Cluster by module category, then title.
    return [...pages].sort(
      (a, b) =>
        (a.categoryOrder ?? 99) - (b.categoryOrder ?? 99) ||
        (a.category ?? '').localeCompare(b.category ?? '') ||
        a.title.localeCompare(b.title),
    );
  });

  /** Visible pages grouped into collapsible category sections (grid view). */
  readonly grouped = computed(() => {
    const map = new Map<string, { name: string; order: number; items: AdminPage[] }>();
    for (const p of this.filtered()) {
      const name = p.category ?? 'Uncategorised';
      const order = p.categoryOrder ?? 99;
      if (!map.has(name)) map.set(name, { name, order, items: [] });
      map.get(name)!.items.push(p);
    }
    return [...map.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  });

  readonly collapsed = signal<Set<string>>(new Set());
  isCollapsed(cat: string): boolean { return this.collapsed().has(cat); }
  toggleCollapse(cat: string): void {
    const s = new Set(this.collapsed());
    if (s.has(cat)) s.delete(cat); else s.add(cat);
    this.collapsed.set(s);
  }

  readonly selectedCount = computed(() => this.selected().size);
  readonly allSelected = computed(() => {
    const f = this.filtered();
    return f.length > 0 && f.every((p) => this.selected().has(p.id));
  });

  private page = 1;
  private limit = 20;

  ngOnInit(): void {
    try {
      const v = localStorage.getItem('ha-pages-view');
      if (v === 'list') this.viewMode.set('list');
    } catch { /* noop */ }
    this.api.listCategories().subscribe({
      next: (r) => this.categoryNames.set(r.data.map((c) => c.name)),
      error: () => { /* filter just won't list names */ },
    });
    this.load();
  }

  setCategory(name: string): void {
    this.categoryFilter.set(name);
    this.page = 1;
    this.load();
  }

  setView(m: 'grid' | 'list'): void {
    this.viewMode.set(m);
    try { localStorage.setItem('ha-pages-view', m); } catch { /* noop */ }
  }

  toggleNewOnly(): void {
    this.newOnly.update((v) => !v);
  }

  /** Open the live, end-user view of this manual in a new tab. */
  viewLive(page: AdminPage): void {
    if (typeof window === 'undefined') return;
    if (!page.isPublished) {
      this.snack.open('This page is Off — turn it On to make the live view visible to users.', 'OK', { duration: 4000 });
    }
    window.open(`/manual/${page.id}`, '_blank', 'noopener');
  }

  /** Flip a page between Live (published) and Off; optimistic with rollback. */
  togglePublished(page: AdminPage): void {
    const next = !page.isPublished;
    this.patchLocalPublished(page.id, next); // optimistic
    this.api.updatePage(page.id, { isPublished: next }).subscribe({
      next: () => {
        this.snack.open(next ? `"${page.title}" is now Live` : `"${page.title}" turned Off`, 'OK', { duration: 3000 });
      },
      error: () => {
        this.patchLocalPublished(page.id, page.isPublished); // rollback
        this.snack.open('Could not change publish state', 'OK', { duration: 3000 });
      },
    });
  }

  private patchLocalPublished(id: string, isPublished: boolean): void {
    const cur = this.data();
    if (!cur) return;
    this.data.set({ ...cur, data: cur.data.map((p) => (p.id === id ? { ...p, isPublished } : p)) });
  }

  load(): void {
    this.loading.set(true);
    this.api.listPages(this.page, this.limit, this.categoryFilter() || undefined).subscribe({
      next: (res) => { this.data.set(res); this.loading.set(false); },
      error: ()   => { this.loading.set(false); },
    });
  }

  onPage(e: PageEvent): void {
    this.limit = e.pageSize; // apply the chosen page size (20 / 50 / 100)
    this.page = e.pageIndex + 1;
    this.load();
  }

  openCreate(): void {
    this.dialog.open(PageDialog, { width: '600px', data: null })
      .afterClosed().subscribe((saved) => { if (saved) this.load(); });
  }

  openEdit(page: AdminPage): void {
    this.dialog.open(PageDialog, { width: '600px', data: page })
      .afterClosed().subscribe((saved) => { if (saved) this.load(); });
  }

  openDetail(page: AdminPage): void {
    void this.router.navigate(['/admin/pages', page.id]);
  }

  // ── Selection ───────────────────────────────────────────────────────────────
  isSelected(id: string): boolean {
    return this.selected().has(id);
  }

  toggleSelect(id: string): void {
    const s = new Set(this.selected());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.selected.set(s);
  }

  toggleAll(): void {
    const f = this.filtered();
    const s = new Set(this.selected());
    if (this.allSelected()) f.forEach((p) => s.delete(p.id));
    else f.forEach((p) => s.add(p.id));
    this.selected.set(s);
  }

  clearSelection(): void {
    this.selected.set(new Set());
  }

  // ── Export ────────────────────────────────────────────────────────────────────
  export(format: ExportFormat): void {
    const ids = [...this.selected()];
    this.exporting.set(true);
    this.api.startExport(format, ids.length ? ids : undefined).subscribe({
      next: () => {
        this.exporting.set(false);
        this.snack
          .open(
            `Export started (${ids.length ? ids.length + ' selected' : 'all user manuals'}) — generating on the server…`,
            'Open Downloads',
            { duration: 6000 },
          )
          .onAction()
          .subscribe(() => void this.router.navigate(['/admin/exports']));
      },
      error: (err) => {
        this.exporting.set(false);
        this.snack.open(err.error?.error?.message ?? 'Export failed to start', 'OK', { duration: 4000 });
      },
    });
  }

  // ── Backup / restore ────────────────────────────────────────────────────────
  backup(): void {
    if (this.backingUp()) return;
    this.backingUp.set(true);
    this.api.downloadBackup().subscribe({
      next: (blob) => {
        this.backingUp.set(false);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'help-assistant-backup.zip';
        a.click();
        URL.revokeObjectURL(url);
        this.snack.open('Backup downloaded (.zip) — content + images', 'OK', { duration: 4000 });
      },
      error: () => {
        this.backingUp.set(false);
        this.snack.open('Backup failed', 'OK', { duration: 4000 });
      },
    });
  }

  onRestoreFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file later
    if (!file) return;
    if (
      !confirm(
        `Restore from "${file.name}"?\n\nThis imports pages, steps, API endpoints, images and widget settings, overwriting any that share the same route or name. Continue?`,
      )
    ) {
      return;
    }
    this.restoring.set(true);
    this.api.importBackup(file).subscribe({
      next: ({ summary: s }) => {
        this.restoring.set(false);
        this.snack.open(
          `Restored ${s.pages} pages, ${s.steps} steps, ${s.media} images, ${s.categories} categories`,
          'OK',
          { duration: 7000 },
        );
        this.clearSelection();
        this.load();
      },
      error: (err) => {
        this.restoring.set(false);
        this.snack.open(err.error?.error?.message ?? 'Restore failed', 'OK', { duration: 5000 });
      },
    });
  }

  deletePage(page: AdminPage): void {
    if (!confirm(`Delete "${page.title}"? All steps will also be removed.`)) return;
    this.api.deletePage(page.id).subscribe({
      next: () => { this.snack.open('Page deleted', 'OK', { duration: 3000 }); this.load(); },
      error: () => { this.snack.open('Delete failed', 'OK', { duration: 3000 }); },
    });
  }
}
