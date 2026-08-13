import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatRippleModule } from '@angular/material/core';
import { MatDividerModule } from '@angular/material/divider';
import { AuthStore } from '../../../core/services/auth-store';
import { AdminApiService } from '../../../core/services/admin-api';
import { ThemeService } from '../../../core/services/theme.service';

interface NavItem {
  label: string;
  icon: string;
  route: string;
  description: string;
  /** Permission required to see this entry. */
  permission: string;
  /** Pinned below a divider at the end of the sidebar. */
  footer?: boolean;
}

@Component({
  selector: 'ha-layout',
  imports: [
    RouterOutlet, RouterLink, RouterLinkActive,
    MatIconModule, MatButtonModule, MatMenuModule, MatTooltipModule, MatRippleModule, MatDividerModule,
  ],
  templateUrl: './layout.html',
  styleUrl: './layout.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Layout {
  readonly auth  = inject(AuthStore);
  readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly api = inject(AdminApiService);

  readonly sidenavOpen = signal(true);
  readonly pageTitle   = signal('Pages');

  /**
   * Every entry names the permission that reveals it. Order matters: the page
   * title is resolved by longest-prefix match, so the more specific routes
   * (/admin/voiceover/usage) must be listed before their parents.
   */
  private readonly allNavItems: NavItem[] = [
    { label: 'Pages',       icon: 'article',       route: '/admin/pages',      description: 'User manual pages & steps',        permission: 'pages.view' },
    { label: 'Categories',  icon: 'category',      route: '/admin/categories', description: 'Manage module groups',             permission: 'categories.view' },
    { label: 'Media',       icon: 'photo_library', route: '/admin/media',      description: 'Images & file assets',             permission: 'media.view' },
    { label: 'Analytics',   icon: 'bar_chart',     route: '/admin/analytics',  description: 'Usage & view stats',               permission: 'analytics.view' },
    { label: 'Users',       icon: 'group',         route: '/admin/users',      description: 'Admin user accounts',              permission: 'users.manage' },
    { label: 'Roles',       icon: 'badge',         route: '/admin/roles',      description: 'What each role may do',            permission: 'roles.manage' },
    { label: 'AI Pipeline', icon: 'smart_toy',     route: '/admin/ai',         description: 'AI content pipeline',              permission: 'ai.view' },
    { label: 'Voiceover',   icon: 'graphic_eq',    route: '/admin/voiceover',  description: 'Video → timed VO script',          permission: 'voiceover.view' },
    { label: 'VO Usage',    icon: 'insights',      route: '/admin/voiceover/usage', description: 'Tokens & characters consumed', permission: 'voiceover.usage' },
    { label: 'VO Settings', icon: 'tune',          route: '/admin/settings/voiceover', description: 'Voiceover cost & quality controls', permission: 'voiceover.settings' },
    { label: 'MCP Connect', icon: 'cable',         route: '/admin/mcp',        description: 'Connect via Claude MCP',           permission: 'mcp.manage' },
    { label: 'Embed Widget',icon: 'integration_instructions', route: '/admin/connect', description: 'Add the help widget to your app', permission: 'embed.view' },
    { label: 'Downloads',   icon: 'download',      route: '/admin/exports',    description: 'Word / PDF exports',               permission: 'exports.view' },
    { label: 'Trash',       icon: 'delete_outline', route: '/admin/trash',     description: 'Deleted items, kept 30 days',      permission: 'trash.view', footer: true },
  ];

  /** Only what this account can actually open. */
  private readonly visibleNav = computed(() =>
    this.allNavItems.filter((n) => this.auth.can(n.permission)),
  );

  readonly navItems = computed(() => this.visibleNav().filter((n) => !n.footer));

  /** Pinned to the bottom of the sidebar, away from the working screens. */
  readonly footerNavItems = computed(() => this.visibleNav().filter((n) => n.footer));

  readonly userInitials = computed(() =>
    (this.auth.currentUser()?.email ?? '??').slice(0, 2).toUpperCase(),
  );

  constructor() {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        // Longest prefix wins, so /admin/voiceover/usage titles as "VO Usage"
        // rather than "Voiceover".
        const match = [...this.allNavItems]
          .sort((a, b) => b.route.length - a.route.length)
          .find((n) => e.urlAfterRedirects.startsWith(n.route));
        this.pageTitle.set(match?.label ?? 'Admin');
      });
  }

  toggleSidenav(): void { this.sidenavOpen.update((v) => !v); }

  /**
   * Sign out. The server call invalidates the tokens already issued; local
   * storage is cleared either way, because a network failure must not leave
   * someone stuck signed in on a machine they are walking away from.
   */
  logout(): void {
    this.api.logout().subscribe({
      next: () => this.finishLogout(),
      error: () => this.finishLogout(),
    });
  }

  private finishLogout(): void {
    this.auth.logout();
    void this.router.navigate(['/admin/login']);
  }
}
