import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AdminApiService } from '../../../../core/services/admin-api';
import type { AdminCategory } from '../../../../core/models/admin';

@Component({
  selector: 'ha-categories-list',
  imports: [
    FormsModule, MatButtonModule, MatIconModule, MatSnackBarModule,
    MatTooltipModule, MatProgressSpinnerModule,
  ],
  templateUrl: './categories-list.html',
  styleUrl: './categories-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoriesList implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);

  readonly loading = signal(true);
  readonly cats = signal<AdminCategory[]>([]);
  readonly editingId = signal<string | null>(null);

  // New-category form
  newName = '';
  newIcon = '';
  newDesc = '';

  // Edit buffer
  editName = '';
  editIcon = '';
  editDesc = '';

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.api.listCategories().subscribe({
      next: (r) => { this.cats.set(r.data); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  add(): void {
    const name = this.newName.trim();
    if (!name) return;
    const order = this.cats().reduce((m, c) => Math.max(m, c.order), 0) + 1;
    this.api.createCategory({ name, icon: this.newIcon.trim() || undefined, description: this.newDesc.trim() || undefined, order }).subscribe({
      next: () => { this.newName = ''; this.newIcon = ''; this.newDesc = ''; this.snack.open('Category added', undefined, { duration: 2000 }); this.load(); },
      error: (e) => this.snack.open(e.error?.error?.message ?? 'Add failed', 'OK', { duration: 3000 }),
    });
  }

  startEdit(c: AdminCategory): void {
    this.editingId.set(c.id);
    this.editName = c.name;
    this.editIcon = c.icon ?? '';
    this.editDesc = c.description ?? '';
  }

  cancelEdit(): void { this.editingId.set(null); }

  saveEdit(c: AdminCategory): void {
    if (!this.editName.trim()) return;
    this.api.updateCategory(c.id, { name: this.editName.trim(), icon: this.editIcon.trim() || undefined, description: this.editDesc.trim() || undefined }).subscribe({
      next: () => { this.editingId.set(null); this.snack.open('Category updated', undefined, { duration: 2000 }); this.load(); },
      error: (e) => this.snack.open(e.error?.error?.message ?? 'Update failed', 'OK', { duration: 3000 }),
    });
  }

  remove(c: AdminCategory): void {
    if (!confirm(`Delete category "${c.name}"? Its ${c.pageCount ?? 0} manual(s) will become uncategorised (not deleted).`)) return;
    this.api.deleteCategory(c.id).subscribe({
      next: () => { this.snack.open('Category deleted', undefined, { duration: 2000 }); this.load(); },
      error: () => this.snack.open('Delete failed', 'OK', { duration: 3000 }),
    });
  }

  move(c: AdminCategory, dir: 'up' | 'down'): void {
    const list = [...this.cats()].sort((a, b) => a.order - b.order);
    const i = list.findIndex((x) => x.id === c.id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    const payload = list.map((x, idx) => ({ id: x.id, order: idx + 1 }));
    this.api.reorderCategories(payload).subscribe({
      next: () => this.load(),
      error: () => this.snack.open('Reorder failed', 'OK', { duration: 3000 }),
    });
  }
}
