import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { createAdminLockoutGuard, ADMIN_PERMISSIONS_LOCKED } from './lockout';

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
