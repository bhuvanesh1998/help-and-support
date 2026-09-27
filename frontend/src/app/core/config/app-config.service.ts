import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';

/**
 * Runtime application configuration.
 *
 * The API base URL is resolved at bootstrap from `/app-config.json` (see the
 * `provideAppInitializer` in `app.config.ts`). This lets a single built artifact
 * target any backend origin without a rebuild — the deploy environment (e.g. the
 * frontend container's nginx entrypoint) writes `app-config.json` from an env var.
 *
 * Until the fetch resolves, `apiBaseUrl` holds the compile-time `environment`
 * value, so same-origin/dev builds work with no extra setup.
 */
@Injectable({ providedIn: 'root' })
export class AppConfigService {
  /** Resolved at bootstrap; defaults to the compile-time value. */
  apiBaseUrl = environment.apiBaseUrl;
}
