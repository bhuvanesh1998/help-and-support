import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import type { AdminSupportConfig, SupportCategory } from '../../../../core/models/support';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

const EMPTY: AdminSupportConfig = {
  enabled: false,
  slaText: '24x7 support · resolved within 24 hours max',
  intro: '',
  categories: [],
  priorities: ['low', 'normal', 'high', 'urgent'],
  notifyEmail: '',
};

/** Support settings — ticket form toggle, SLA copy, categories and priorities. */
@Component({
  selector: 'ha-support-settings',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSlideToggleModule,
    MatSnackBarModule,
    MatTooltipModule,
  ],
  templateUrl: './support-settings.html',
  styleUrls: ['../admin-form.scss', './support-settings.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SupportSettings implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);

  readonly model = signal<AdminSupportConfig>({ ...EMPTY });
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly newPriority = signal('');
  private readonly savedJson = signal('');
  /** IDs already stored server-side — kept stable so existing tickets stay linked. */
  readonly persistedIds = signal<ReadonlySet<string>>(new Set());
  readonly dirty = computed(() => JSON.stringify(this.model()) !== this.savedJson());

  ngOnInit(): void {
    this.api.getSupportConfig().subscribe({
      next: ({ config }) => this.accept(config),
      error: () => {
        this.error.set('Could not load support settings.');
        this.savedJson.set(JSON.stringify(this.model()));
        this.loading.set(false);
      },
    });
  }

  private accept(c: AdminSupportConfig): void {
    this.model.set({
      ...EMPTY,
      ...c,
      categories: (c.categories ?? []).map((x) => ({ ...x })),
      priorities: [...(c.priorities ?? [])],
    });
    this.savedJson.set(JSON.stringify(this.model()));
    this.persistedIds.set(new Set(this.model().categories.map((x) => x.id)));
    this.loading.set(false);
  }

  set<K extends keyof AdminSupportConfig>(key: K, value: AdminSupportConfig[K]): void {
    this.model.update((m) => ({ ...m, [key]: value }));
  }

  // ── Categories ────────────────────────────────────────────────────────────
  private uniqueId(base: string, skip: number): string {
    const root = base || 'category';
    const taken = new Set(this.model().categories.filter((_, i) => i !== skip).map((c) => c.id));
    let id = root;
    let n = 2;
    while (taken.has(id)) id = `${root}-${n++}`;
    return id;
  }

  addCategory(): void {
    this.model.update((m) => ({
      ...m,
      categories: [...m.categories, { id: this.uniqueId('category', -1), label: '', description: '' }],
    }));
  }

  updateCategory(i: number, patch: Partial<SupportCategory>): void {
    this.model.update((m) => {
      const cats = m.categories.map((c, j) => {
        if (j !== i) return c;
        const next = { ...c, ...patch };
        if (patch.label !== undefined && !this.persistedIds().has(c.id)) next.id = this.uniqueId(slugify(patch.label), i);
        return next;
      });
      return { ...m, categories: cats };
    });
  }

  removeCategory(i: number): void {
    this.model.update((m) => ({ ...m, categories: m.categories.filter((_, j) => j !== i) }));
  }

  moveCategory(i: number, delta: -1 | 1): void {
    this.model.update((m) => {
      const cats = [...m.categories];
      const j = i + delta;
      if (j < 0 || j >= cats.length) return m;
      [cats[i], cats[j]] = [cats[j], cats[i]];
      return { ...m, categories: cats };
    });
  }

  // ── Priorities ────────────────────────────────────────────────────────────
  addPriority(): void {
    const v = this.newPriority().trim().toLowerCase();
    if (!v) return;
    if (!this.model().priorities.includes(v)) {
      this.model.update((m) => ({ ...m, priorities: [...m.priorities, v] }));
    }
    this.newPriority.set('');
  }

  onPriorityKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      this.addPriority();
    }
  }

  removePriority(p: string): void {
    this.model.update((m) => ({ ...m, priorities: m.priorities.filter((x) => x !== p) }));
  }

  save(): void {
    if (this.saving()) return;
    const m = this.model();
    if (m.notifyEmail.trim() && !EMAIL_RE.test(m.notifyEmail.trim())) {
      this.error.set('Notification email is not a valid address.');
      return;
    }
    if (m.categories.some((c) => !c.label.trim())) {
      this.error.set('Every category needs a label.');
      return;
    }
    if (m.enabled && !m.categories.length) {
      this.error.set('Add at least one category before enabling support.');
      return;
    }
    this.error.set(null);
    this.saving.set(true);
    const payload: AdminSupportConfig = {
      ...m,
      notifyEmail: m.notifyEmail.trim(),
      categories: m.categories.map((c) => ({
        id: c.id,
        label: c.label.trim(),
        ...(c.description?.trim() ? { description: c.description.trim() } : {}),
      })),
    };
    this.api.saveSupportConfig(payload).subscribe({
      next: ({ config }) => {
        this.accept(config);
        this.saving.set(false);
        this.snack.open('Support settings saved', undefined, { duration: 2000 });
      },
      error: (e) => {
        this.saving.set(false);
        this.error.set(e?.error?.error?.message ?? 'Could not save support settings.');
      },
    });
  }
}
