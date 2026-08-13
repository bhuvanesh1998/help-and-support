import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthStore } from '../services/auth-store';

/**
 * Route guard for a feature permission.
 *
 * Cosmetic, not a security boundary — the API enforces the same rule on every
 * request. It exists so a user who follows a stale link or types a URL lands
 * somewhere useful instead of on a screen that answers 403 to everything.
 */
export function permissionGuard(...permissions: string[]): CanActivateFn {
  return () => {
    const auth = inject(AuthStore);
    const router = inject(Router);
    if (auth.canAny(...permissions)) return true;
    return router.createUrlTree(['/admin/no-access']);
  };
}
