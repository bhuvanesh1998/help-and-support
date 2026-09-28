import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { SiteSettingsService } from '../../../core/services/site-settings.service';
import type { TicketCreated } from '../../../core/models/support';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+()\-.\s0-9]{6,20}$/;

type Field = 'name' | 'email' | 'phone' | 'categoryId' | 'subject' | 'message';

/**
 * Support ticket form, shared by the landing page and the embeddable widgets.
 * Styling reads `--ha-accent` when present (widget) and the Material primary
 * otherwise (landing), so it blends into either host.
 */
@Component({
  selector: 'ha-support-form',
  templateUrl: './support-form.html',
  styleUrl: './support-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.compact]': 'compact()' },
})
export class SupportForm implements OnInit {
  private readonly site = inject(SiteSettingsService);

  readonly source = input<'site' | 'widget'>('site');
  readonly sourceUrl = input<string | null>(null);
  readonly compact = input(false);
  /** Fired when the user wants to follow the ticket they just raised. */
  readonly track = output<{ number: string; email: string }>();

  readonly config = this.site.support;
  readonly categories = computed(() => this.config()?.categories ?? []);
  readonly priorities = computed(() => this.config()?.priorities ?? []);
  readonly slaText = computed(
    () => this.config()?.slaText?.trim() || '24x7 support · resolved within 24 hours max',
  );

  readonly name = signal('');
  readonly email = signal('');
  readonly phone = signal('');
  readonly categoryId = signal('');
  readonly priority = signal('');
  readonly subject = signal('');
  readonly message = signal('');
  readonly website = signal('');

  readonly submitted = signal(false);
  readonly sending = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<TicketCreated | null>(null);

  readonly categoryHint = computed(
    () => this.categories().find((c) => c.id === this.categoryId())?.description ?? '',
  );

  readonly errors = computed<Partial<Record<Field, string>>>(() => {
    const e: Partial<Record<Field, string>> = {};
    if (this.name().trim().length < 2) e.name = 'Please enter your name.';
    if (!EMAIL_RE.test(this.email().trim())) e.email = 'Enter a valid email address.';
    if (this.phone().trim() && !PHONE_RE.test(this.phone().trim())) e.phone = 'Enter a valid phone number.';
    if (!this.categoryId()) e.categoryId = 'Choose a category.';
    if (this.subject().trim().length < 3) e.subject = 'Add a short subject.';
    if (this.message().trim().length < 10) e.message = 'Describe the issue (at least 10 characters).';
    return e;
  });
  readonly valid = computed(() => Object.keys(this.errors()).length === 0);

  ngOnInit(): void {
    this.site.loadSupport();
  }

  err(f: Field): string | undefined {
    return this.submitted() ? this.errors()[f] : undefined;
  }

  val(e: Event): string {
    return (e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }

  submit(ev: Event): void {
    ev.preventDefault();
    this.submitted.set(true);
    this.error.set(null);
    if (!this.valid() || this.sending()) return;
    this.sending.set(true);
    const phone = this.phone().trim();
    const sourceUrl =
      this.sourceUrl() ?? (typeof window !== 'undefined' ? window.location.href : undefined);
    this.site
      .submitTicket({
        name: this.name().trim(),
        email: this.email().trim(),
        ...(phone ? { phone } : {}),
        categoryId: this.categoryId(),
        ...(this.priority() ? { priority: this.priority() } : {}),
        subject: this.subject().trim(),
        message: this.message().trim(),
        ...(sourceUrl ? { sourceUrl } : {}),
        source: this.source(),
        website: this.website(),
      })
      .subscribe({
        next: (t) => {
          this.sending.set(false);
          this.result.set(t);
          this.site.rememberTicket({
            number: String(t.number),
            email: this.email().trim().toLowerCase(),
            subject: this.subject().trim(),
            createdAt: new Date().toISOString(),
          });
        },
        error: (e: HttpErrorResponse) => {
          this.sending.set(false);
          const msg = (e.error as { error?: { message?: string } } | null)?.error?.message;
          this.error.set(
            msg ||
              (e.status === 429
                ? 'Too many requests. Please wait a moment and try again.'
                : 'We could not submit your ticket. Please try again.'),
          );
        },
      });
  }

  trackIt(): void {
    const r = this.result();
    if (r) this.track.emit({ number: String(r.number), email: this.email().trim().toLowerCase() });
  }

  reset(): void {
    this.subject.set('');
    this.message.set('');
    this.priority.set('');
    this.submitted.set(false);
    this.result.set(null);
    this.error.set(null);
  }
}
