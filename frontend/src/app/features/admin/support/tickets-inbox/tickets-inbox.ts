import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, type PageEvent } from '@angular/material/paginator';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import { AuthStore } from '../../../../core/services/auth-store';
import type {
  TicketDetail,
  TicketStatus,
  TicketSummary,
} from '../../../../core/models/support';

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

/** Support inbox — filterable ticket list with a conversation/reply pane. */
@Component({
  selector: 'ha-tickets-inbox',
  imports: [
    DatePipe,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatPaginatorModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
  ],
  templateUrl: './tickets-inbox.html',
  styleUrls: ['../admin-form.scss', './tickets-inbox.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TicketsInbox implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);
  private readonly auth = inject(AuthStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly canManage = computed(() => this.auth.can('support.manage'));
  readonly statuses: TicketStatus[] = ['open', 'in_progress', 'resolved', 'closed'];
  readonly statusLabel = STATUS_LABEL;

  // ── List ──────────────────────────────────────────────────────────────────
  readonly status = signal<TicketStatus | ''>('');
  readonly q = signal('');
  readonly page = signal(1);
  readonly pageSize = signal(20);
  readonly tickets = signal<TicketSummary[]>([]);
  readonly total = signal(0);
  readonly counts = signal<Record<TicketStatus, number>>({ open: 0, in_progress: 0, resolved: 0, closed: 0 });
  readonly allCount = computed(() => Object.values(this.counts()).reduce((a, b) => a + b, 0));
  readonly listLoading = signal(true);
  readonly listError = signal<string | null>(null);
  private readonly search$ = new Subject<string>();

  // ── Detail ────────────────────────────────────────────────────────────────
  readonly selectedId = signal<string | null>(null);
  readonly ticket = signal<TicketDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly reply = signal('');
  readonly replyStatus = signal<TicketStatus | ''>('');
  readonly sending = signal(false);
  readonly statusSaving = signal(false);
  readonly lastEmailed = signal<boolean | null>(null);

  ngOnInit(): void {
    this.search$
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
      .subscribe((v) => {
        this.q.set(v);
        this.page.set(1);
        this.load();
      });
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((pm) => {
      const id = pm.get('id');
      if (id !== this.selectedId()) {
        this.selectedId.set(id);
        if (id) this.loadTicket(id);
        else this.ticket.set(null);
      }
    });
    this.load();
  }

  load(): void {
    this.listLoading.set(true);
    this.listError.set(null);
    this.api
      .listTickets({ status: this.status(), q: this.q(), page: this.page(), pageSize: this.pageSize() })
      .subscribe({
        next: (r) => {
          this.tickets.set(r.tickets);
          this.total.set(r.total);
          this.counts.set(r.counts);
          this.listLoading.set(false);
        },
        error: () => {
          this.listError.set('Could not load tickets.');
          this.listLoading.set(false);
        },
      });
  }

  setStatusFilter(s: TicketStatus | ''): void {
    this.status.set(s);
    this.page.set(1);
    this.load();
  }

  onSearch(v: string): void {
    this.search$.next(v.trim());
  }

  onPage(e: PageEvent): void {
    this.page.set(e.pageIndex + 1);
    this.pageSize.set(e.pageSize);
    this.load();
  }

  select(t: TicketSummary): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { id: t.id }, queryParamsHandling: 'merge' });
  }

  closeDetail(): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { id: null }, queryParamsHandling: 'merge' });
  }

  private loadTicket(id: string): void {
    this.detailLoading.set(true);
    this.ticket.set(null);
    this.reply.set('');
    this.replyStatus.set('');
    this.lastEmailed.set(null);
    this.api.getTicket(id).subscribe({
      next: ({ ticket }) => {
        this.ticket.set(ticket);
        this.detailLoading.set(false);
      },
      error: () => {
        this.detailLoading.set(false);
        this.snack.open('Could not load ticket.', undefined, { duration: 3000 });
      },
    });
  }

  sendReply(): void {
    const t = this.ticket();
    const msg = this.reply().trim();
    if (!t || !msg || this.sending()) return;
    this.sending.set(true);
    this.api.replyTicket(t.id, msg, this.replyStatus() || undefined).subscribe({
      next: ({ reply, ticket, emailed }) => {
        this.sending.set(false);
        const replies = ticket.replies?.length ? ticket.replies : [...t.replies, reply];
        this.ticket.set({ ...t, ...ticket, replies });
        this.reply.set('');
        this.replyStatus.set('');
        this.lastEmailed.set(emailed);
        this.snack.open(
          emailed ? 'Reply sent and emailed to the customer' : 'Reply saved — email could not be sent',
          undefined,
          { duration: 3000 },
        );
        this.load();
      },
      error: (e) => {
        this.sending.set(false);
        this.snack.open(e?.error?.error?.message ?? 'Could not send reply.', undefined, { duration: 3500 });
      },
    });
  }

  changeStatus(s: TicketStatus): void {
    const t = this.ticket();
    if (!t || t.status === s || this.statusSaving()) return;
    this.statusSaving.set(true);
    this.api.updateTicketStatus(t.id, s).subscribe({
      next: ({ ticket }) => {
        this.statusSaving.set(false);
        this.ticket.set({ ...t, ...ticket, replies: ticket?.replies ?? t.replies, status: ticket?.status ?? s });
        this.snack.open(`Marked ${STATUS_LABEL[s].toLowerCase()}`, undefined, { duration: 2000 });
        this.load();
      },
      error: () => {
        this.statusSaving.set(false);
        this.snack.open('Could not update status.', undefined, { duration: 3000 });
      },
    });
  }
}
