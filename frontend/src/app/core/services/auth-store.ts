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

  /**
   * Effective permissions for the signed-in account, from /auth/me.
   *
   * A SUPER_ADMIN is treated as holding everything without consulting the list,
   * and an account whose token predates roles (no list at all) is treated as
   * permitted — the server is the authority either way, and guessing "denied"
   * here would blank the UI for a user who is in fact allowed.
   */
  private readonly permissions = computed(() => this._user()?.permissions ?? null);

  can(permission: string): boolean {
    if (this.isSuperAdmin()) return true;
    const list = this.permissions();
    return list === null || list.includes(permission);
  }

  /** True when the account holds at least one of the given permissions. */
  canAny(...permissions: string[]): boolean {
    return permissions.some((p) => this.can(p));
  }

  login(accessToken: string, refreshToken: string, user: AdminUser): void {
    localStorage.setItem(TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    this._token.set(accessToken);
    this._user.set(user);
  }

  setToken(accessToken: string, refreshToken?: string): void {
    localStorage.setItem(TOKEN_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
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
