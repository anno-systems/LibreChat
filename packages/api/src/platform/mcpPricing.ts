import { z } from 'zod';
import { logger, FREE_MCP_SERVERS } from '@librechat/data-schemas';
import type {
  McpServerPrice,
  McpSubscription,
  McpPriceResult,
  PricingCurrency,
} from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { McpSubscriptionView } from '~/admin/subscriptions';
import type { RecordAuditEntry } from '~/admin/audit';
import { latestPerServer, toSubscriptionView } from '~/admin/subscriptions';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createOperatorAudit } from './handlers';

/**
 * Monthly prices of the platform's MCP servers (fork-only), on the operator API
 * (`PLATFORM_API_TOKEN`). A price is per tenant and month, in the display currency; `support` is
 * always free. Tenants pay what they agreed to: a changed price applies to new subscriptions only,
 * and making a server free ends the running ones (their month stays charged).
 *
 *   GET    /api/platform/mcp-pricing           the servers with their prices, and per tenant
 *                                              what is subscribed (running, or charged this month)
 *   PUT    /api/platform/mcp-pricing/:server   `{ monthlyPrice }`; 0 makes the server free
 *   DELETE /api/platform/mcp-pricing/:server   the server is free again
 */

const SERVER = /^[A-Za-z0-9_-]{1,64}$/;

const priceSchema = z.object({ monthlyPrice: z.number().min(0).max(100_000) }).strict();

/** The MCP servers a `librechat.yaml` config defines, with their titles, in its order. */
export function listConfiguredMcpServers(
  mcpConfig: Record<string, unknown> | null | undefined,
): { name: string; title?: string }[] {
  return Object.entries(mcpConfig ?? {})
    .filter(([name]) => SERVER.test(name))
    .map(([name, value]) => {
      const title = (value as { title?: unknown } | null)?.title;
      return { name, ...(typeof title === 'string' && title && { title }) };
    });
}

export interface McpPricingStore {
  listMcpServerPrices(): Promise<McpServerPrice[]>;
  setMcpServerPrice(price: Omit<McpServerPrice, 'updatedAt'>): Promise<McpPriceResult>;
  deleteMcpServerPrice(server: string): Promise<{ removed: boolean; ended: McpSubscription[] }>;
  listMcpSubscriptions(tenantId?: string): Promise<McpSubscription[]>;
}

export interface McpPricingHandlerDeps {
  store: McpPricingStore;
  /** The platform's MCP servers (`librechat.yaml`), with their titles. */
  listServers: () => Promise<{ name: string; title?: string }[]>;
  /** The platform's display currency, which prices are set in. */
  resolvePricing: () => { currency?: PricingCurrency };
  recordAuditEntry?: RecordAuditEntry;
  auditFailClosed?: boolean;
  now?: () => Date;
}

type OperatorHandler = (req: Request, res: Response) => Promise<Response>;

export interface McpPricingHandlers {
  getMcpPricing: OperatorHandler;
  putMcpPrice: OperatorHandler;
  deleteMcpPrice: OperatorHandler;
}

export function createMcpPricingHandlers(deps: McpPricingHandlerDeps): McpPricingHandlers {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const audit = createOperatorAudit({
    recordAuditEntry: deps.recordAuditEntry,
    auditFailClosed: deps.auditFailClosed,
    logPrefix: '[platformMcpPricing]',
  });

  const fail = (res: Response, label: string, error: unknown) => {
    logger.error(`[platformMcpPricing] ${label} failed`, getSafeErrorMetadata(error));
    return res.status(500).json({ error: 'internal_error' });
  };

  const serverOf = (req: Request) => {
    const server = String(req.params.server ?? '');
    return SERVER.test(server) ? server : undefined;
  };

  /** Ends are recorded in each tenant's own chain, as the operator. */
  const recordEnded = async (req: Request, ended: McpSubscription[]) => {
    for (const subscription of ended) {
      await audit(req, {
        action: 'mcp_server.unsubscribed',
        outcome: 'success',
        severity: 'info',
        tenantId: subscription.tenantId,
        target: { type: 'mcp_server', id: subscription.server, name: subscription.server },
        metadata: {
          price: subscription.price,
          currency: subscription.currency,
          reason: 'price_removed',
        },
      });
    }
  };

  const makeFree = async (req: Request, server: string) => {
    const result = await store.deleteMcpServerPrice(server);
    await recordEnded(req, result.ended);
    logger.info('[platformMcpPricing] server made free', {
      server,
      endedSubscriptions: result.ended.length,
    });
    return result;
  };

  return {
    async getMcpPricing(_req, res) {
      try {
        const [servers, prices, subscriptions] = await Promise.all([
          deps.listServers(),
          store.listMcpServerPrices(),
          store.listMcpSubscriptions(),
        ]);
        const at = now();
        const byServer = new Map(prices.map((p) => [p.server, p]));
        const byTenant = new Map<string, McpSubscription[]>();
        for (const subscription of subscriptions) {
          const list = byTenant.get(subscription.tenantId) ?? [];
          list.push(subscription);
          byTenant.set(subscription.tenantId, list);
        }
        const current: (McpSubscriptionView & { tenantId: string })[] = [];
        for (const [tenantId, list] of byTenant) {
          for (const subscription of latestPerServer(list)) {
            const view = toSubscriptionView(subscription, at);
            if (view.active || view.chargedThisMonth) current.push({ tenantId, ...view });
          }
        }
        const subscribers = (server: string) =>
          current.filter((s) => s.server === server && s.active).length;
        /** The deployment's servers in their order, then priced ones it no longer defines. */
        const listed = new Map<string, { name: string; title?: string }>(
          servers.map((s) => [s.name, s]),
        );
        for (const price of prices) {
          if (!listed.has(price.server)) listed.set(price.server, { name: price.server });
        }
        const { currency } = deps.resolvePricing();
        return res.json({
          ...(currency && { currency: currency.code }),
          servers: [...listed.values()].map(({ name, title }) => {
            const price = byServer.get(name);
            return {
              name,
              ...(title && { title }),
              ...(FREE_MCP_SERVERS.has(name)
                ? { alwaysFree: true }
                : price && { monthlyPrice: price.monthlyPrice, currency: price.currency }),
              subscribers: subscribers(name),
            };
          }),
          subscriptions: current,
        });
      } catch (error) {
        return fail(res, 'list', error);
      }
    },

    async putMcpPrice(req, res) {
      try {
        const server = serverOf(req);
        const parsed = priceSchema.safeParse(req.body);
        if (!server || !parsed.success) {
          return res.status(400).json({ error: 'invalid_price' });
        }
        if (FREE_MCP_SERVERS.has(server)) {
          return res.status(400).json({ error: 'server_always_free' });
        }
        const known = await deps.listServers();
        if (!known.some((s) => s.name === server)) {
          return res.status(404).json({ error: 'unknown_server' });
        }
        const { monthlyPrice } = parsed.data;
        if (monthlyPrice === 0) {
          const { ended } = await makeFree(req, server);
          return res.json({ price: null, endedSubscriptions: ended.length });
        }
        const { currency } = deps.resolvePricing();
        if (!currency) {
          return res.status(409).json({ error: 'currency_required' });
        }
        const result = await store.setMcpServerPrice({
          server,
          monthlyPrice,
          currency: currency.code,
        });
        if (!result.ok) {
          return res.status(400).json({ error: 'server_always_free' });
        }
        logger.info('[platformMcpPricing] price saved', {
          server,
          monthlyPrice,
          currency: currency.code,
        });
        const { updatedAt: _updatedAt, ...price } = result.value;
        return res.json({ price });
      } catch (error) {
        return fail(res, 'put', error);
      }
    },

    async deleteMcpPrice(req, res) {
      try {
        const server = serverOf(req);
        if (!server) return res.status(400).json({ error: 'invalid_price' });
        const { removed, ended } = await makeFree(req, server);
        if (!removed && ended.length === 0) {
          return res.status(404).json({ error: 'not_found' });
        }
        return res.json({ endedSubscriptions: ended.length });
      } catch (error) {
        return fail(res, 'delete', error);
      }
    },
  };
}
