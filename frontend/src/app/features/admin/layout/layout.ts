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
import { ThemeService } from '../../../core/services/theme.service';

interface NavItem {
  label: string;
  icon: string;
  route: string;
  description: string;
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

  readonly sidenavOpen = signal(true);
  readonly pageTitle   = signal('Pages');

  readonly navItems: NavItem[] = [
    { label: 'Pages',       icon: 'article',       route: '/admin/pages',      description: 'User manual pages & steps' },
    { label: 'Categories',  icon: 'category',      route: '/admin/categories', description: 'Manage module groups' },
    { label: 'Media',       icon: 'photo_library', route: '/admin/media',      description: 'Images & file assets' },
    { label: 'Analytics',   icon: 'bar_chart',     route: '/admin/analytics', description: 'Usage & view stats' },
    { label: 'Users',       icon: 'group',         route: '/admin/users',     description: 'Admin user accounts' },
    { label: 'AI Pipeline', icon: 'smart_toy',     route: '/admin/ai',        description: 'AI content pipeline' },
    { label: 'MCP Connect', icon: 'cable',         route: '/admin/mcp',       description: 'Connect via Claude MCP' },
    { label: 'Embed Widget',icon: 'integration_instructions', route: '/admin/connect', description: 'Add the help widget to your app' },
    { label: 'Downloads',   icon: 'download',       route: '/admin/exports',   description: 'Word / PDF exports' },
  ];

  readonly userInitials = computed(() =>
    (this.auth.currentUser()?.email ?? '??').slice(0, 2).toUpperCase(),
  );

  constructor() {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        const match = this.navItems.find((n) => e.urlAfterRedirects.startsWith(n.route));
        if (match) this.pageTitle.set(match.label);
      });
  }

  toggleSidenav(): void { this.sidenavOpen.update((v) => !v); }

  logout(): void {
    this.auth.logout();
    void this.router.navigate(['/admin/login']);
  }
}
