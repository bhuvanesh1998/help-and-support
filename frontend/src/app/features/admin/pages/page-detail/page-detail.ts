import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  ViewChild,
  inject,
  signal,
  computed,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { renderStepMarkdown } from '../../../../core/utils/step-markdown';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import type { AdminApiEndpoint, AdminPage, AdminStep } from '../../../../core/models/admin';

@Component({
  selector: 'ha-page-detail',
  imports: [
    FormsModule,
    MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule,
    MatCardModule, MatProgressSpinnerModule, MatSnackBarModule, MatChipsModule, MatTooltipModule,
  ],
  templateUrl: './page-detail.html',
  styleUrl: './page-detail.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageDetail implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly uploadingImage = signal(false);
  readonly page = signal<(AdminPage & { steps: AdminStep[] }) | null>(null);
  readonly editingStep = signal<AdminStep | null>(null);
  readonly showStepForm = signal(false);

  stepTitle = '';
  stepInstructions = '';
  stepImageUrl = '';

  @ViewChild('mdArea') private mdArea?: ElementRef<HTMLTextAreaElement>;

  readonly pageId = computed(() => this.route.snapshot.paramMap.get('id') ?? '');

  // Render each step's Markdown to HTML. Bound via [innerHTML], so Angular's
  // sanitizer strips any unsafe content (no bypassSecurityTrustHtml).
  readonly stepHtmls = computed(() => {
    const steps = this.page()?.steps ?? [];
    const map = new Map<string, string>();
    for (const s of steps) {
      map.set(s.id, renderStepMarkdown(s.instructionsMd ?? '', s.title));
    }
    return map;
  });

  htmlFor(stepId: string): string {
    return this.stepHtmls().get(stepId) ?? '';
  }

  // ── Auto-captured API reference ─────────────────────────────────────────────
  readonly apiEndpoints = computed<AdminApiEndpoint[]>(() => this.page()?.apiEndpoints ?? []);

  methodClass(method: string): string {
    return 'api-method api-method--' + (method || 'get').toLowerCase().replace(/[^a-z]/g, '');
  }

  deleteApiEndpoint(e: AdminApiEndpoint): void {
    if (!confirm(`Remove ${e.method} ${e.path} from the API tab?`)) return;
    this.api.deleteApiEndpoint(this.pageId(), e.id).subscribe({
      next: () => { this.snack.open('Endpoint removed', 'OK', { duration: 2000 }); this.load(); },
      error: () => this.snack.open('Delete failed', 'OK', { duration: 3000 }),
    });
  }

  // ── Markdown editor toolbar + shortcuts ─────────────────────────────────────
  /** Write a new value through the real input path so ngModel + selection stay in sync. */
  private setValue(next: string, selStart: number, selEnd: number): void {
    const ta = this.mdArea?.nativeElement;
    if (!ta) return;
    ta.value = next;
    ta.dispatchEvent(new Event('input', { bubbles: true })); // drives [(ngModel)]
    ta.focus();
    ta.setSelectionRange(selStart, selEnd);
  }

  /** Wrap the current selection (e.g. **bold**). */
  private surround(before: string, after: string): void {
    const ta = this.mdArea?.nativeElement;
    if (!ta) return;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const v = ta.value;
    const sel = v.slice(s, e);
    const next = v.slice(0, s) + before + sel + after + v.slice(e);
    this.setValue(next, s + before.length, s + before.length + sel.length);
  }

  /** Prefix the current line (e.g. "## ", "- "). */
  private linePrefix(prefix: string): void {
    const ta = this.mdArea?.nativeElement;
    if (!ta) return;
    const s = ta.selectionStart;
    const v = ta.value;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const next = v.slice(0, lineStart) + prefix + v.slice(lineStart);
    this.setValue(next, s + prefix.length, s + prefix.length);
  }

  fmtBold():    void { this.surround('**', '**'); }
  fmtItalic():  void { this.surround('*', '*'); }
  fmtCode():    void { this.surround('`', '`'); }
  fmtLink():    void { this.surround('[', '](https://)'); }
  fmtHeading(): void { this.linePrefix('## '); }
  fmtBullet():  void { this.linePrefix('- '); }
  fmtNumber():  void { this.linePrefix('1. '); }

  onMdKeydown(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey)) return;
    switch (e.key.toLowerCase()) {
      case 'b': e.preventDefault(); this.fmtBold(); break;
      case 'i': e.preventDefault(); this.fmtItalic(); break;
      case 'k': e.preventDefault(); this.fmtLink(); break;
    }
  }

  // ── Step image upload ───────────────────────────────────────────────────────
  onImageFile(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.snack.open('Please choose an image file', 'OK', { duration: 3000 });
      return;
    }
    this.uploadingImage.set(true);
    this.api.uploadMedia(file).subscribe({
      next: (res) => {
        this.uploadingImage.set(false);
        this.stepImageUrl = res.asset.publicUrl;
        this.snack.open('Image uploaded', undefined, { duration: 2000 });
      },
      error: (err) => {
        this.uploadingImage.set(false);
        this.snack.open(err.error?.error?.message ?? 'Upload failed', 'OK', { duration: 4000 });
      },
    });
  }

  clearImage(): void {
    this.stepImageUrl = '';
  }

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.getPage(this.pageId()).subscribe({
      next: (res) => { this.page.set(res.page); this.loading.set(false); },
      error: () => { this.loading.set(false); },
    });
  }

  openNewStep(): void {
    this.editingStep.set(null);
    this.stepTitle = '';
    this.stepInstructions = '';
    this.stepImageUrl = '';
    this.showStepForm.set(true);
  }

  openEditStep(step: AdminStep): void {
    this.editingStep.set(step);
    this.stepTitle = step.title;
    this.stepInstructions = step.instructionsMd;
    this.stepImageUrl = step.imageUrl ?? '';
    this.showStepForm.set(true);
  }

  cancelForm(): void {
    this.showStepForm.set(false);
    this.editingStep.set(null);
  }

  saveStep(): void {
    this.saving.set(true);
    const data: Partial<AdminStep> = {
      title: this.stepTitle.trim(),
      instructionsMd: this.stepInstructions.trim(),
      imageUrl: this.stepImageUrl || undefined,
    };

    const existing = this.editingStep();
    const req = existing
      ? this.api.updateStep(this.pageId(), existing.id, data)
      : this.api.createStep(this.pageId(), data);

    req.subscribe({
      next: () => {
        this.saving.set(false);
        this.showStepForm.set(false);
        this.editingStep.set(null);
        this.load();
      },
      error: (err) => {
        this.saving.set(false);
        this.snack.open(err.error?.error?.message ?? 'Save failed', 'OK', { duration: 4000 });
      },
    });
  }

  deleteStep(step: AdminStep): void {
    if (!confirm(`Delete step "${step.title}"?`)) return;
    this.api.deleteStep(this.pageId(), step.id).subscribe({
      next: () => { this.snack.open('Step deleted', 'OK', { duration: 2500 }); this.load(); },
      error: () => { this.snack.open('Delete failed', 'OK', { duration: 3000 }); },
    });
  }

  moveUp(step: AdminStep): void {
    const steps = this.page()?.steps ?? [];
    const idx = steps.findIndex((s) => s.id === step.id);
    if (idx <= 0) return;
    this.reorder(steps, idx, idx - 1);
  }

  moveDown(step: AdminStep): void {
    const steps = this.page()?.steps ?? [];
    const idx = steps.findIndex((s) => s.id === step.id);
    if (idx < 0 || idx >= steps.length - 1) return;
    this.reorder(steps, idx, idx + 1);
  }

  private reorder(steps: AdminStep[], from: number, to: number): void {
    const reordered = [...steps];
    const [moved] = reordered.splice(from, 1);
    if (!moved) return;
    reordered.splice(to, 0, moved);
    const order = reordered.map((s, i) => ({ id: s.id, stepNumber: i + 1 }));
    this.api.reorderSteps(this.pageId(), order).subscribe({
      next: () => this.load(),
      error: () => this.snack.open('Reorder failed', 'OK', { duration: 3000 }),
    });
  }

  goBack(): void {
    void this.router.navigate(['/admin/pages']);
  }
}
