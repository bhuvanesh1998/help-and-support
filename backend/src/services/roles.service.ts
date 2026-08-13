/**
 * roles.service.ts — Roles and the permissions they carry.
 * ───────────────────────────────────────────────────────
 * A role is a named permission set. Users point at one; SUPER_ADMIN bypasses the
 * whole mechanism so an instance can never be locked out of its own
 * administration.
 *
 * Permissions are stored expanded (implied keys included), so every check is a
 * plain membership test rather than a graph walk at request time.
 */

import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  ALL_PERMISSIONS,
  LEGACY_ADMIN_PERMISSIONS,
  SYSTEM_ROLES,
  expandPermissions,
  isPermission,
} from '../config/permissions.js';
import { AppError } from '../utils/app-error.js';

export interface RoleSummary {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  /** How many accounts use this role — shown before anyone deletes one. */
  userCount: number;
  createdAt: Date;
}

const NAME_MAX = 60;
const DESCRIPTION_MAX = 240;

function sanitizeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw AppError.badRequest('A role name is required');
  if (name.length > NAME_MAX) {
    throw AppError.badRequest(`Role names are limited to ${NAME_MAX} characters`);
  }
  return name;
}

function sanitizeDescription(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > DESCRIPTION_MAX) {
    throw AppError.badRequest(`Descriptions are limited to ${DESCRIPTION_MAX} characters`);
  }
  return text;
}

/** Keep only keys the catalogue knows, then add everything they imply. */
function sanitizePermissions(value: unknown): string[] {
  if (!Array.isArray(value)) throw AppError.badRequest('permissions must be an array');
  const known = value.filter(isPermission);
  if (known.length === 0) {
    throw AppError.badRequest('Select at least one permission for this role');
  }
  return expandPermissions(known);
}

export async function listRoles(): Promise<RoleSummary[]> {
  const roles = await prisma.role.findMany({
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { users: true } } },
  });

  return roles.map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    permissions: role.permissions,
    isSystem: role.isSystem,
    userCount: role._count.users,
    createdAt: role.createdAt,
  }));
}

export async function createRole(input: {
  name: unknown;
  description: unknown;
  permissions: unknown;
}): Promise<RoleSummary> {
  const name = sanitizeName(input.name);
  const existing = await prisma.role.findUnique({ where: { name } });
  if (existing) throw AppError.badRequest(`A role named "${name}" already exists`);

  const role = await prisma.role.create({
    data: {
      name,
      description: sanitizeDescription(input.description),
      permissions: sanitizePermissions(input.permissions),
    },
  });

  return { ...role, userCount: 0 };
}

/**
 * Update a role. System roles can be renamed and re-described but keep their
 * permission set: they are the guaranteed-coherent fallback, and an edited
 * "Administrator" that no longer administers is a trap.
 */
export async function updateRole(
  id: string,
  input: { name?: unknown; description?: unknown; permissions?: unknown },
): Promise<RoleSummary> {
  const role = await prisma.role.findUnique({
    where: { id },
    include: { _count: { select: { users: true } } },
  });
  if (!role) throw AppError.notFound('Role not found');

  const data: { name?: string; description?: string; permissions?: string[] } = {};

  if (input.name !== undefined) {
    const name = sanitizeName(input.name);
    if (name !== role.name) {
      const clash = await prisma.role.findUnique({ where: { name } });
      if (clash) throw AppError.badRequest(`A role named "${name}" already exists`);
      data.name = name;
    }
  }
  if (input.description !== undefined) data.description = sanitizeDescription(input.description);
  if (input.permissions !== undefined) {
    if (role.isSystem) {
      throw AppError.badRequest(
        `"${role.name}" is a built-in role, so its permissions are fixed. Duplicate it under a new name to change them.`,
      );
    }
    data.permissions = sanitizePermissions(input.permissions);
  }

  const updated = await prisma.role.update({ where: { id }, data });
  return { ...updated, userCount: role._count.users };
}

export async function deleteRole(id: string): Promise<void> {
  const role = await prisma.role.findUnique({
    where: { id },
    include: { _count: { select: { users: true } } },
  });
  if (!role) throw AppError.notFound('Role not found');
  if (role.isSystem) throw AppError.badRequest('Built-in roles cannot be deleted');
  if (role._count.users > 0) {
    throw AppError.badRequest(
      role._count.users === 1
        ? '1 user still holds this role. Reassign them first.'
        : `${role._count.users} users still hold this role. Reassign them first.`,
    );
  }

  await prisma.role.delete({ where: { id } });
}

export interface ResolvedAccess {
  roleId: string | null;
  roleName: string | null;
  permissions: string[];
}

/**
 * The effective permissions for a user.
 *
 * SUPER_ADMIN gets everything, always. An ADMIN with no role assigned gets the
 * pre-roles behaviour rather than nothing, so introducing roles does not lock
 * existing accounts out of screens they were using yesterday.
 */
export async function resolveAccess(userId: string, tier: UserRole): Promise<ResolvedAccess> {
  if (tier === UserRole.SUPER_ADMIN) {
    return { roleId: null, roleName: 'Super Admin', permissions: ALL_PERMISSIONS };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { accessRole: { select: { id: true, name: true, permissions: true } } },
  });

  const role = user?.accessRole;
  if (!role) return { roleId: null, roleName: null, permissions: LEGACY_ADMIN_PERMISSIONS };

  return { roleId: role.id, roleName: role.name, permissions: role.permissions };
}

export async function hasPermission(
  userId: string,
  tier: UserRole,
  permission: string,
): Promise<boolean> {
  if (tier === UserRole.SUPER_ADMIN) return true;
  const { permissions } = await resolveAccess(userId, tier);
  return permissions.includes(permission);
}

/** Create the built-in roles once, on boot. Renames by an admin are preserved. */
export async function ensureSystemRoles(): Promise<void> {
  try {
    for (const seed of SYSTEM_ROLES) {
      const existing = await prisma.role.findFirst({
        where: { name: seed.name, isSystem: true },
      });
      if (existing) {
        // Keep the permission set in step with the catalogue: a feature added
        // after seeding should reach Administrator without a manual edit.
        const same =
          existing.permissions.length === seed.permissions.length &&
          seed.permissions.every((p) => existing.permissions.includes(p));
        if (!same) {
          await prisma.role.update({
            where: { id: existing.id },
            data: { permissions: seed.permissions },
          });
        }
        continue;
      }

      await prisma.role.create({
        data: {
          name: seed.name,
          description: seed.description,
          permissions: seed.permissions,
          isSystem: true,
        },
      });
      logger.info('roles: created built-in role', { name: seed.name });
    }
  } catch (err) {
    // A missing roles table (migration not yet applied) must not stop the server
    // from booting — every other feature still works.
    logger.warn('roles: could not ensure built-in roles', { error: (err as Error).message });
  }
}
