import type { Query, Schema } from 'mongoose';

/**
 * Fork: a tenant's copy of a platform agent (`platformAgentId` set, see
 * `methods/platformAgent.ts`) is changed only by the platform sync. The HTTP routes refuse such
 * writes with `platform_agent_locked`; this lock is the second line behind them, for every other
 * path that writes agents, including ones that bypass agent ACLs (`manage:agents`).
 *
 * An update, replace or single delete whose filter does not name `platformAgentId`
 * matches no platform copy. The sync always names it. `deleteMany` is left alone: upstream uses
 * it for whole-tenant and whole-user erasure, where a copy goes with the rest. Saving a document
 * that carries `platformAgentId` (a create, or a duplicate of a copy) is refused.
 */

export const PLATFORM_AGENT_LOCKED = 'platform_agent_locked' as const;

export class PlatformAgentLockedError extends Error {
  readonly code: typeof PLATFORM_AGENT_LOCKED = PLATFORM_AGENT_LOCKED;

  constructor() {
    super('Platform agents are changed by the platform operator only');
    this.name = 'PlatformAgentLockedError';
  }
}

const LOCKED_QUERIES = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'findOneAndDelete',
  'deleteOne',
] as const;

const applied = new WeakSet<Schema>();

export function applyPlatformAgentLock(schema: Schema): void {
  if (applied.has(schema)) {
    return;
  }
  applied.add(schema);

  const lock = function (this: Query<unknown, unknown>) {
    if (Object.prototype.hasOwnProperty.call(this.getFilter(), 'platformAgentId')) {
      return;
    }
    this.and([{ platformAgentId: { $exists: false } }]);
  };
  for (const query of LOCKED_QUERIES) {
    schema.pre(query, lock);
  }

  schema.pre('save', function () {
    if (this.get('platformAgentId') != null) {
      throw new PlatformAgentLockedError();
    }
  });
}
