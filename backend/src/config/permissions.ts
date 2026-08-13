/**
 * permissions.ts — What a role can be allowed to do.
 * ─────────────────────────────────────────────────
 * One flat list of `feature.action` keys, grouped for the UI. The catalogue is
 * the single source of truth: the roles screen renders it, the API validates
 * against it, and route guards name keys from it. Adding a feature means adding
 * an entry here and guarding its router — nothing else.
 *
 * `manage` always implies `view`: a role that can edit pages but supposedly
 * cannot see them is a contradiction, and expanding server-side means a
 * hand-crafted API call cannot produce that state either.
 */

/** A single grantable permission. */
export interface PermissionDef {
  key: string;
  label: string;
  /** Shown under the checkbox, so an admin granting it knows what it opens. */
  description: string;
  /** Keys automatically granted alongside this one. */
  implies?: string[];
}

export interface PermissionGroup {
  key: string;
  label: string;
  permissions: PermissionDef[];
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    key: 'content',
    label: 'Content',
    permissions: [
      {
        key: 'pages.view',
        label: 'View pages',
        description: 'Read the manual pages and their tutorial steps.',
      },
      {
        key: 'pages.manage',
        label: 'Manage pages',
        description: 'Create, edit, reorder and delete pages and steps.',
        implies: ['pages.view'],
      },
      {
        key: 'categories.view',
        label: 'View categories',
        description: 'See the module groups pages are filed under.',
      },
      {
        key: 'categories.manage',
        label: 'Manage categories',
        description: 'Create, rename and delete categories.',
        implies: ['categories.view'],
      },
      {
        key: 'media.view',
        label: 'View media',
        description: 'Browse the image and file library.',
      },
      {
        key: 'media.manage',
        label: 'Manage media',
        description: 'Upload, annotate and delete media assets.',
        implies: ['media.view'],
      },
    ],
  },
  {
    key: 'insights',
    label: 'Insights & exports',
    permissions: [
      {
        key: 'analytics.view',
        label: 'View analytics',
        description: 'Usage, view counts and search statistics.',
      },
      {
        key: 'exports.view',
        label: 'Download exports',
        description: 'List and download generated Word and PDF manuals.',
      },
      {
        key: 'exports.manage',
        label: 'Create & restore exports',
        description: 'Generate new exports, delete them, and import a backup.',
        implies: ['exports.view'],
      },
    ],
  },
  {
    key: 'ai',
    label: 'AI & voiceover',
    permissions: [
      {
        key: 'ai.view',
        label: 'View AI pipeline',
        description: 'See pipeline runs and their generated drafts.',
      },
      {
        key: 'ai.manage',
        label: 'Run AI pipeline',
        description: 'Start runs and publish generated content. Consumes API credit.',
        implies: ['ai.view'],
      },
      {
        key: 'voiceover.view',
        label: 'View voiceover scripts',
        description: 'Read saved scripts and listen to rendered narration.',
      },
      {
        key: 'voiceover.manage',
        label: 'Generate voiceover',
        description:
          'Upload video, generate and edit scripts, render narration audio. Consumes API credit.',
        implies: ['voiceover.view'],
      },
      {
        key: 'voiceover.settings',
        label: 'Manage voiceover settings',
        description: 'Change cost and quality limits, and connect provider API keys.',
        implies: ['voiceover.view'],
      },
      {
        key: 'voiceover.usage',
        label: 'View usage report',
        description: 'Tokens and characters the studio has consumed.',
        implies: ['voiceover.view'],
      },
    ],
  },
  {
    key: 'integrations',
    label: 'Integrations',
    permissions: [
      {
        key: 'mcp.manage',
        label: 'Manage MCP connection',
        description: 'Issue and revoke the Claude MCP connector token.',
      },
      {
        key: 'embed.view',
        label: 'View embed widget',
        description: 'See the widget configuration and copy its snippet.',
      },
      {
        key: 'embed.manage',
        label: 'Configure embed widget',
        description: 'Change how the in-app help widget looks and behaves.',
        implies: ['embed.view'],
      },
    ],
  },
  {
    key: 'admin',
    label: 'Administration',
    permissions: [
      {
        key: 'users.manage',
        label: 'Manage users',
        description: 'Invite, deactivate and assign roles to admin users.',
      },
      {
        key: 'roles.manage',
        label: 'Manage roles',
        description: 'Create roles and choose what each one can do. Grant sparingly.',
      },
    ],
  },
];

export const ALL_PERMISSIONS: string[] = PERMISSION_GROUPS.flatMap((g) =>
  g.permissions.map((p) => p.key),
);

const IMPLIED = new Map<string, string[]>(
  PERMISSION_GROUPS.flatMap((g) => g.permissions).map((p) => [p.key, p.implies ?? []]),
);

export function isPermission(value: unknown): value is string {
  return typeof value === 'string' && IMPLIED.has(value);
}

/** Add every implied key, so `pages.manage` alone still grants `pages.view`. */
export function expandPermissions(keys: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const key of keys) {
    if (!IMPLIED.has(key)) continue;
    out.add(key);
    for (const implied of IMPLIED.get(key)!) out.add(implied);
  }
  return [...out];
}

/**
 * What an ADMIN with no role assigned can do — everything except administration.
 *
 * This is the behaviour ADMIN accounts had before roles existed, and it stays the
 * fallback so introducing roles does not silently lock existing users out of
 * screens they were using yesterday.
 */
export const LEGACY_ADMIN_PERMISSIONS: string[] = ALL_PERMISSIONS.filter(
  (key) => !key.startsWith('users.') && !key.startsWith('roles.'),
);

/**
 * Roles created on first boot. Editable in the UI except for their permission
 * set, which is fixed so there is always one coherent role to fall back on.
 */
export const SYSTEM_ROLES: Array<{
  name: string;
  description: string;
  permissions: string[];
}> = [
  {
    name: 'Administrator',
    description: 'Full access to every feature, including users and roles.',
    permissions: ALL_PERMISSIONS,
  },
  {
    name: 'Content Editor',
    description: 'Writes and publishes the manual. No AI spend, no administration.',
    permissions: expandPermissions([
      'pages.manage',
      'categories.manage',
      'media.manage',
      'analytics.view',
      'exports.manage',
      'embed.manage',
    ]),
  },
  {
    name: 'Voiceover Producer',
    description: 'Produces narration end to end, and sees what it costs.',
    permissions: expandPermissions([
      'voiceover.manage',
      'voiceover.settings',
      'voiceover.usage',
      'media.view',
      'pages.view',
      'exports.view',
    ]),
  },
  {
    name: 'Viewer',
    description: 'Read-only across content, analytics and exports.',
    permissions: expandPermissions([
      'pages.view',
      'categories.view',
      'media.view',
      'analytics.view',
      'exports.view',
    ]),
  },
];
