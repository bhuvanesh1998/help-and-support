import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AdminApiService } from '../../../../core/services/admin-api';
import type { AdminPage } from '../../../../core/models/admin';

@Component({
  selector: 'ha-page-dialog',
  imports: [
    FormsModule, MatDialogModule,
    MatButtonModule, MatIconModule, MatSnackBarModule,
  ],
  templateUrl: './page-dialog.html',
  styleUrl: './page-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageDialog implements OnInit {
  private readonly api   = inject(AdminApiService);
  private readonly ref   = inject(MatDialogRef<PageDialog>);
  private readonly snack = inject(MatSnackBar);
  readonly existing      = inject<AdminPage | null>(MAT_DIALOG_DATA);

  routePath       = '';
  title           = '';
  description     = '';
  category        = '';
  slug            = '';
  metaTitle       = '';

  /** Managed module categories, loaded from the Categories admin. */
  readonly categoryOptions = signal<string[]>([]);
  metaDescription = '';
  keywords        = '';
  noIndex         = false;

  readonly saving = signal(false);
  readonly isEdit = !!this.existing;

  ngOnInit(): void {
    this.api.listCategories().subscribe({
      next: (r) => this.categoryOptions.set(r.data.map((c) => c.name)),
      error: () => { /* leave empty — free text still works */ },
    });
    if (this.existing) {
      this.routePath       = this.existing.routePath;
      this.title           = this.existing.title;
      this.description     = this.existing.description ?? '';
      this.category        = this.existing.category ?? '';
      this.slug            = this.existing.slug ?? '';
      this.metaTitle       = this.existing.metaTitle ?? '';
      this.metaDescription = this.existing.metaDescription ?? '';
      this.keywords        = this.existing.keywords.join(', ');
      this.noIndex         = this.existing.noIndex;
    }
  }

  save(): void {
    this.saving.set(true);
    const data: Partial<AdminPage> = {
      routePath:       this.routePath.trim(),
      title:           this.title.trim(),
      description:     this.description || undefined,
      category:        this.category.trim() || undefined,
      slug:            this.slug || undefined,
      metaTitle:       this.metaTitle || undefined,
      metaDescription: this.metaDescription || undefined,
      keywords:        this.keywords ? this.keywords.split(',').map(k => k.trim()) : [],
      noIndex:         this.noIndex,
    };

    const req = this.isEdit
      ? this.api.updatePage(this.existing!.id, data)
      : this.api.createPage(data);

    req.subscribe({
      next:  () => this.ref.close(true),
      error: err => {
        this.saving.set(false);
        this.snack.open(err.error?.error?.message ?? 'Save failed', 'OK', { duration: 4000 });
      },
    });
  }
}
