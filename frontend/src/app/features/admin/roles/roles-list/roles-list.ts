import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import { AuthStore } from '../../../../core/services/auth-store';
import type { AdminRole, PermissionGroup } from '../../../../core/models/admin';

/** The editor's working copy. `id` is null while creating. */
interface Draft {
  id: string | null;
  name: string;
  description: string;
  permissions: Set<string>;
  isSystem: boolean;
}

/**
 * Roles — what each kind of user is allowed to do.
 *
 * The permission catalogue comes from the API rather than being duplicated here,
 * so a feature added server-side appears on this screen without a frontend
 * change and the two can never disagree about what exists.
 */
@Component({
  selector: 'ha-roles-list',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  templateUrl: './roles-list.html',
  styleUrl: './roles-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RolesList implements OnInit {
  private readonly api = inject(AdminApiService);
  readonly auth = inject(AuthStore);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly roles = signal<AdminRole[]>([]);
  readonly groups = signal<PermissionGroup[]>([]);
  readonly draft = signal<Draft | null>(null);
  readonly search = signal('');

  readonly filtered = computed(() => {
    const term = this.search().trim().toLowerCase();
    if (!term) return this.roles();
    return this.roles().filter(
      (r) =>
        r.name.toLowerCase().includes(term) || r.description.toLowerCase().includes(term),
    );
  });

  /** Total grantable permissions, for the "8 of 20" counters. */
  readonly totalPermissions = computed(() =>
    this.groups().reduce((sum, g) => sum + g.permissions.length, 0),
  );

  readonly draftCount = computed(() => this.draft()?.permissions.size ?? 0);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.listRoles().subscribe({
      next: (res) => {
        this.roles.set(res.roles);
        this.groups.set(res.groups);
        this.loading.set(false);
      },
      error: (err: { error?: { message?: string } }) => {
        this.error.set(err.error?.message ?? 'Could not load roles.');
        this.loading.set(false);
      },
    });
  }

  // ── Editor ────────────────────────────────────────────────────────────────

  startCreate(): void {
    this.notice.set('');
    this.error.set('');
    this.draft.set({
      id: null,
      name: '',
      description: '',
      permissions: new Set<string>(),
      isSystem: false,
    });
  }

  startEdit(role: AdminRole): void {
    this.notice.set('');
    this.error.set('');
    this.draft.set({
      id: role.id,
      name: role.name,
      description: role.description,
      permissions: new Set(role.permissions),
      isSystem: role.isSystem,
    });
  }

  /** Copy a role's permissions into a new one — how you customise a built-in. */
  duplicate(role: AdminRole): void {
    this.notice.set('');
    this.error.set('');
    this.draft.set({
      id: null,
      name: `${role.name} (copy)`,
      description: role.description,
      permissions: new Set(role.permissions),
      isSystem: false,
    });
  }

  cancel(): void {
    this.draft.set(null);
  }

  isChecked(key: string): boolean {
    return this.draft()?.permissions.has(key) ?? false;
  }

  /**
   * Toggle a permission, mirroring the server's rule that `manage` implies
   * `view`: granting manage adds its implied keys, and revoking a view that
   * something else depends on revokes that too, so the checkboxes can never show
   * a state the API would reject.
   */
  toggle(key: string, checked: boolean): void {
    const draft = this.draft();
    if (!draft || draft.isSystem) return;

    const next = new Set(draft.permissions);
    const defs = this.groups().flatMap((g) => g.permissions);

    if (checked) {
      next.add(key);
      for (const implied of defs.find((d) => d.key === key)?.implies ?? []) next.add(implied);
    } else {
      next.delete(key);
      for (const def of defs) {
        if (def.implies?.includes(key)) next.delete(def.key);
      }
    }

    this.draft.set({ ...draft, permissions: next });
  }

  /** Select or clear a whole group at once — most roles are group-shaped. */
  toggleGroup(group: PermissionGroup, checked: boolean): void {
    const draft = this.draft();
    if (!draft || draft.isSystem) return;

    const next = new Set(draft.permissions);
    for (const def of group.permissions) {
      if (checked) next.add(def.key);
      else next.delete(def.key);
    }
    this.draft.set({ ...draft, permissions: next });
  }

  groupCount(group: PermissionGroup): number {
    const draft = this.draft();
    if (!draft) return 0;
    return group.permissions.filter((p) => draft.permissions.has(p.key)).length;
  }

  groupAllSelected(group: PermissionGroup): boolean {
    return this.groupCount(group) === group.permissions.length;
  }

  save(): void {
    const draft = this.draft();
    if (!draft) return;
    if (!draft.name.trim()) {
      this.error.set('Give the role a name.');
      return;
    }
    if (draft.permissions.size === 0) {
      this.error.set('Select at least one permission.');
      return;
    }

    this.saving.set(true);
    this.error.set('');
    const permissions = [...draft.permissions];

    const done = (message: string) => {
      this.saving.set(false);
      this.draft.set(null);
      this.notice.set(message);
      this.load();
    };
    const fail = (err: { error?: { message?: string } }) => {
      this.saving.set(false);
      this.error.set(err.error?.message ?? 'Could not save the role.');
    };

    if (draft.id) {
      // A built-in role's permissions are fixed server-side, so only send what
      // it will accept.
      const body = draft.isSystem
        ? { name: draft.name.trim(), description: draft.description.trim() }
        : { name: draft.name.trim(), description: draft.description.trim(), permissions };
      this.api.updateRole(draft.id, body).subscribe({
        next: () => done(`Saved "${draft.name.trim()}".`),
        error: fail,
      });
      return;
    }

    this.api
      .createRole({
        name: draft.name.trim(),
        description: draft.description.trim(),
        permissions,
      })
      .subscribe({ next: () => done(`Created "${draft.name.trim()}".`), error: fail });
  }

  remove(role: AdminRole): void {
    if (!confirm(`Delete the role "${role.name}"? This cannot be undone.`)) return;

    this.api.deleteRole(role.id).subscribe({
      next: () => {
        this.notice.set(`Deleted "${role.name}".`);
        this.load();
      },
      error: (err: { error?: { message?: string } }) =>
        this.error.set(err.error?.message ?? 'Could not delete the role.'),
    });
  }

  /** Permission labels for a role card, so the summary is readable. */
  labelsFor(role: AdminRole): string[] {
    const byKey = new Map(
      this.groups()
        .flatMap((g) => g.permissions)
        .map((p) => [p.key, p.label]),
    );
    // `manage` labels already say what the role does; showing the implied
    // `view` alongside would just pad the card.
    const implied = new Set(
      this.groups()
        .flatMap((g) => g.permissions)
        .filter((p) => role.permissions.includes(p.key))
        .flatMap((p) => p.implies ?? []),
    );
    return role.permissions
      .filter((key) => !implied.has(key))
      .map((key) => byKey.get(key) ?? key)
      .sort((a, b) => a.localeCompare(b));
  }
}
