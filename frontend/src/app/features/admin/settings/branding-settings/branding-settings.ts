import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AdminApiService } from '../../../../core/services/admin-api';
import { AuthStore } from '../../../../core/services/auth-store';
import { SiteSettingsService } from '../../../../core/services/site-settings.service';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../../../../core/models/support';

type LogoKey = 'logoLightUrl' | 'logoDarkUrl' | 'faviconUrl';

/** Branding — public brand name, footer text/credit and light/dark logos. */
@Component({
  selector: 'ha-branding-settings',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  templateUrl: './branding-settings.html',
  styleUrls: ['../../support/admin-form.scss', './branding-settings.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandingSettings implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);
  private readonly auth = inject(AuthStore);
  private readonly site = inject(SiteSettingsService);

  readonly logoSlots: ReadonlyArray<{ key: LogoKey; label: string; bg: 'light' | 'dark' }> = [
    { key: 'logoLightUrl', label: 'Light mode logo', bg: 'light' },
    { key: 'logoDarkUrl', label: 'Dark mode logo', bg: 'dark' },
  ];
  /** Browser-tab icon — square PNG/SVG/ICO, at least 32×32 (180×180 also covers iOS). */
  readonly faviconSlot = { key: 'faviconUrl' as const, label: 'Favicon (browser tab icon)' };

  readonly canManage = computed(() => this.auth.can('settings.manage'));

  readonly model = signal<SiteSettings>({ ...DEFAULT_SITE_SETTINGS });
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly uploading = signal<LogoKey | null>(null);
  readonly error = signal<string | null>(null);
  private readonly savedJson = signal('');
  readonly dirty = computed(() => JSON.stringify(this.model()) !== this.savedJson());

  ngOnInit(): void {
    this.api.getSiteSettings().subscribe({
      next: ({ settings }) => {
        this.model.set({ ...DEFAULT_SITE_SETTINGS, ...settings });
        this.savedJson.set(JSON.stringify(this.model()));
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Could not load branding settings.');
        this.savedJson.set(JSON.stringify(this.model()));
        this.loading.set(false);
      },
    });
  }

  set<K extends keyof SiteSettings>(key: K, value: SiteSettings[K]): void {
    this.model.update((m) => ({ ...m, [key]: value }));
  }

  setLogo(key: LogoKey, value: string): void {
    this.set(key, value.trim() ? value.trim() : null);
  }

  upload(key: LogoKey, ev: Event): void {
    const inputEl = ev.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.snack.open('Please choose an image file.', undefined, { duration: 2500 });
      return;
    }
    this.uploading.set(key);
    this.api.uploadMedia(file).subscribe({
      next: ({ asset }) => {
        this.uploading.set(null);
        this.set(key, asset.publicUrl);
      },
      error: () => {
        this.uploading.set(null);
        this.snack.open('Upload failed. Please try again.', undefined, { duration: 3000 });
      },
    });
  }

  save(): void {
    if (this.saving()) return;
    const m = this.model();
    if (!m.brandName.trim()) {
      this.error.set('Brand name is required.');
      return;
    }
    if (m.creditUrl && !/^https?:\/\//i.test(m.creditUrl.trim())) {
      this.error.set('Credit URL must start with http:// or https://');
      return;
    }
    this.error.set(null);
    this.saving.set(true);
    this.api.saveSiteSettings(m).subscribe({
      next: ({ settings }) => {
        this.model.set({ ...DEFAULT_SITE_SETTINGS, ...settings });
        this.savedJson.set(JSON.stringify(this.model()));
        this.site.settings.set(this.model());
        this.saving.set(false);
        this.snack.open('Branding saved', undefined, { duration: 2000 });
      },
      error: (e) => {
        this.saving.set(false);
        this.error.set(e?.error?.error?.message ?? 'Could not save branding settings.');
      },
    });
  }
}
