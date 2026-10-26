import { PermissionBits, ResourceType } from 'librechat-data-provider';
import { logger, PLATFORM_AGENT_LOCKED } from '@librechat/data-schemas';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * The HTTP side of the platform agent lock (fork-only). A tenant's copy of a platform agent is
 * changed by the platform operator only, so every route that changes an agent, its files,
 * actions, avatar, versions or sharing refuses a copy with 403 `platform_agent_locked`, also for
 * callers whose `manage:agents` capability bypasses agent ACLs. Mount these after the route's own
 * access check. data-schemas' `platformAgentLock` holds the same line for any other write.
 */

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const LOCKED_MESSAGE = 'This agent is provided by the platform and cannot be changed here.';

export interface PlatformAgentLockDeps {
  /** The agent with this agent id (`agent_…`) or database id in the caller's tenant. */
  findAgent(filter: { id: string } | { _id: string }): Promise<{ platformAgentId?: string } | null>;
}

export interface PlatformAgentLock {
  /**
   * Refuses the request when `req.params[param]` is a copy's agent id. `management` answers in
   * the agent management API's error shape (`{ error: { code, message } }`).
   */
  byAgentId(param: string, options?: { management?: boolean }): RequestHandler;
  /** For `/api/permissions/:resourceType/:resourceId`: refuses sharing changes of a copy. */
  bySharedResource(): RequestHandler;
}

function refuse(res: Response, management: boolean): void {
  res
    .status(403)
    .json(
      management
        ? { error: { code: PLATFORM_AGENT_LOCKED, message: LOCKED_MESSAGE } }
        : { error: PLATFORM_AGENT_LOCKED, message: LOCKED_MESSAGE },
    );
}

export function createPlatformAgentLock(deps: PlatformAgentLockDeps): PlatformAgentLock {
  const guard =
    (
      filterOf: (req: Request) => { id: string } | { _id: string } | null,
      management: boolean,
    ): RequestHandler =>
    async (req: Request, res: Response, next: NextFunction) => {
      const filter = filterOf(req);
      if (!filter) {
        next();
        return;
      }
      try {
        const agent = await deps.findAgent(filter);
        if (agent?.platformAgentId) {
          refuse(res, management);
          return;
        }
      } catch (error) {
        logger.error('[platformAgentLock] agent lookup failed', getSafeErrorMetadata(error));
        res
          .status(500)
          .json(
            management
              ? { error: { code: 'internal_error', message: 'Internal server error' } }
              : { error: 'Internal Server Error' },
          );
        return;
      }
      next();
    };

  return {
    byAgentId(param, options) {
      return guard((req) => {
        const id = (req.params as Record<string, string | undefined>)[param];
        return typeof id === 'string' && id ? { id } : null;
      }, options?.management === true);
    },
    bySharedResource() {
      return guard((req) => {
        const { resourceType, resourceId } = req.params as Record<string, string | undefined>;
        const agentResource =
          resourceType === ResourceType.AGENT || resourceType === ResourceType.REMOTE_AGENT;
        return agentResource && resourceId && OBJECT_ID.test(resourceId)
          ? { _id: resourceId }
          : null;
      }, false);
    },
  };
}

/** The extra agent list filter: a list of agents to edit leaves copies out. */
export function platformAgentListFilter(requiredPermission: number): Record<string, unknown> {
  return (requiredPermission & PermissionBits.EDIT) !== 0
    ? { platformAgentId: { $exists: false } }
    : {};
}

/** Marks every copy in an agent list as not editable, whatever the caller's grants are. */
export function markPlatformAgents<T extends { platformAgentId?: unknown; isEditable?: boolean }>(
  agents: T[],
): T[] {
  for (const agent of agents) {
    if (agent?.platformAgentId) agent.isEditable = false;
  }
  return agents;
}
