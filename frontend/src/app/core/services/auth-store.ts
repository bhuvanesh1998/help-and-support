import { Injectable, computed, signal } from '@angular/core';
import type { AdminUser } from '../models/admin';

const TOKEN_KEY = 'ha_access_token';
const REFRESH_KEY = 'ha_refresh_token';
const USER_KEY = 'ha_user';

@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly _token = signal<string | null>(localStorage.getItem(TOKEN_KEY));
  private readonly _user = signal<AdminUser | null>(this.loadUser());

  readonly accessToken = this._token.asReadonly();
  readonly currentUser = this._user.asReadonly();
  readonly isAuthenticated = computed(() => !!this._token());
  readonly isSuperAdmin = computed(() => this._user()?.role === 'SUPER_ADMIN');

  login(accessToken: string, refreshToken: string, user: AdminUser): void {
    localStorage.setItem(TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    this._token.set(accessToken);
    this._user.set(user);
  }

  setToken(accessToken: string): void {
    localStorage.setItem(TOKEN_KEY, accessToken);
    this._token.set(accessToken);
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    this._token.set(null);
    this._user.set(null);
  }

  getRefreshToken(): string | null {
    return localStorage.getItem(REFRESH_KEY);
  }

  private loadUser(): AdminUser | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? (JSON.parse(raw) as AdminUser) : null;
    } catch {
      return null;
    }
  }
}
