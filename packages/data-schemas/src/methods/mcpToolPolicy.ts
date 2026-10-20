import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import { tenantStorage } from '~/config/tenantContext';

/**
 * Per-tool access policy for the platform's MCP servers (fork-only).
 *
 * - `PlatformMcpTool` is the platform-wide catalog of the tools each platform MCP server offers,
 *   registered by the servers themselves (no tenant).
 * - `McpToolPolicy` holds a tenant's rules: for one tool, the mode for the whole tenant or for
 *   one group (tenant-isolated).
 */

export type McpToolMode = 'off' | 'allow' | 'confirm';

export interface PlatformMcpTool {
  server: string;
  name: string;
  title?: string;
  description?: string;
  /** Tools that only read; they default to `allow`, all others to `confirm`. */
  readOnly: boolean;
}

export interface McpToolPolicyRule {
  server: string;
  tool: string;
  principalType: 'tenant' | 'group';
  /** The group's id; empty for the tenant-wide rule. */
  principalId: string;
  mode: McpToolMode;
}

export interface McpToolPolicyMethods {
  /** Replaces a server's registered tools with `tools`. */
  setPlatformMcpTools(server: string, tools: Omit<PlatformMcpTool, 'server'>[]): Promise<void>;
  /** Every registered tool, or one server's. */
  listPlatformMcpTools(server?: string): Promise<PlatformMcpTool[]>;
  /** A tenant's rules, or its rules for one server. */
  listMcpToolPolicies(tenantId: string, server?: string): Promise<McpToolPolicyRule[]>;
  /** The tenant-wide rules and the rules of `groupIds` for one server. */
  findMcpToolPolicies(
    tenantId: string,
    server: string,
    groupIds: string[],
  ): Promise<McpToolPolicyRule[]>;
  setMcpToolPolicy(tenantId: string, rule: McpToolPolicyRule): Promise<void>;
  /** False when there was no such rule. */
  deleteMcpToolPolicy(tenantId: string, rule: Omit<McpToolPolicyRule, 'mode'>): Promise<boolean>;
}

const MODES: McpToolMode[] = ['off', 'allow', 'confirm'];

const platformMcpToolSchema = new Schema<PlatformMcpTool>(
  {
    server: { type: String, required: true },
    name: { type: String, required: true },
    title: { type: String },
    description: { type: String },
    readOnly: { type: Boolean, default: false },
  },
  { timestamps: true },
);
platformMcpToolSchema.index({ server: 1, name: 1 }, { unique: true });

interface StoredRule extends McpToolPolicyRule {
  tenantId: string;
}

const mcpToolPolicySchema = new Schema<StoredRule>(
  {
    tenantId: { type: String, required: true },
    server: { type: String, required: true },
    tool: { type: String, required: true },
    principalType: { type: String, enum: ['tenant', 'group'], required: true },
    principalId: { type: String, default: '' },
    mode: { type: String, enum: MODES, required: true },
  },
  { timestamps: true },
);
mcpToolPolicySchema.index(
  { tenantId: 1, server: 1, tool: 1, principalType: 1, principalId: 1 },
  { unique: true },
);

function toTool(doc: PlatformMcpTool): PlatformMcpTool {
  return {
    server: doc.server,
    name: doc.name,
    ...(doc.title && { title: doc.title }),
    ...(doc.description && { description: doc.description }),
    readOnly: doc.readOnly === true,
  };
}

function toRule(doc: McpToolPolicyRule): McpToolPolicyRule {
  return {
    server: doc.server,
    tool: doc.tool,
    principalType: doc.principalType,
    principalId: doc.principalId ?? '',
    mode: doc.mode,
  };
}

export function createMcpToolPolicyMethods(
  mongoose: typeof import('mongoose'),
): McpToolPolicyMethods {
  applyTenantIsolation(mcpToolPolicySchema);
  const Tool: Model<PlatformMcpTool> =
    mongoose.models.PlatformMcpTool ||
    mongoose.model<PlatformMcpTool>('PlatformMcpTool', platformMcpToolSchema);
  const Policy: Model<StoredRule> =
    mongoose.models.McpToolPolicy ||
    mongoose.model<StoredRule>('McpToolPolicy', mcpToolPolicySchema);

  /** Queries also name the tenant, so they hold without strict isolation too. */
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    tenantStorage.run({ ...tenantStorage.getStore(), tenantId }, fn);

  const ruleKey = (tenantId: string, rule: Omit<McpToolPolicyRule, 'mode'>) => ({
    tenantId,
    server: rule.server,
    tool: rule.tool,
    principalType: rule.principalType,
    principalId: rule.principalType === 'tenant' ? '' : rule.principalId,
  });

  return {
    async setPlatformMcpTools(server, tools) {
      const names = tools.map((tool) => tool.name);
      await Promise.all(
        tools.map((tool) =>
          Tool.updateOne(
            { server, name: tool.name },
            {
              $set: {
                readOnly: tool.readOnly === true,
                title: tool.title ?? '',
                description: tool.description ?? '',
              },
            },
            { upsert: true },
          ),
        ),
      );
      await Tool.deleteMany({ server, name: { $nin: names } });
    },

    async listPlatformMcpTools(server) {
      const docs = await Tool.find(server ? { server } : {})
        .sort({ server: 1, name: 1 })
        .lean<PlatformMcpTool[]>();
      return docs.map(toTool);
    },

    listMcpToolPolicies(tenantId, server) {
      return inTenant(tenantId, async () => {
        const docs = await Policy.find({ tenantId, ...(server && { server }) })
          .sort({ server: 1, tool: 1, principalType: 1, principalId: 1 })
          .lean<StoredRule[]>();
        return docs.map(toRule);
      });
    },

    findMcpToolPolicies(tenantId, server, groupIds) {
      return inTenant(tenantId, async () => {
        const docs = await Policy.find({
          tenantId,
          server,
          $or: [
            { principalType: 'tenant' },
            { principalType: 'group', principalId: { $in: groupIds } },
          ],
        }).lean<StoredRule[]>();
        return docs.map(toRule);
      });
    },

    setMcpToolPolicy(tenantId, rule) {
      return inTenant(tenantId, async () => {
        const key = ruleKey(tenantId, rule);
        await Policy.updateOne(key, { $set: { ...key, mode: rule.mode } }, { upsert: true });
      });
    },

    deleteMcpToolPolicy(tenantId, rule) {
      return inTenant(tenantId, async () => {
        const { deletedCount } = await Policy.deleteOne(ruleKey(tenantId, rule));
        return deletedCount > 0;
      });
    },
  };
}
