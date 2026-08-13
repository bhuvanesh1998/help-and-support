import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth-interceptor';
import { AppConfigService } from './core/config/app-config.service';

/**
 * Load runtime config before the app boots. `/app-config.json` is written by the
 * deploy environment (nginx entrypoint) so the same build can target any backend.
 * Failures are non-fatal — the compile-time `environment` value remains in effect.
 */
async function loadRuntimeConfig(config: AppConfigService): Promise<void> {
  try {
    const res = await fetch('/app-config.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const data: unknown = await res.json();
    const apiBaseUrl = (data as { apiBaseUrl?: unknown })?.apiBaseUrl;
    if (typeof apiBaseUrl === 'string' && apiBaseUrl.trim()) {
      config.apiBaseUrl = apiBaseUrl.trim().replace(/\/$/, '');
    }
  } catch {
    // Network/parse error: keep the compile-time fallback.
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideAppInitializer(() => loadRuntimeConfig(inject(AppConfigService))),
    provideRouter(routes),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    provideAnimationsAsync(),
  ],
};
