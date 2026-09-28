import { describe, test, expect } from 'vitest';
import { canAccess, ROLES, Action } from './rbac';

describe('RBAC permission matrix', () => {
  test('viewer can read and simulate only', () => {
    expect(canAccess('viewer', 'read')).toBe(true);
    expect(canAccess('viewer', 'simulate')).toBe(true);
    expect(canAccess('viewer', 'mutate-twin')).toBe(false);
    expect(canAccess('viewer', 'apply-change')).toBe(false);
    expect(canAccess('viewer', 'manage-settings')).toBe(false);
    expect(canAccess('viewer', 'manage-users')).toBe(false);
  });

  test('operator can mutate the twin but not apply changes or administer', () => {
    expect(canAccess('operator', 'read')).toBe(true);
    expect(canAccess('operator', 'simulate')).toBe(true);
    expect(canAccess('operator', 'mutate-twin')).toBe(true);
    expect(canAccess('operator', 'apply-change')).toBe(false);
    expect(canAccess('operator', 'manage-settings')).toBe(false);
    expect(canAccess('operator', 'manage-users')).toBe(false);
  });

  test('admin can do everything', () => {
    const actions: Action[] = ['read', 'simulate', 'mutate-twin', 'apply-change', 'manage-settings', 'manage-users'];
    for (const action of actions) {
      expect(canAccess('admin', action)).toBe(true);
    }
  });

  test('unknown role gets nothing', () => {
    expect(canAccess('hacker' as any, 'read')).toBe(false);
  });

  test('role list is exactly admin, operator, viewer', () => {
    expect(ROLES).toEqual(['admin', 'operator', 'viewer']);
  });
});
