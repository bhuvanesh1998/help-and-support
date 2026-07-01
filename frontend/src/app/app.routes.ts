import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth-guard';

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
      },
      {
        path: 'pages/:id',
        loadComponent: () =>
          import('./features/admin/pages/page-detail/page-detail').then((m) => m.PageDetail),
      },
      {
        path: 'categories',
        loadComponent: () =>
          import('./features/admin/categories/categories-list/categories-list').then((m) => m.CategoriesList),
      },
      {
        path: 'connect',
        loadComponent: () =>
          import('./features/admin/connect/connect-settings/connect-settings').then((m) => m.ConnectSettings),
      },
      {
        path: 'media',
        loadComponent: () =>
          import('./features/admin/media/media-manager/media-manager').then(
            (m) => m.MediaManager,
          ),
      },
      {
        path: 'analytics',
        loadComponent: () =>
          import('./features/admin/analytics/analytics-dashboard/analytics-dashboard').then(
            (m) => m.AnalyticsDashboard,
          ),
      },
      {
        path: 'users',
        loadComponent: () =>
          import('./features/admin/users/users-list/users-list').then((m) => m.UsersList),
      },
      {
        path: 'ai',
        loadComponent: () =>
          import('./features/admin/ai/ai-pipeline/ai-pipeline').then((m) => m.AIPipeline),
      },
      {
        path: 'mcp',
        loadComponent: () =>
          import('./features/admin/mcp/mcp-connect/mcp-connect').then((m) => m.McpConnect),
      },
      {
        path: 'exports',
        loadComponent: () =>
          import('./features/admin/exports/exports-list/exports-list').then((m) => m.ExportsList),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
