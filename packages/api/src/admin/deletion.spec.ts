import type { NextFunction, Request, Response } from 'express';
import { requireAdminUserDeletion } from './deletion';

function run() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
  const next = jest.fn() as NextFunction;
  requireAdminUserDeletion({} as Request, res, next);
  return { res, next };
}

describe('requireAdminUserDeletion', () => {
  const previous = process.env.ADMIN_USER_DELETION;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.ADMIN_USER_DELETION;
    } else {
      process.env.ADMIN_USER_DELETION = previous;
    }
  });

  it('answers 404 unless ADMIN_USER_DELETION is on, as upstream without the route', () => {
    delete process.env.ADMIN_USER_DELETION;

    const { res, next } = run();

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets the request through when ADMIN_USER_DELETION is on', () => {
    process.env.ADMIN_USER_DELETION = 'true';

    const { res, next } = run();

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
