import { SystemRoles } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { RolePermissionsUpdateConfig } from './roles';

/** Stable code of the refusal, for clients that tell it apart from other 403s. */
export const ADMIN_PERMISSIONS_LOCKED = 'admin_permissions_locked';

/**
 * Refuses a `PUT /api/roles/ADMIN/<type>` that switches a permission off (fork: admin lockout
 * guard). The chat's admin settings dialogs no longer offer the ADMIN role, because a feature
 * switched off for ADMIN locks every admin out of it; this keeps a direct request from doing the
 * same. Other roles, and updates that only grant, pass through. A body the permission schema
 * rejects passes through too, so the update handler answers it with its own 400.
 */
export function createAdminLockoutGuard(schema: RolePermissionsUpdateConfig['schema']) {
  return function refuseAdminLockout(req: Request, res: Response, next: NextFunction): void {
    const { roleName } = req.params as { roleName?: string };
    if (roleName?.toUpperCase() !== SystemRoles.ADMIN) {
      next();
      return;
    }
    let updates: Record<string, boolean | undefined>;
    try {
      updates = schema.partial().parse(req.body);
    } catch {
      next();
      return;
    }
    if (Object.values(updates).some((value) => value === false)) {
      res.status(403).send({
        message: 'Admin access to a feature cannot be removed.',
        code: ADMIN_PERMISSIONS_LOCKED,
      });
      return;
    }
    next();
  };
}
