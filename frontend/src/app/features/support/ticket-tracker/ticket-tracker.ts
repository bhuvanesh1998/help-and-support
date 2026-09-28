import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { SiteSettingsService } from '../../../core/services/site-settings.service';
import type { TrackedTicket } from '../../../core/models/support';

const STATUS_LABEL: Record<TrackedTicket['status'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};
const STAGES: TrackedTicket['status'][] = ['open', 'in_progress', 'resolved'];

/**
 * Lets a requester look up a ticket by number + email, follow its status and
 * conversation, and post follow-ups. Tickets raised from this browser are
 * listed for one-click tracking. Uses the same accent tokens as the form.
 */
@Component({
  selector: 'ha-ticket-tracker',
  imports: [DatePipe],
  templateUrl: './ticket-tracker.html',
  styleUrl: './ticket-tracker.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.compact]': 'compact()' },
})
export class TicketTracker implements OnInit {
  private readonly site = inject(SiteSettingsService);

  readonly compact = input(false);
  /** Open straight into this ticket (e.g. right after raising it). */
  readonly initial = input<{ number: string; email: string } | null>(null);

  readonly myTickets = this.site.myTickets;
  readonly number = signal('');
  readonly email = signal('');
  readonly ticket = signal<TrackedTicket | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly followUp = signal('');
  readonly sending = signal(false);
  readonly sendError = signal<string | null>(null);

  readonly statusLabel = computed(() => {
    const t = this.ticket();
    return t ? (STATUS_LABEL[t.status] ?? t.status) : '';
  });
  /** Position on the Open → In progress → Resolved track (closed counts as the end). */
  readonly stage = computed(() => {
    const s = this.ticket()?.status ?? 'open';
    return s === 'closed' ? STAGES.length - 1 : Math.max(0, STAGES.indexOf(s));
  });
  readonly stages = STAGES.map((s) => STATUS_LABEL[s]);
  readonly canFollowUp = computed(() => this.ticket()?.status !== 'closed');

  ngOnInit(): void {
    const init = this.initial();
    if (init) this.open(init.number, init.email);
  }

  val(e: Event): string {
    return (e.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  lookup(ev: Event): void {
    ev.preventDefault();
    const number = this.number().trim();
    const email = this.email().trim().toLowerCase();
    if (!number || !email) {
      this.error.set('Enter your ticket number and the email you used.');
      return;
    }
    this.open(number, email);
  }

  open(number: string, email: string): void {
    this.number.set(number);
    this.email.set(email);
    this.loading.set(true);
    this.error.set(null);
    this.site.trackTicket(number, email).subscribe({
      next: (t) => {
        this.loading.set(false);
        this.ticket.set(t);
      },
      error: (e: HttpErrorResponse) => {
        this.loading.set(false);
        this.ticket.set(null);
        this.error.set(this.message(e, 'We could not find that ticket.'));
      },
    });
  }

  refresh(): void {
    const t = this.ticket();
    if (t) this.open(t.number, this.email());
  }

  back(): void {
    this.ticket.set(null);
    this.followUp.set('');
    this.sendError.set(null);
  }

  forget(number: string, ev: Event): void {
    ev.stopPropagation();
    this.site.forgetTicket(number);
  }

  send(ev: Event): void {
    ev.preventDefault();
    const t = this.ticket();
    const text = this.followUp().trim();
    if (!t || text.length < 2 || this.sending()) return;
    this.sending.set(true);
    this.sendError.set(null);
    this.site.followUpTicket(t.number, this.email(), text).subscribe({
      next: (fresh) => {
        this.sending.set(false);
        this.followUp.set('');
        this.ticket.set(fresh);
      },
      error: (e: HttpErrorResponse) => {
        this.sending.set(false);
        this.sendError.set(this.message(e, 'Your message could not be sent. Please try again.'));
      },
    });
  }

  private message(e: HttpErrorResponse, fallback: string): string {
    if (e.status === 429) return 'Too many requests. Please wait a moment and try again.';
    return (e.error as { error?: { message?: string } } | null)?.error?.message || fallback;
  }
}
