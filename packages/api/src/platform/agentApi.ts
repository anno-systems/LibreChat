import { z } from 'zod';
import { Constants } from 'librechat-data-provider';
import { logger, platformAgentCopyId } from '@librechat/data-schemas';
import type {
  PlatformAgent,
  PlatformMcpTool,
  PlatformProvider,
  PlatformAgentInput,
  PlatformAgentMethods,
} from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { RecordAuditEntry } from '~/admin/audit';
import type { PlatformAgentService } from './agents';
import type { ServerRequest } from '~/types/http';
import { createAdminAuditEmitter } from '~/admin/audit';
import { getSafeErrorMetadata } from '~/utils/errors';
import { isActiveFor, targetsTenant } from './agents';
import { createOperatorAudit } from './handlers';
import { hasModel } from './models';

/**
 * HTTP handlers of platform agents (fork-only, see `agents.ts`).
 *
 * - The operator API (`/api/platform/agents`, `PLATFORM_API_TOKEN`) lists, saves and deletes the
 *   definitions. A definition runs on a model of a platform provider, which is checked here.
 * - The tenant admin API (`/api/admin/platform-agents`) lists the platform agents meant for the
 *   caller's tenant and switches one on or off for it; nothing else about them can be changed
 *   by a tenant.
 */

export interface PlatformAgentHandlerDeps {
  service: PlatformAgentService;
  store: Pick<
    PlatformAgentMethods,
    | 'listPlatformAgents'
    | 'getPlatformAgent'
    | 'upsertPlatformAgent'
    | 'deletePlatformAgent'
    | 'setPlatformAgentEnabled'
    | 'listPlatformAgentCopies'
    | 'writePlatformAgentCopy'
    | 'removePlatformAgentCopy'
  >;
  findPlatformProviders(names: string[]): Promise<PlatformProvider[]>;
  /** The tools the platform's MCP servers registered (`/api/platform/mcp`). */
  listPlatformMcpTools(): Promise<PlatformMcpTool[]>;
  recordAuditEntry?: RecordAuditEntry;
  auditFailClosed?: boolean;
}

type OperatorHandler = (req: Request, res: Response) => Promise<Response>;
type AdminHandler = (req: ServerRequest, res: Response) => Promise<Response>;

export interface PlatformAgentHandlers {
  listAgents: OperatorHandler;
  listTools: OperatorHandler;
  putAgent: OperatorHandler;
  deleteAgent: OperatorHandler;
  listTenantAgents: AdminHandler;
  putTenantAgent: AdminHandler;
}

const PLATFORM_AGENT_ID = /^platform_[a-z0-9][a-z0-9-]{0,47}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const TOOL_ID = /^[\w.:-]{1,300}$/;
const PARAMETER = /^[a-z][a-zA-Z0-9_]{0,63}$/;

const unique = <T>(values: T[]) => [...new Set(values)];

const agentInputSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    description: z.string().trim().max(2000).default(''),
    instructions: z.string().max(100_000).default(''),
    conversation_starters: z
      .array(z.string().trim().min(1).max(1000))
      .max(Constants.MAX_CONVO_STARTERS)
      .default([]),
    tools: z.array(z.string().regex(TOOL_ID)).max(200).default([]).transform(unique),
    provider: z.string().regex(PROVIDER),
    model: z.string().trim().min(1).max(128),
    /** Sampling settings such as `temperature`; the model is the definition's own. */
    model_parameters: z
      .record(z.string().regex(PARAMETER), z.union([z.number(), z.boolean(), z.string().max(200)]))
      .refine((params) => Object.keys(params).length <= 20 && !('model' in params))
      .optional(),
    tenants: z.union([
      z.literal('all'),
      z.array(z.string().regex(TENANT_ID)).min(1).max(500).transform(unique),
    ]),
  })
  .strict();

const toggleSchema = z.object({ enabled: z.boolean() }).strict();

function operatorView(agent: PlatformAgent, activeTenants?: string[]) {
  return {
    platformAgentId: agent.platformAgentId,
    agentId: platformAgentCopyId(agent.platformAgentId),
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    conversation_starters: agent.conversation_starters,
    tools: agent.tools,
    provider: agent.provider,
    model: agent.model,
    ...(agent.model_parameters && { model_parameters: agent.model_parameters }),
    tenants: agent.tenants,
    disabledTenants: agent.disabledTenants,
    ...(activeTenants && { activeTenants }),
    ...(agent.updatedAt && { updatedAt: agent.updatedAt }),
  };
}

/** What a tenant admin sees: the agent as its users get it, and whether it is on. */
function tenantView(agent: PlatformAgent, tenantId: string) {
  return {
    platformAgentId: agent.platformAgentId,
    agentId: platformAgentCopyId(agent.platformAgentId),
    name: agent.name,
    description: agent.description,
    conversation_starters: agent.conversation_starters,
    tools: agent.tools,
    provider: agent.provider,
    model: agent.model,
    enabled: isActiveFor(agent, tenantId),
  };
}

export function createPlatformAgentHandlers(deps: PlatformAgentHandlerDeps): PlatformAgentHandlers {
  const { service, store } = deps;
  const auditOperator = createOperatorAudit({
    recordAuditEntry: deps.recordAuditEntry,
    auditFailClosed: deps.auditFailClosed,
    logPrefix: '[platformAgents]',
  });
  const emitAdminAudit = createAdminAuditEmitter({
    recordAuditEntry: deps.recordAuditEntry,
    failClosed: deps.auditFailClosed,
    logPrefix: '[platformAgents]',
  });

  function fail(res: Response, label: string, error: unknown): Response {
    logger.error(`[platformAgents] ${label} failed`, getSafeErrorMetadata(error));
    return res.status(500).json({ error: 'Internal server error' });
  }

  const idOf = (req: Request | ServerRequest): string | null => {
    const id = String((req.params as { id?: string }).id ?? '');
    return PLATFORM_AGENT_ID.test(id) ? id : null;
  };

  /** Writes the copies; a failure is logged and repaired by the tenants' next sync. */
  async function syncCopies(platformAgentId: string): Promise<boolean> {
    try {
      await service.sync(platformAgentId);
      return true;
    } catch (error) {
      logger.warn('[platformAgents] copies not synced', {
        platformAgentId,
        ...getSafeErrorMetadata(error),
      });
      return false;
    }
  }

  /** GET /api/platform/agents: every definition, with the tenants that hold a copy. */
  async function listAgents(_req: Request, res: Response) {
    try {
      const agents = await store.listPlatformAgents();
      const copies = await Promise.all(
        agents.map((agent) => store.listPlatformAgentCopies(agent.platformAgentId)),
      );
      return res.json({
        agents: agents.map((agent, i) =>
          operatorView(agent, copies[i].map((copy) => copy.tenantId).sort()),
        ),
      });
    } catch (error) {
      return fail(res, 'agent list', error);
    }
  }

  /**
   * GET /api/platform/agents/tools: the platform MCP servers' tools by agent tool id
   * (`<tool>_mcp_<server>`), for the operator to choose from.
   */
  async function listTools(_req: Request, res: Response) {
    try {
      const servers = new Map<string, Array<{ id: string; name: string; description?: string }>>();
      for (const tool of await deps.listPlatformMcpTools()) {
        const tools = servers.get(tool.server) ?? [];
        tools.push({
          id: `${tool.name}${Constants.mcp_delimiter}${tool.server}`,
          name: tool.title || tool.name,
          ...(tool.description && { description: tool.description }),
        });
        servers.set(tool.server, tools);
      }
      return res.json({
        servers: [...servers].map(([name, tools]) => ({
          name,
          marker: `${Constants.mcp_server}${Constants.mcp_delimiter}${name}`,
          tools,
        })),
      });
    } catch (error) {
      return fail(res, 'tool list', error);
    }
  }

  /** PUT /api/platform/agents/:id: creates or replaces a definition and updates its copies. */
  async function putAgent(req: Request, res: Response) {
    try {
      const platformAgentId = idOf(req);
      const parsed = agentInputSchema.safeParse(req.body);
      if (!platformAgentId || !parsed.success) {
        return res.status(400).json({ error: 'invalid_platform_agent' });
      }
      const input: PlatformAgentInput = { platformAgentId, ...parsed.data };
      const [provider] = await deps.findPlatformProviders([input.provider]);
      if (!provider || !hasModel(provider, input.model)) {
        return res.status(400).json({ error: 'unknown_provider_or_model' });
      }
      const existing = await store.getPlatformAgent(platformAgentId);
      const saved = await store.upsertPlatformAgent(input);
      const synced = await syncCopies(platformAgentId);
      await auditOperator(req, {
        action: 'catalog.agent_updated',
        outcome: 'success',
        severity: 'info',
        tenantId: undefined,
        target: { type: 'agent', id: platformAgentId, name: saved.name },
        metadata: {
          created: !existing,
          provider: saved.provider,
          model: saved.model,
          tenants: saved.tenants === 'all' ? 'all' : saved.tenants.length,
          tools: saved.tools.length,
          synced,
        },
      });
      return res.status(existing ? 200 : 201).json({ agent: operatorView(saved), synced });
    } catch (error) {
      return fail(res, 'agent update', error);
    }
  }

  /** DELETE /api/platform/agents/:id: the definition and every tenant's copy. */
  async function deleteAgent(req: Request, res: Response) {
    try {
      const platformAgentId = idOf(req);
      if (!platformAgentId || !(await store.deletePlatformAgent(platformAgentId))) {
        return res.status(404).json({ error: 'not_found' });
      }
      const synced = await syncCopies(platformAgentId);
      await auditOperator(req, {
        action: 'catalog.agent_deleted',
        outcome: 'success',
        severity: 'info',
        tenantId: undefined,
        target: { type: 'agent', id: platformAgentId },
        metadata: { synced },
      });
      return res.status(204).end();
    } catch (error) {
      return fail(res, 'agent delete', error);
    }
  }

  function callerTenant(req: ServerRequest, res: Response): string | null {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ error: 'tenant_required' });
      return null;
    }
    return tenantId;
  }

  /** GET /api/admin/platform-agents: the platform agents meant for the caller's tenant. */
  async function listTenantAgents(req: ServerRequest, res: Response) {
    try {
      const tenantId = callerTenant(req, res);
      if (!tenantId) return res;
      await service.ensureTenant(tenantId);
      const agents = (await store.listPlatformAgents()).filter((agent) =>
        targetsTenant(agent, tenantId),
      );
      return res.json({ agents: agents.map((agent) => tenantView(agent, tenantId)) });
    } catch (error) {
      return fail(res, 'tenant agent list', error);
    }
  }

  /** PUT /api/admin/platform-agents/:id with `{ enabled }`: on or off for the caller's tenant. */
  async function putTenantAgent(req: ServerRequest, res: Response) {
    try {
      const tenantId = callerTenant(req, res);
      if (!tenantId) return res;
      const platformAgentId = idOf(req);
      const parsed = toggleSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
      const current = platformAgentId ? await store.getPlatformAgent(platformAgentId) : null;
      if (!current || !targetsTenant(current, tenantId)) {
        return res.status(404).json({ error: 'not_found' });
      }
      const { enabled } = parsed.data;
      const updated = await store.setPlatformAgentEnabled(
        current.platformAgentId,
        tenantId,
        enabled,
      );
      if (!updated) return res.status(404).json({ error: 'not_found' });
      if (isActiveFor(updated, tenantId)) {
        await store.writePlatformAgentCopy(tenantId, updated);
      } else {
        await store.removePlatformAgentCopy(tenantId, updated.platformAgentId);
      }
      service.invalidate();
      await emitAdminAudit(req, {
        action: 'catalog.agent_toggled',
        outcome: 'success',
        severity: 'info',
        target: { type: 'agent', id: updated.platformAgentId, name: updated.name },
        metadata: { enabled },
      });
      return res.json({ agent: tenantView(updated, tenantId) });
    } catch (error) {
      return fail(res, 'tenant agent toggle', error);
    }
  }

  return { listAgents, listTools, putAgent, deleteAgent, listTenantAgents, putTenantAgent };
}
