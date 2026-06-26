import { inject } from '@angular/core';
import {
  HttpClient,
  HttpErrorResponse,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { Router } from '@angular/router';
import { catchError, switchMap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthStore } from '../services/auth-store';

/**
 * Attaches the access token to admin requests and transparently recovers from
 * an expired access token: on a 401 it exchanges the refresh token for a fresh
 * access token (POST /admin/auth/refresh), then retries the original request.
 * If refresh fails (or there's no refresh token), it logs out and redirects
 * to the login page instead of leaving the user in a broken, half-authed state.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth   = inject(AuthStore);
  const http   = inject(HttpClient);
  const router = inject(Router);

  const isAdmin = req.url.includes('/admin/');

  const token = auth.accessToken();
  const authedReq =
    token && isAdmin
      ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : req;

  return next(authedReq).pipe(
    catchError((err: unknown) => {
      const is401 = err instanceof HttpErrorResponse && err.status === 401;

      // Only intervene for admin calls. Never try to refresh the refresh/login
      // calls themselves (would loop).
      const isAuthExchange =
        req.url.includes('/admin/auth/refresh') || req.url.includes('/admin/auth/login');

      if (!is401 || !isAdmin || isAuthExchange) {
        return throwError(() => err);
      }

      const refreshToken = auth.getRefreshToken();
      if (!refreshToken) {
        auth.logout();
        void router.navigate(['/admin/login']);
        return throwError(() => err);
      }

      // Exchange the refresh token for a new access token, then retry once.
      return http
        .post<{ accessToken: string }>(`${environment.apiBaseUrl}/admin/auth/refresh`, {
          refreshToken,
        })
        .pipe(
          switchMap((res) => {
            auth.setToken(res.accessToken);
            return next(
              req.clone({ setHeaders: { Authorization: `Bearer ${res.accessToken}` } }),
            );
          }),
          catchError((refreshErr: unknown) => {
            auth.logout();
            void router.navigate(['/admin/login']);
            return throwError(() => refreshErr);
          }),
        );
    }),
  );
};
