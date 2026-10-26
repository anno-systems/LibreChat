import { Schema, Types } from 'mongoose';
import {
  Constants,
  ResourceType,
  PrincipalType,
  AccessRoleIds,
  PermissionBits,
} from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type { IAclEntry, IAgent } from '~/types';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createAccessRoleMethods } from './accessRole';

/**
 * Platform agents (fork-only): agents the platform operator defines once (`PlatformAgent`,
 * platform-wide, no tenant) for every tenant or for listed ones. Each targeted tenant whose
 * admins did not switch the agent off holds a copy: an ordinary `Agent` document of the tenant
 * with `platformAgentId` set, shared with everyone in the tenant (upstream's public viewer
 * grant), so the chat, the agent list, sharing and usage treat it like any agent. Only these
 * methods write copies; `models/plugins/platformAgentLock.ts` keeps every other path off them.
 */

export interface PlatformAgent {
  /** `platform_<slug>`. */
  platformAgentId: string;
  name: string;
  description: string;
  instructions: string;
  conversation_starters: string[];
  /** Agent tool ids, e.g. MCP tools `<tool>_mcp_<server>`. */
  tools: string[];
  /** A platform provider's name (a custom endpoint of the tenants that run it). */
  provider: string;
  model: string;
  model_parameters?: Record<string, string | number | boolean>;
  /** Every tenant, also ones created later, or the listed ones. */
  tenants: 'all' | string[];
  /** Tenants whose admins switched the agent off. */
  disabledTenants: string[];
  updatedAt?: Date;
}

/** What the operator writes; a tenant's on/off state is kept apart from it. */
export type PlatformAgentInput = Omit<PlatformAgent, 'disabledTenants' | 'updatedAt'>;

/** A tenant's copy of a platform agent. */
export interface PlatformAgentCopy {
  tenantId: string;
  platformAgentId: string;
  /** The copy's agent id (`agent_<platformAgentId>`). */
  agentId: string;
  updatedAt?: Date;
}

export interface PlatformAgentMethods {
  listPlatformAgents(): Promise<PlatformAgent[]>;
  /** Null when no platform agent has the id. */
  getPlatformAgent(platformAgentId: string): Promise<PlatformAgent | null>;
  /** Creates or replaces the definition; the tenants' on/off states stay. */
  upsertPlatformAgent(input: PlatformAgentInput): Promise<PlatformAgent>;
  /** False when no platform agent has the id. Copies are removed by the caller. */
  deletePlatformAgent(platformAgentId: string): Promise<boolean>;
  /** The ids of the platform agents that run on a provider. */
  platformAgentsUsingProvider(provider: string): Promise<string[]>;
  /** Null when no platform agent has the id. */
  setPlatformAgentEnabled(
    platformAgentId: string,
    tenantId: string,
    enabled: boolean,
  ): Promise<PlatformAgent | null>;
  /** Every tenant's copies of one platform agent. */
  listPlatformAgentCopies(platformAgentId: string): Promise<PlatformAgentCopy[]>;
  /** One tenant's copies of every platform agent. */
  listTenantPlatformAgentCopies(tenantId: string): Promise<PlatformAgentCopy[]>;
  /** Creates or updates the tenant's copy and its viewer grant for everyone in the tenant. */
  writePlatformAgentCopy(tenantId: string, agent: PlatformAgent): Promise<void>;
  /** Deletes the tenant's copy and its grants; false when it had none. */
  removePlatformAgentCopy(tenantId: string, platformAgentId: string): Promise<boolean>;
}

/** The agent id of every tenant's copy; one per tenant (`{ id, tenantId }` is unique). */
export function platformAgentCopyId(platformAgentId: string): string {
  return `agent_${platformAgentId}`;
}

/** The author of every copy: no user, so no user owns, edits or erases it with their data. */
export const PLATFORM_AGENT_AUTHOR: Types.ObjectId = new Types.ObjectId('000000000000000000000000');

interface PlatformAgentDoc extends Omit<PlatformAgent, 'tenants'> {
  allTenants: boolean;
  tenantIds: string[];
}

/** The fields of a copy that the sync reads back. */
interface CopyDoc {
  id: string;
  tenantId?: string;
  platformAgentId?: string;
  updatedAt?: Date;
}

const platformAgentSchema = new Schema<PlatformAgentDoc>(
  {
    platformAgentId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    instructions: { type: String, default: '' },
    conversation_starters: { type: [String], default: [] },
    tools: { type: [String], default: [] },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    model_parameters: { type: Schema.Types.Mixed, default: undefined },
    allTenants: { type: Boolean, default: false },
    tenantIds: { type: [String], default: [] },
    disabledTenants: { type: [String], default: [] },
  },
  { timestamps: true },
);

function toAgent(doc: PlatformAgentDoc): PlatformAgent {
  return {
    platformAgentId: doc.platformAgentId,
    name: doc.name,
    description: doc.description ?? '',
    instructions: doc.instructions ?? '',
    conversation_starters: [...(doc.conversation_starters ?? [])],
    tools: [...(doc.tools ?? [])],
    provider: doc.provider,
    model: doc.model,
    ...(doc.model_parameters && { model_parameters: { ...doc.model_parameters } }),
    tenants: doc.allTenants ? 'all' : [...(doc.tenantIds ?? [])],
    disabledTenants: [...(doc.disabledTenants ?? [])],
    ...(doc.updatedAt && { updatedAt: doc.updatedAt }),
  };
}

/** The MCP servers a tool list uses, as upstream indexes them (`mcpServerNames`). */
function mcpServerNames(tools: string[]): string[] {
  const names = new Set<string>();
  for (const tool of tools) {
    const parts = tool.split(Constants.mcp_delimiter);
    if (parts.length >= 2) names.add(parts[parts.length - 1]);
  }
  return [...names];
}

export function createPlatformAgentMethods(
  mongoose: typeof import('mongoose'),
): PlatformAgentMethods {
  const Definition: Model<PlatformAgentDoc> =
    mongoose.models.PlatformAgent ||
    mongoose.model<PlatformAgentDoc>('PlatformAgent', platformAgentSchema);
  const { findRoleByIdentifier } = createAccessRoleMethods(mongoose);
  const agents = () => mongoose.models.Agent as Model<IAgent>;
  const aclEntries = () => mongoose.models.AclEntry as Model<IAclEntry>;

  /** Queries also name the tenant, so they hold without strict isolation too. */
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    tenantStorage.run({ ...tenantStorage.getStore(), tenantId }, fn);

  const copyProjection = { tenantId: 1, platformAgentId: 1, id: 1, updatedAt: 1 };
  const toCopy = (doc: CopyDoc): PlatformAgentCopy => ({
    tenantId: doc.tenantId ?? '',
    platformAgentId: doc.platformAgentId ?? '',
    agentId: doc.id,
    ...(doc.updatedAt && { updatedAt: doc.updatedAt }),
  });

  return {
    async listPlatformAgents() {
      const docs = await Definition.find({}).sort({ name: 1 }).lean<PlatformAgentDoc[]>();
      return docs.map(toAgent);
    },

    async getPlatformAgent(platformAgentId) {
      const doc = await Definition.findOne({ platformAgentId }).lean<PlatformAgentDoc>();
      return doc ? toAgent(doc) : null;
    },

    async upsertPlatformAgent(input) {
      const { platformAgentId, tenants, model_parameters, ...fields } = input;
      const doc = await Definition.findOneAndUpdate(
        { platformAgentId },
        {
          $set: {
            ...fields,
            platformAgentId,
            allTenants: tenants === 'all',
            tenantIds: tenants === 'all' ? [] : [...new Set(tenants)],
            ...(model_parameters && { model_parameters }),
          },
          ...(!model_parameters && { $unset: { model_parameters: 1 } }),
          $setOnInsert: { disabledTenants: [] },
        },
        { upsert: true, new: true, runValidators: true },
      ).lean<PlatformAgentDoc>();
      return toAgent(doc as PlatformAgentDoc);
    },

    async deletePlatformAgent(platformAgentId) {
      const { deletedCount } = await Definition.deleteOne({ platformAgentId });
      return deletedCount > 0;
    },

    async platformAgentsUsingProvider(provider) {
      const docs = await Definition.find({ provider }, { platformAgentId: 1 })
        .sort({ platformAgentId: 1 })
        .lean<Array<Pick<PlatformAgentDoc, 'platformAgentId'>>>();
      return docs.map((doc) => doc.platformAgentId);
    },

    async setPlatformAgentEnabled(platformAgentId, tenantId, enabled) {
      const doc = await Definition.findOneAndUpdate(
        { platformAgentId },
        enabled
          ? { $pull: { disabledTenants: tenantId } }
          : { $addToSet: { disabledTenants: tenantId } },
        { new: true },
      ).lean<PlatformAgentDoc>();
      return doc ? toAgent(doc) : null;
    },

    async listPlatformAgentCopies(platformAgentId) {
      const docs = await runAsSystem(
        async () => await agents().find({ platformAgentId }, copyProjection).lean<CopyDoc[]>(),
      );
      return docs.map(toCopy);
    },

    async listTenantPlatformAgentCopies(tenantId) {
      const docs = await inTenant(
        tenantId,
        async () =>
          await agents()
            .find({ tenantId, platformAgentId: { $exists: true } }, copyProjection)
            .lean<CopyDoc[]>(),
      );
      return docs.map(toCopy);
    },

    async writePlatformAgentCopy(tenantId, agent) {
      await inTenant(tenantId, async () => {
        const id = platformAgentCopyId(agent.platformAgentId);
        const now = new Date();
        const fields = {
          name: agent.name,
          description: agent.description,
          instructions: agent.instructions,
          conversation_starters: agent.conversation_starters,
          tools: agent.tools,
          provider: agent.provider,
          model: agent.model,
          model_parameters: agent.model_parameters ?? {},
          mcpServerNames: mcpServerNames(agent.tools),
        };
        const copy = await agents()
          .findOneAndUpdate(
            { id, tenantId, platformAgentId: agent.platformAgentId },
            {
              $set: { ...fields, versions: [{ ...fields, createdAt: now, updatedAt: now }] },
              $setOnInsert: {
                tenantId,
                author: PLATFORM_AGENT_AUTHOR,
                category: 'general',
              },
            },
            { upsert: true, new: true },
          )
          .lean<IAgent>();
        if (!copy) return;
        const viewer = await findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
        await aclEntries().findOneAndUpdate(
          {
            principalType: PrincipalType.PUBLIC,
            resourceType: ResourceType.AGENT,
            resourceId: copy._id,
          },
          {
            $set: {
              permBits: viewer?.permBits ?? PermissionBits.VIEW,
              grantedAt: now,
              ...(viewer?._id && { roleId: viewer._id }),
            },
          },
          { upsert: true },
        );
      });
    },

    async removePlatformAgentCopy(tenantId, platformAgentId) {
      return await inTenant(tenantId, async () => {
        const copy = await agents()
          .findOneAndDelete({ id: platformAgentCopyId(platformAgentId), tenantId, platformAgentId })
          .lean<IAgent>();
        if (!copy) return false;
        await aclEntries().deleteMany({
          resourceType: { $in: [ResourceType.AGENT, ResourceType.REMOTE_AGENT] },
          resourceId: copy._id,
        });
        return true;
      });
    },
  };
}
