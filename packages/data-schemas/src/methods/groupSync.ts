import type { Model, Types } from 'mongoose';
import type { UserGroupMethods } from './userGroup';
import type { IGroup, IUser } from '~/types';
import { escapeRegExp } from '~/utils/string';

/**
 * Group memberships from an external identity provider (fork-only). The provider names a user's
 * groups at each sign-in; the user's memberships in that provider's groups are made to match,
 * creating groups the tenant has not seen yet. Groups are `source: 'oidc'` with
 * `idOnTheSource = <scope>:<group id>`, so two providers of a tenant cannot collide and one
 * provider's sync never touches another's groups or the tenant's own (`local`) groups.
 */

/** Group source of provider-synced groups. */
export const EXTERNAL_GROUP_SOURCE = 'oidc';
/** Groups taken from one sign-in; Entra ID itself stops listing groups in tokens at 200. */
export const MAX_SYNCED_GROUPS = 200;

export interface ExternalGroupRef {
  id: string;
  /** Shown name for a new group; defaults to the id. Existing groups keep their name. */
  name?: string;
}

export interface ExternalGroupSyncResult {
  joined: number;
  left: number;
}

export interface GroupSyncMethods {
  syncExternalGroupMemberships(params: {
    userId: string | Types.ObjectId;
    /** The provider the groups belong to, e.g. its id or issuer. */
    scope: string;
    groups: ExternalGroupRef[];
  }): Promise<ExternalGroupSyncResult>;
}

export function createGroupSyncMethods(
  mongoose: typeof import('mongoose'),
  deps: Pick<UserGroupMethods, 'bulkUpdateGroups'>,
): GroupSyncMethods {
  async function syncExternalGroupMemberships({
    userId,
    scope,
    groups,
  }: {
    userId: string | Types.ObjectId;
    scope: string;
    groups: ExternalGroupRef[];
  }): Promise<ExternalGroupSyncResult> {
    const User = mongoose.models.User as Model<IUser>;
    const Group = mongoose.models.Group as Model<IGroup>;
    const user = await User.findById(userId, 'idOnTheSource').lean<{ idOnTheSource?: string }>();
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    /** Group.memberIds holds the user's external id when it has one (see addUserToGroup). */
    const member = user.idOnTheSource || userId.toString();
    const prefix = `${scope}:`;
    const wanted = new Map<string, ExternalGroupRef>();
    for (const group of groups.slice(0, MAX_SYNCED_GROUPS)) {
      wanted.set(`${prefix}${group.id}`, group);
    }
    const ids = [...wanted.keys()];

    let joined = 0;
    if (ids.length > 0) {
      const existing = await Group.find(
        { source: EXTERNAL_GROUP_SOURCE, idOnTheSource: { $in: ids } },
        { idOnTheSource: 1 },
      ).lean<{ idOnTheSource?: string }[]>();
      const known = new Set(existing.map((g) => g.idOnTheSource));
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length > 0) {
        await Group.insertMany(
          missing.map((id) => ({
            name: wanted.get(id)?.name || wanted.get(id)?.id || id,
            source: EXTERNAL_GROUP_SOURCE,
            idOnTheSource: id,
            memberIds: [],
          })),
          { ordered: false },
        ).catch((err: { code?: number; writeErrors?: { code?: number }[] }) => {
          /** A parallel sign-in created the same group; the unique index kept one. */
          const duplicates = err.code === 11000 || err.writeErrors?.every((e) => e.code === 11000);
          if (!duplicates) {
            throw err;
          }
        });
      }
      const added = await deps.bulkUpdateGroups(
        { source: EXTERNAL_GROUP_SOURCE, idOnTheSource: { $in: ids }, memberIds: { $ne: member } },
        { $addToSet: { memberIds: member } },
      );
      joined = added.modifiedCount;
    }

    const removed = await deps.bulkUpdateGroups(
      {
        source: EXTERNAL_GROUP_SOURCE,
        idOnTheSource: { $regex: `^${escapeRegExp(prefix)}`, $nin: ids },
        memberIds: member,
      },
      { $pull: { memberIds: member } },
    );
    return { joined, left: removed.modifiedCount };
  }

  return { syncExternalGroupMemberships };
}
