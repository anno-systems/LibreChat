import type { NextFunction, Request, Response } from 'express';
import { isEnabled } from '~/utils';

/**
 * Gates upstream's admin user deletion (`DELETE /api/admin/users/:id`), which upstream ships but
 * leaves unrouted. With `ADMIN_USER_DELETION=true` tenant admins can erase a user of their own
 * tenant, as data protection law requires; otherwise the route answers 404 as before
 * (fork: admin user deletion).
 */
export function requireAdminUserDeletion(_req: Request, res: Response, next: NextFunction): void {
  if (!isEnabled(process.env.ADMIN_USER_DELETION)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}
