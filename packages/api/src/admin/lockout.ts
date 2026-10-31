import { SystemRoles, partialWithoutDefaults } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { AdminRolesDeps, RolePermissionsUpdateConfig } from './roles';

/** Stable code of the refusal, for clients that tell it apart from other 403s. */
export const ADMIN_PERMISSIONS_LOCKED = 'admin_permissions_locked';

const LOCKED_MESSAGE = 'Admin access to a feature cannot be removed.';

function isAdminRole(name: unknown): boolean {
  return typeof name === 'string' && name.trim().toUpperCase() === SystemRoles.ADMIN;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether a permissions update (`{ <TYPE>: { <PERMISSION>: boolean } }`) takes a permission away.
 * A value that is not `true` and not nullish counts: the role store drops nullish values and casts
 * the rest (`'false'`, `0`) to booleans. With `current`, only a permission the role holds now
 * counts, so resending one that is already off is not a removal; without it (a role being
 * created), every value that is not `true` does.
 */
export function removesPermission(update: unknown, current?: unknown): boolean {
  const updates = asRecord(update);
  if (!updates) {
    return false;
  }
  const held = current === undefined ? null : (asRecord(current) ?? {});
  return Object.entries(updates).some(([type, permissions]) => {
    const values = asRecord(permissions);
    if (!values) {
      return false;
    }
    return Object.entries(values).some(([permission, value]) => {
      if (value == null || value === true) {
        return false;
      }
      return held == null || asRecord(held[type])?.[permission] === true;
    });
  });
}

function refuse(res: Response): void {
  res.status(403).json({ error: LOCKED_MESSAGE, code: ADMIN_PERMISSIONS_LOCKED });
}

/**
 * The admin API's half of the lockout guard (fork): `PATCH /api/admin/roles/ADMIN/permissions`
 * may not switch off a permission ADMIN holds, and `POST /api/admin/roles` may not create the role
 * ADMIN with a permission off. Both answer 403 `admin_permissions_locked`. A role that does not
 * exist, other roles and malformed bodies pass through to the handlers, which answer them as before.
 */
export interface AdminRolesLockoutGuards {
  refuseAdminPermissionRemoval: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  refuseLockedAdminRole: (req: Request, res: Response, next: NextFunction) => void;
}

export function createAdminRolesLockoutGuards(
  deps: Pick<AdminRolesDeps, 'getRoleByName'>,
): AdminRolesLockoutGuards {
  async function refuseAdminPermissionRemoval(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const { name } = req.params as { name?: string };
    const permissions = (req.body as { permissions?: unknown } | undefined)?.permissions;
    if (!isAdminRole(name) || !removesPermission(permissions)) {
      next();
      return;
    }
    try {
      const role = await deps.getRoleByName(name as string);
      if (role && removesPermission(permissions, role.permissions ?? {})) {
        refuse(res);
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  }

  function refuseLockedAdminRole(req: Request, res: Response, next: NextFunction): void {
    const body = req.body as { name?: unknown; permissions?: unknown } | undefined;
    if (isAdminRole(body?.name) && removesPermission(body?.permissions)) {
      refuse(res);
      return;
    }
    next();
  }

  return { refuseAdminPermissionRemoval, refuseLockedAdminRole };
}

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
      updates = partialWithoutDefaults(schema).parse(req.body);
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
