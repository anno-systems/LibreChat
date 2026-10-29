import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import {
  removesPermission,
  createAdminLockoutGuard,
  createAdminRolesLockoutGuards,
  ADMIN_PERMISSIONS_LOCKED,
} from './lockout';

const schema = z.object({ USE: z.boolean(), CREATE: z.boolean() });

function run(roleName: string, body: unknown) {
  const res = { status: jest.fn().mockReturnThis(), send: jest.fn() } as unknown as Response;
  const next = jest.fn() as NextFunction;
  createAdminLockoutGuard(schema)({ params: { roleName }, body } as unknown as Request, res, next);
  return { res, next };
}

describe('createAdminLockoutGuard', () => {
  it('refuses an update that switches a permission off for ADMIN', () => {
    const { res, next } = run('ADMIN', { USE: true, CREATE: false });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: ADMIN_PERMISSIONS_LOCKED }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('matches the role name case-insensitively', () => {
    const { res, next } = run('admin', { USE: false });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes an update that only grants ADMIN access', () => {
    const { res, next } = run('ADMIN', { USE: true, CREATE: true });

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes other roles, including removals', () => {
    const { res, next } = run('USER', { USE: false });

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('ignores fields the schema does not know', () => {
    const { next } = run('ADMIN', { UNKNOWN: false });

    expect(next).toHaveBeenCalled();
  });

  it('leaves a body the schema rejects to the update handler', () => {
    const { res, next } = run('ADMIN', { USE: 'no' });

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('removesPermission', () => {
  it('counts every value that is not true when the role does not exist yet', () => {
    expect(removesPermission({ AGENTS: { USE: false } })).toBe(true);
    expect(removesPermission({ AGENTS: { USE: 'false' } })).toBe(true);
    expect(removesPermission({ AGENTS: { USE: 0 } })).toBe(true);
    expect(removesPermission({ AGENTS: { USE: true, CREATE: null } })).toBe(false);
    expect(removesPermission(undefined)).toBe(false);
    expect(removesPermission({ AGENTS: 'nope' })).toBe(false);
  });

  it('counts only permissions the role holds now', () => {
    const current = { AGENTS: { USE: true, CREATE: false } };
    expect(removesPermission({ AGENTS: { USE: false } }, current)).toBe(true);
    expect(removesPermission({ AGENTS: { CREATE: false } }, current)).toBe(false);
    expect(removesPermission({ PROMPTS: { USE: false } }, current)).toBe(false);
  });
});

describe('createAdminRolesLockoutGuards', () => {
  const adminRole = { name: 'ADMIN', permissions: { AGENTS: { USE: true, CREATE: false } } };

  function response() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
  }

  async function patch(name: string, permissions: unknown, role: unknown = adminRole) {
    const getRoleByName = jest.fn().mockResolvedValue(role);
    const { refuseAdminPermissionRemoval } = createAdminRolesLockoutGuards({ getRoleByName });
    const res = response();
    const next = jest.fn() as NextFunction;
    await refuseAdminPermissionRemoval(
      { params: { name }, body: { permissions } } as unknown as Request,
      res,
      next,
    );
    return { res, next, getRoleByName };
  }

  it('refuses a PATCH that switches off a permission ADMIN holds', async () => {
    const { res, next } = await patch('ADMIN', { AGENTS: { USE: false } });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ADMIN_PERMISSIONS_LOCKED }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a bulk PATCH when any one value removes a permission', async () => {
    const { res, next } = await patch(
      'admin',
      {
        AGENTS: { USE: true },
        PROMPTS: { USE: true },
        MEMORIES: { USE: true },
        MARKETPLACE: { USE: 'false' },
      },
      { name: 'ADMIN', permissions: { MARKETPLACE: { USE: true } } },
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes grants, resent removals and other roles without a refusal', async () => {
    const granted = await patch('ADMIN', { AGENTS: { USE: true, CREATE: true } });
    expect(granted.next).toHaveBeenCalledWith();
    expect(granted.getRoleByName).not.toHaveBeenCalled();

    const resent = await patch('ADMIN', { AGENTS: { CREATE: false } });
    expect(resent.next).toHaveBeenCalledWith();
    expect(resent.res.status).not.toHaveBeenCalled();

    const other = await patch('USER', { AGENTS: { USE: false } });
    expect(other.next).toHaveBeenCalledWith();
    expect(other.getRoleByName).not.toHaveBeenCalled();
  });

  it('leaves a missing role to the handler', async () => {
    const { res, next } = await patch('ADMIN', { AGENTS: { USE: false } }, null);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('hands a failed role read to the error handler', async () => {
    const getRoleByName = jest.fn().mockRejectedValue(new Error('db down'));
    const { refuseAdminPermissionRemoval } = createAdminRolesLockoutGuards({ getRoleByName });
    const res = response();
    const next = jest.fn() as NextFunction;
    await refuseAdminPermissionRemoval(
      {
        params: { name: 'ADMIN' },
        body: { permissions: { AGENTS: { USE: false } } },
      } as unknown as Request,
      res,
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.status).not.toHaveBeenCalled();
  });

  it('refuses creating the role ADMIN with a permission off', () => {
    const { refuseLockedAdminRole } = createAdminRolesLockoutGuards({ getRoleByName: jest.fn() });
    const run = (body: unknown) => {
      const res = response();
      const next = jest.fn() as NextFunction;
      refuseLockedAdminRole({ body } as unknown as Request, res, next);
      return { res, next };
    };

    const locked = run({ name: ' admin ', permissions: { AGENTS: { USE: false } } });
    expect(locked.res.status).toHaveBeenCalledWith(403);
    expect(locked.next).not.toHaveBeenCalled();

    expect(run({ name: 'ADMIN', permissions: { AGENTS: { USE: true } } }).next).toHaveBeenCalled();
    expect(run({ name: 'STAFF', permissions: { AGENTS: { USE: false } } }).next).toHaveBeenCalled();
    expect(run({ name: 'ADMIN' }).next).toHaveBeenCalled();
  });
});
