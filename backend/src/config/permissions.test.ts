import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_PERMISSIONS,
  LEGACY_ADMIN_PERMISSIONS,
  PERMISSION_GROUPS,
  SYSTEM_ROLES,
  expandPermissions,
  isPermission,
} from './permissions.js';

test('permission keys are unique', () => {
  assert.equal(new Set(ALL_PERMISSIONS).size, ALL_PERMISSIONS.length);
});

test('every implied key exists in the catalogue', () => {
  for (const p of PERMISSION_GROUPS.flatMap((g) => g.permissions)) {
    for (const implied of p.implies ?? []) {
      assert.ok(isPermission(implied), `${p.key} implies unknown ${implied}`);
    }
  }
});

test('every <feature>.manage implies <feature>.view when a view key exists', () => {
  for (const key of ALL_PERMISSIONS.filter((k) => k.endsWith('.manage'))) {
    const view = key.replace(/\.manage$/, '.view');
    if (!isPermission(view)) continue;
    assert.ok(expandPermissions([key]).includes(view), `${key} should grant ${view}`);
  }
});

test('isPermission rejects unknown keys and non-strings', () => {
  assert.equal(isPermission('pages.view'), true);
  assert.equal(isPermission('pages.delete-everything'), false);
  assert.equal(isPermission(''), false);
  assert.equal(isPermission(undefined), false);
  assert.equal(isPermission(42), false);
  assert.equal(isPermission({ key: 'pages.view' }), false);
});

test('expandPermissions adds implied keys, drops unknown ones and de-duplicates', () => {
  const out = expandPermissions(['pages.manage', 'pages.view', 'bogus.key']);
  assert.deepEqual([...out].sort(), ['pages.manage', 'pages.view']);
});

test('expandPermissions of nothing is nothing', () => {
  assert.deepEqual(expandPermissions([]), []);
});

test('legacy ADMIN fallback excludes user and role administration', () => {
  assert.ok(LEGACY_ADMIN_PERMISSIONS.length > 0);
  for (const key of LEGACY_ADMIN_PERMISSIONS) {
    assert.ok(!key.startsWith('users.') && !key.startsWith('roles.'), key);
  }
  assert.ok(LEGACY_ADMIN_PERMISSIONS.includes('pages.manage'));
});

test('system roles only reference catalogue permissions', () => {
  for (const role of SYSTEM_ROLES) {
    for (const key of role.permissions) {
      assert.ok(isPermission(key), `${role.name}: unknown permission ${key}`);
    }
  }
});
