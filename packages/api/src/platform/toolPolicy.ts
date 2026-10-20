import { z } from 'zod';
import { logger } from '@librechat/data-schemas';
import { Constants, PrincipalType } from 'librechat-data-provider';
import type {
  McpToolMode,
  McpToolPolicyMethods,
  McpToolPolicyRule,
  PlatformMcpTool,
} from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { ToolApprovalHookFactory } from '~/agents/hitl/hooks';
import type { RecordAuditEntry } from '~/admin/audit';
import type { ServerRequest } from '~/types/http';
import { createAdminAuditEmitter } from '~/admin/audit';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * Per-tool access policy of the platform's MCP servers (fork-only).
 *
 * A tenant admin sets, per tool, a mode for the whole tenant and for groups: `off`, `allow`, or
 * `confirm` (allowed after the user approves the call in the chat). For one user the mode is:
 *
 * 1. the most permissive mode of the rules of the user's groups (`allow` > `confirm` > `off`),
 * 2. else the tenant-wide rule,
 * 3. else `allow` for read-only tools and `confirm` for all others.
 *
 * LibreChat applies it through a tool approval hook (`off` denies, `confirm` asks), and the MCP
 * servers apply it again on their side through the platform MCP API, so neither the model nor a
 * caller that skips LibreChat can run a tool the admin switched off.
 */

export type ToolModes = Record<string, McpToolMode>;

const RANK: Record<McpToolMode, number> = { off: 0, confirm: 1, allow: 2 };

export function defaultToolMode(tool: Pick<PlatformMcpTool, 'readOnly'> | undefined): McpToolMode {
  return tool?.readOnly ? 'allow' : 'confirm';
}

/** The mode of one tool for a member of `groupIds`, from the rules of the tool's server. */
export function resolveToolMode(
  tool: PlatformMcpTool,
  rules: McpToolPolicyRule[],
  groupIds: ReadonlySet<string>,
): McpToolMode {
  let fromGroups: McpToolMode | undefined;
  let fromTenant: McpToolMode | undefined;
  for (const rule of rules) {
    if (rule.tool !== tool.name) continue;
    if (rule.principalType === 'tenant') {
      fromTenant = rule.mode;
    } else if (groupIds.has(rule.principalId)) {
      if (!fromGroups || RANK[rule.mode] > RANK[fromGroups]) fromGroups = rule.mode;
    }
  }
  return fromGroups ?? fromTenant ?? defaultToolMode(tool);
}

export interface ToolPolicyResolverDeps {
  policy: Pick<McpToolPolicyMethods, 'listPlatformMcpTools' | 'findMcpToolPolicies'>;
  /** The ids of the groups the user is a member of. */
  getUserGroupIds(userId: string): Promise<string[]>;
}

export interface ToolPolicyResolver {
  /** The modes of a platform server's tools for one user; null when no such server registered. */
  modesFor(input: { tenantId: string; userId: string; server: string }): Promise<ToolModes | null>;
}

export function createToolPolicyResolver(deps: ToolPolicyResolverDeps): ToolPolicyResolver {
  return {
    async modesFor({ tenantId, userId, server }) {
      const tools = await deps.policy.listPlatformMcpTools(server);
      if (tools.length === 0) return null;
      const groupIds = await deps.getUserGroupIds(userId);
      const rules = await deps.policy.findMcpToolPolicies(tenantId, server, groupIds);
      const members = new Set(groupIds);
      return Object.fromEntries(
        tools.map((tool) => [tool.name, resolveToolMode(tool, rules, members)]),
      );
    },
  };
}

/** Splits LibreChat's MCP tool name `<tool>_mcp_<server>`. */
export function parseMcpToolName(name: string): { tool: string; server: string } | null {
  const at = name.lastIndexOf(Constants.mcp_delimiter);
  if (at <= 0) return null;
  const server = name.slice(at + Constants.mcp_delimiter.length);
  return server ? { tool: name.slice(0, at), server } : null;
}

/**
 * The tool approval hook: denies tools that are off for the user and asks before tools that need
 * confirmation. Tools of servers that never registered with the platform are left alone. The
 * modes of a server are read once per run.
 */
export function createToolPolicyHookFactory(resolver: ToolPolicyResolver): ToolApprovalHookFactory {
  return ({ userId, tenantId }) => {
    if (!userId || !tenantId) return undefined;
    const servers = new Map<string, Promise<ToolModes | null>>();
    return async (input) => {
      const parsed = parseMcpToolName(input.toolName);
      if (!parsed) return {};
      let modes = servers.get(parsed.server);
      if (!modes) {
        modes = resolver.modesFor({ tenantId, userId, server: parsed.server });
        servers.set(parsed.server, modes);
      }
      let resolved: ToolModes | null;
      try {
        resolved = await modes;
      } catch (error) {
        servers.delete(parsed.server);
        logger.error('[toolPolicy] reading the tool policy failed', getSafeErrorMetadata(error));
        return { decision: 'deny', reason: 'The tool policy could not be read.' };
      }
      if (!resolved) return {};
      const mode = resolved[parsed.tool] ?? 'confirm';
      if (mode === 'off') {
        return { decision: 'deny', reason: 'Your organization has switched this tool off.' };
      }
      if (mode === 'confirm') {
        return {
          decision: 'ask',
          reason: 'Your organization asks you to confirm this action.',
          allowedDecisions: ['approve', 'reject', 'edit'],
        };
      }
      return {};
    };
  };
}

/* HTTP handlers */

const SERVER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const OBJECT_ID = /^[a-f0-9]{24}$/;
const MAX_TOOLS = 200;

const toolsInputSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            name: z.string().regex(TOOL),
            title: z.string().trim().max(128).optional(),
            description: z.string().trim().max(1024).optional(),
            readOnly: z.boolean().optional(),
          })
          .strict(),
      )
      .max(MAX_TOOLS),
  })
  .strict();

const policyInputSchema = z
  .object({
    server: z.string().regex(SERVER),
    tool: z.string().regex(TOOL),
    principalType: z.enum(['tenant', 'group']),
    principalId: z.string().optional(),
    /** Null removes the rule. */
    mode: z.enum(['off', 'allow', 'confirm']).nullable(),
  })
  .strict();

export interface ToolPolicyHandlerDeps {
  policy: Pick<
    McpToolPolicyMethods,
    | 'setPlatformMcpTools'
    | 'listPlatformMcpTools'
    | 'listMcpToolPolicies'
    | 'setMcpToolPolicy'
    | 'deleteMcpToolPolicy'
  >;
  resolver: ToolPolicyResolver;
  /** The id of the tenant's user with this OpenID subject, or null. */
  findUserIdByOpenId(tenantId: string, subject: string): Promise<string | null>;
  /** Whether the group exists in the caller's tenant. */
  groupExists(groupId: string): Promise<boolean>;
  recordAuditEntry?: RecordAuditEntry;
  auditFailClosed?: boolean;
}

type PlatformHandler = (req: Request, res: Response) => Promise<Response>;
type AdminHandler = (req: ServerRequest, res: Response) => Promise<Response>;

export interface ToolPolicyHandlers {
  /** PUT /api/platform/mcp/servers/:server/tools (an MCP server registers its tools) */
  registerTools: PlatformHandler;
  /** GET /api/platform/mcp/servers/:server/policy?tenantId=&subject= */
  getUserModes: PlatformHandler;
  /** GET /api/admin/mcp-tools */
  getPolicy: AdminHandler;
  /** PUT /api/admin/mcp-tools/policy */
  putRule: AdminHandler;
}

export function createToolPolicyHandlers(deps: ToolPolicyHandlerDeps): ToolPolicyHandlers {
  const { policy } = deps;
  const emitAdminAudit = createAdminAuditEmitter({
    recordAuditEntry: deps.recordAuditEntry,
    failClosed: deps.auditFailClosed,
    logPrefix: '[toolPolicy]',
  });

  function fail(res: Response, label: string, error: unknown): Response {
    logger.error(`[toolPolicy] ${label} failed`, getSafeErrorMetadata(error));
    return res.status(500).json({ error: 'Internal server error' });
  }

  const serverParam = (req: Request) => String((req.params as { server?: string }).server ?? '');

  return {
    async registerTools(req, res) {
      try {
        const server = serverParam(req);
        const parsed = toolsInputSchema.safeParse(req.body);
        if (!SERVER.test(server) || !parsed.success) {
          return res.status(400).json({ error: 'invalid_tools' });
        }
        const names = parsed.data.tools.map((tool) => tool.name);
        if (new Set(names).size !== names.length) {
          return res.status(400).json({ error: 'invalid_tools' });
        }
        await policy.setPlatformMcpTools(
          server,
          parsed.data.tools.map((tool) => ({ ...tool, readOnly: tool.readOnly === true })),
        );
        return res.status(204).end();
      } catch (error) {
        return fail(res, 'tool registration', error);
      }
    },

    async getUserModes(req, res) {
      try {
        const server = serverParam(req);
        const tenantId = String(req.query.tenantId ?? '');
        const subject = String(req.query.subject ?? '');
        if (
          !SERVER.test(server) ||
          !TENANT_ID.test(tenantId) ||
          tenantId === '__SYSTEM__' ||
          !subject ||
          subject.length > 256
        ) {
          return res.status(400).json({ error: 'invalid_request' });
        }
        const userId = await deps.findUserIdByOpenId(tenantId, subject);
        if (!userId) return res.status(404).json({ error: 'user_unknown' });
        const modes = await deps.resolver.modesFor({ tenantId, userId, server });
        if (!modes) return res.status(404).json({ error: 'server_unknown' });
        return res.json({ modes });
      } catch (error) {
        return fail(res, 'mode lookup', error);
      }
    },

    async getPolicy(req, res) {
      try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) return res.status(403).json({ error: 'tenant_required' });
        const [tools, rules] = await Promise.all([
          policy.listPlatformMcpTools(),
          policy.listMcpToolPolicies(tenantId),
        ]);
        return res.json({
          tools: tools.map((tool) => ({ ...tool, defaultMode: defaultToolMode(tool) })),
          rules,
        });
      } catch (error) {
        return fail(res, 'policy read', error);
      }
    },

    async putRule(req, res) {
      try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) return res.status(403).json({ error: 'tenant_required' });
        const parsed = policyInputSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'invalid_rule' });
        const { server, tool, principalType, mode } = parsed.data;
        const principalId = principalType === 'tenant' ? '' : (parsed.data.principalId ?? '');
        if (principalType === 'group' && !OBJECT_ID.test(principalId)) {
          return res.status(400).json({ error: 'invalid_rule' });
        }
        const known = await policy.listPlatformMcpTools(server);
        if (!known.some((t) => t.name === tool)) {
          return res.status(404).json({ error: 'tool_unknown' });
        }
        if (principalType === 'group' && !(await deps.groupExists(principalId))) {
          return res.status(404).json({ error: 'group_unknown' });
        }
        const key = { server, tool, principalType, principalId };
        if (mode === null) {
          await policy.deleteMcpToolPolicy(tenantId, key);
        } else {
          await policy.setMcpToolPolicy(tenantId, { ...key, mode });
        }
        await emitAdminAudit(req, {
          action: 'mcp_tool.policy_updated',
          outcome: 'success',
          severity: 'info',
          target: { type: 'mcp_tool', id: `${server}/${tool}` },
          metadata: { principalType, principalId, mode: mode ?? 'default' },
        });
        return res.json({ rule: mode === null ? null : { ...key, mode } });
      } catch (error) {
        return fail(res, 'policy update', error);
      }
    },
  };
}

/** The ids of a user's groups, from upstream's principal lookup. */
export function groupIdsFromPrincipals(
  principals: Array<{ principalType: string; principalId?: unknown }>,
): string[] {
  return principals
    .filter((p) => p.principalType === PrincipalType.GROUP && p.principalId != null)
    .map((p) => String(p.principalId));
}
