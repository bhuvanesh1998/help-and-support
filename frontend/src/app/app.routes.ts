import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth-guard';
import { permissionGuard } from './core/guards/permission-guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/landing/landing/landing').then((m) => m.Landing),
  },
  {
    path: 'manual/:id',
    loadComponent: () =>
      import('./features/landing/tutorial-reader/tutorial-reader').then((m) => m.TutorialReader),
  },
  // Back-compat: old /tutorials/:id links redirect to the renamed route.
  { path: 'tutorials/:id', redirectTo: 'manual/:id' },
  {
    path: 'embed',
    loadComponent: () =>
      import('./features/embed/embed-panel/embed-panel').then((m) => m.EmbedPanel),
  },
  {
    path: 'admin/login',
    loadComponent: () =>
      import('./features/admin/auth/login/login').then((m) => m.Login),
  },
  // Full-screen image editor — top-level (no admin chrome) but guarded.
  {
    path: 'admin/media/:id/edit',
    loadComponent: () =>
      import('./core/components/image-annotator/image-annotator').then((m) => m.ImageAnnotator),
    canActivate: [authGuard],
  },
  {
    path: 'admin',
    loadComponent: () =>
      import('./features/admin/layout/layout').then((m) => m.Layout),
    canActivate: [authGuard],
    children: [
      { path: '', redirectTo: 'pages', pathMatch: 'full' },
      {
        path: 'pages',
        loadComponent: () =>
          import('./features/admin/pages/pages-list/pages-list').then((m) => m.PagesList),
        canActivate: [permissionGuard('pages.view')],
      },
      {
        path: 'pages/:id',
        loadComponent: () =>
          import('./features/admin/pages/page-detail/page-detail').then((m) => m.PageDetail),
        canActivate: [permissionGuard('pages.view')],
      },
      {
        path: 'categories',
        loadComponent: () =>
          import('./features/admin/categories/categories-list/categories-list').then((m) => m.CategoriesList),
        canActivate: [permissionGuard('categories.view')],
      },
      {
        path: 'connect',
        loadComponent: () =>
          import('./features/admin/connect/connect-settings/connect-settings').then((m) => m.ConnectSettings),
        canActivate: [permissionGuard('embed.view')],
      },
      {
        path: 'media',
        loadComponent: () =>
          import('./features/admin/media/media-manager/media-manager').then(
            (m) => m.MediaManager,
          ),
        canActivate: [permissionGuard('media.view')],
      },
      {
        path: 'analytics',
        loadComponent: () =>
          import('./features/admin/analytics/analytics-dashboard/analytics-dashboard').then(
            (m) => m.AnalyticsDashboard,
          ),
        canActivate: [permissionGuard('analytics.view')],
      },
      {
        path: 'users',
        loadComponent: () =>
          import('./features/admin/users/users-list/users-list').then((m) => m.UsersList),
        canActivate: [permissionGuard('users.manage')],
      },
      {
        path: 'ai',
        loadComponent: () =>
          import('./features/admin/ai/ai-pipeline/ai-pipeline').then((m) => m.AIPipeline),
        canActivate: [permissionGuard('ai.view')],
      },
      {
        path: 'voiceover',
        loadComponent: () =>
          import('./features/admin/voiceover/voiceover-library/voiceover-library').then(
            (m) => m.VoiceoverLibrary,
          ),
        canActivate: [permissionGuard('voiceover.view')],
      },
      {
        path: 'voiceover/new',
        loadComponent: () =>
          import('./features/admin/voiceover/voiceover-studio/voiceover-studio').then(
            (m) => m.VoiceoverStudio,
          ),
        canActivate: [permissionGuard('voiceover.manage')],
      },
      {
        path: 'voiceover/usage',
        loadComponent: () =>
          import('./features/admin/voiceover/usage-report/usage-report').then(
            (m) => m.UsageReport,
          ),
        canActivate: [permissionGuard('voiceover.usage')],
      },
      {
        path: 'voiceover/:id',
        loadComponent: () =>
          import('./features/admin/voiceover/script-detail/script-detail').then(
            (m) => m.ScriptDetail,
          ),
        canActivate: [permissionGuard('voiceover.view')],
      },
      {
        path: 'settings/voiceover',
        loadComponent: () =>
          import(
            './features/admin/settings/voiceover-settings/voiceover-settings'
          ).then((m) => m.VoiceoverSettingsPage),
        canActivate: [permissionGuard('voiceover.settings')],
      },
      {
        path: 'mcp',
        loadComponent: () =>
          import('./features/admin/mcp/mcp-connect/mcp-connect').then((m) => m.McpConnect),
        canActivate: [permissionGuard('mcp.manage')],
      },
      {
        path: 'roles',
        loadComponent: () =>
          import('./features/admin/roles/roles-list/roles-list').then((m) => m.RolesList),
        canActivate: [permissionGuard('roles.manage')],
      },
      {
        path: 'trash',
        loadComponent: () =>
          import('./features/admin/trash/trash-list/trash-list').then((m) => m.TrashList),
        canActivate: [permissionGuard('trash.view')],
      },
      {
        path: 'no-access',
        loadComponent: () =>
          import('./features/admin/no-access/no-access').then((m) => m.NoAccess),
      },
      {
        path: 'exports',
        loadComponent: () =>
          import('./features/admin/exports/exports-list/exports-list').then((m) => m.ExportsList),
        canActivate: [permissionGuard('exports.view')],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
