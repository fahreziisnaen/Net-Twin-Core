export type Role = 'admin' | 'operator' | 'viewer';

export type Action =
  | 'read'            // GET topology/audits/changes/settings
  | 'simulate'        // run path simulations (read-only computation)
  | 'mutate-twin'     // CRUD nodes/links/routes/NAT/audits, draft change requests
  | 'apply-change'    // approve & push a change request into the twin
  | 'manage-settings' // engine settings, reset, snapshot import
  | 'manage-users';   // user administration

export const ROLES: Role[] = ['admin', 'operator', 'viewer'];

const PERMISSIONS: Record<Role, ReadonlySet<Action>> = {
  admin: new Set<Action>(['read', 'simulate', 'mutate-twin', 'apply-change', 'manage-settings', 'manage-users']),
  operator: new Set<Action>(['read', 'simulate', 'mutate-twin']),
  viewer: new Set<Action>(['read', 'simulate']),
};

export function canAccess(role: Role, action: Action): boolean {
  return PERMISSIONS[role]?.has(action) ?? false;
}
