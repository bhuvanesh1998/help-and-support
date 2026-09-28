import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AdminApiService } from '../../../../core/services/admin-api';
import type { SmtpConfig, SmtpConfigInput } from '../../../../core/models/support';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const EMPTY: SmtpConfig = {
  host: '',
  port: 587,
  secure: false,
  username: '',
  fromName: '',
  fromEmail: '',
  hasPassword: false,
};

/** Outgoing mail (SMTP) used for ticket acknowledgements and replies. */
@Component({
  selector: 'ha-smtp-settings',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSlideToggleModule,
    MatSnackBarModule,
  ],
  templateUrl: './smtp-settings.html',
  styleUrl: '../admin-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SmtpSettings implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);

  readonly model = signal<SmtpConfig>({ ...EMPTY });
  /** Write-only: empty means "keep the stored password". */
  readonly password = signal('');
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly testTo = signal('');
  readonly testing = signal(false);
  readonly testResult = signal<{ ok: boolean; message: string } | null>(null);

  private readonly savedJson = signal('');
  readonly dirty = computed(
    () => JSON.stringify(this.model()) !== this.savedJson() || this.password().length > 0,
  );

  ngOnInit(): void {
    this.api.getSmtpConfig().subscribe({
      next: ({ config }) => this.accept(config),
      error: () => {
        this.error.set('Could not load SMTP settings.');
        this.savedJson.set(JSON.stringify(this.model()));
        this.loading.set(false);
      },
    });
  }

  private accept(c: SmtpConfig): void {
    this.model.set({ ...EMPTY, ...c });
    this.savedJson.set(JSON.stringify(this.model()));
    this.password.set('');
    this.loading.set(false);
  }

  set<K extends keyof SmtpConfig>(key: K, value: SmtpConfig[K]): void {
    this.model.update((m) => ({ ...m, [key]: value }));
  }

  setSecure(on: boolean): void {
    this.model.update((m) => ({
      ...m,
      secure: on,
      // Nudge the conventional port when it is still on the other default.
      port: on && m.port === 587 ? 465 : !on && m.port === 465 ? 587 : m.port,
    }));
  }

  save(): void {
    if (this.saving()) return;
    const m = this.model();
    if (!m.host.trim()) return this.error.set('SMTP host is required.');
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return this.error.set('Port must be 1–65535.');
    if (!EMAIL_RE.test(m.fromEmail.trim())) return this.error.set('From email must be a valid address.');
    this.error.set(null);
    this.saving.set(true);
    const { hasPassword: _ignored, ...rest } = m;
    const payload: SmtpConfigInput = {
      ...rest,
      host: rest.host.trim(),
      username: rest.username.trim(),
      fromName: rest.fromName.trim(),
      fromEmail: rest.fromEmail.trim(),
      ...(this.password() ? { password: this.password() } : {}),
    };
    this.api.saveSmtpConfig(payload).subscribe({
      next: ({ config }) => {
        this.accept(config);
        this.saving.set(false);
        this.snack.open('SMTP settings saved', undefined, { duration: 2000 });
      },
      error: (e) => {
        this.saving.set(false);
        this.error.set(e?.error?.error?.message ?? 'Could not save SMTP settings.');
      },
    });
  }

  sendTest(): void {
    const to = this.testTo().trim();
    if (!EMAIL_RE.test(to)) {
      this.testResult.set({ ok: false, message: 'Enter a valid recipient address.' });
      return;
    }
    this.testing.set(true);
    this.testResult.set(null);
    this.api.testSmtp(to).subscribe({
      next: () => {
        this.testing.set(false);
        this.testResult.set({ ok: true, message: `Test email sent to ${to}.` });
      },
      error: (e) => {
        this.testing.set(false);
        this.testResult.set({ ok: false, message: e?.error?.error?.message ?? 'Test email failed.' });
      },
    });
  }
}
