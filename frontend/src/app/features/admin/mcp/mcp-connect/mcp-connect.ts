import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { AdminApiService } from '../../../../core/services/admin-api';
import type { McpStatus } from '../../../../core/models/admin';

type ClientTab = 'code' | 'desktop' | 'web';

@Component({
  selector: 'ha-mcp-connect',
  imports: [
    DatePipe,
    MatButtonModule, MatIconModule, MatSnackBarModule, MatTooltipModule, MatSlideToggleModule,
  ],
  templateUrl: './mcp-connect.html',
  styleUrl: './mcp-connect.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class McpConnect implements OnInit {
  private readonly api   = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);

  readonly loading  = signal(true);
  readonly status   = signal<McpStatus | null>(null);
  readonly token    = signal<string | null>(null);   // revealed plaintext (held in memory only)
  readonly showToken = signal(false);
  readonly busy     = signal(false);
  readonly clientTab = signal<ClientTab>('code');

  readonly configured = computed(() => this.status()?.configured ?? false);
  readonly enabled    = computed(() => this.status()?.enabled ?? false);
  readonly serverUrl  = computed(() => this.status()?.serverUrl ?? 'http://localhost:3000/mcp');

  // Token shown in snippets: real token once revealed, else a placeholder.
  readonly tokenForSnippet = computed(() => this.token() ?? 'YOUR_MCP_TOKEN');

  readonly codeSnippet = computed(() =>
    `claude mcp add --transport http helpassistant \\\n  ${this.serverUrl()} \\\n  --header "Authorization: Bearer ${this.tokenForSnippet()}"`,
  );

  readonly desktopSnippet = computed(() =>
    JSON.stringify(
      {
        mcpServers: {
          helpassistant: {
            type: 'http',
            url: this.serverUrl(),
            headers: { Authorization: `Bearer ${this.tokenForSnippet()}` },
          },
        },
      },
      null,
      2,
    ),
  );

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.api.getMcpStatus().subscribe({
      next: s => { this.status.set(s); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  generate(): void {
    if (this.configured() && !confirm('Rotate the token? The current token will stop working immediately and any connected Claude host must be reconfigured.')) return;
    this.busy.set(true);
    this.api.generateMcpToken().subscribe({
      next: res => {
        this.busy.set(false);
        this.token.set(res.token);
        this.showToken.set(true);
        this.snack.open('Token generated — copy it now', undefined, { duration: 3000 });
        this.load();
      },
      error: () => { this.busy.set(false); this.snack.open('Failed to generate token', 'OK', { duration: 3000 }); },
    });
  }

  reveal(): void {
    if (this.token()) { this.showToken.set(!this.showToken()); return; }
    this.api.revealMcpToken().subscribe({
      next: res => { this.token.set(res.token); this.showToken.set(true); },
      error: () => this.snack.open('Could not reveal token', 'OK', { duration: 3000 }),
    });
  }

  toggleEnabled(): void {
    const next = !this.enabled();
    this.api.setMcpEnabled(next).subscribe({
      next: () => { this.load(); this.snack.open(next ? 'Connector enabled' : 'Connector disabled', undefined, { duration: 2000 }); },
      error: () => this.snack.open('Update failed', 'OK', { duration: 3000 }),
    });
  }

  revoke(): void {
    if (!confirm('Revoke the connector token? Any connected Claude host will lose access.')) return;
    this.api.revokeMcp().subscribe({
      next: () => { this.token.set(null); this.showToken.set(false); this.load(); this.snack.open('Connector revoked', undefined, { duration: 2000 }); },
      error: () => this.snack.open('Revoke failed', 'OK', { duration: 3000 }),
    });
  }

  copy(text: string, label = 'Copied'): void {
    void navigator.clipboard.writeText(text);
    this.snack.open(label, undefined, { duration: 1500 });
  }

  readonly downloading = signal(false);

  downloadExtension(): void {
    this.downloading.set(true);
    this.api.downloadExtension().subscribe({
      next: (blob) => {
        this.downloading.set(false);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'helpassistant-connector.zip';
        a.click();
        URL.revokeObjectURL(url);
        this.snack.open('Extension downloaded — unzip, then load it in chrome://extensions', undefined, { duration: 5000 });
      },
      error: () => { this.downloading.set(false); this.snack.open('Download failed', 'OK', { duration: 3000 }); },
    });
  }

  maskedToken(): string {
    const last4 = this.status()?.tokenLast4;
    return last4 ? `hamcp_••••••••••••••••${last4}` : '';
  }
}
