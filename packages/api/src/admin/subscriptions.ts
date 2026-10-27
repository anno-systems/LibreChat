import { z } from 'zod';
import { logger, billingMonth, chargedMonths, FREE_MCP_SERVERS } from '@librechat/data-schemas';
import type { McpSubscribeResult, McpServerPrice, McpSubscription } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { RecordAuditEntry } from '~/admin/audit';
import type { ServerRequest } from '~/types/http';
import { createAdminAuditEmitter } from '~/admin/audit';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * Subscriptions to the platform's priced MCP servers (fork-only), for the tenant's admins:
 *
 *   GET    /api/admin/mcp-subscriptions           prices and the tenant's subscriptions
 *   PUT    /api/admin/mcp-subscriptions/:server   agree to the price shown (`{ monthlyPrice,
 *                                                 currency }`), or switch back on in a
 *                                                 charged month without it
 *   DELETE /api/admin/mcp-subscriptions/:server   end the subscription; the month stays charged
 *
 * A priced server is off for the tenant until it subscribes, whatever its config says. The
 * admin app subscribes when the admin switches the server on, and ends the subscription when
 * the admin switches it off.
 */

const SERVER = /^[A-Za-z0-9_-]{1,64}$/;

const consentSchema = z
  .object({
    monthlyPrice: z.number().min(0).max(100_000).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  })
  .strict();

/** A subscription as admins and the operator see it; never the acceptor's user id. */
export interface McpSubscriptionView {
  server: string;
  price: number;
  currency: string;
  acceptedAt: string;
  acceptedBy?: string;
  active: boolean;
  /** When the running or last period started. */
  since?: string;
  /** When the last period ended, while not active. */
  endedAt?: string;
  /** This month is charged already, so switching back on costs nothing extra. */
  chargedThisMonth: boolean;
}

export function toSubscriptionView(subscription: McpSubscription, now: Date): McpSubscriptionView {
  const last = subscription.periods[subscription.periods.length - 1];
  return {
    server: subscription.server,
    price: subscription.price,
    currency: subscription.currency,
    acceptedAt: subscription.acceptedAt.toISOString(),
    ...(subscription.acceptedBy.name && { acceptedBy: subscription.acceptedBy.name }),
    active: subscription.active,
    ...(last && { since: last.start.toISOString() }),
    ...(!subscription.active && last?.end && { endedAt: last.end.toISOString() }),
    chargedThisMonth: chargedMonths(subscription.periods, now).includes(billingMonth(now)),
  };
}

/** The tenant's latest subscription per server: the one that decides what it pays now. */
export function latestPerServer(subscriptions: McpSubscription[]): McpSubscription[] {
  const latest = new Map<string, McpSubscription>();
  for (const subscription of subscriptions) {
    const known = latest.get(subscription.server);
    if (!known || subscription.acceptedAt > known.acceptedAt) {
      latest.set(subscription.server, subscription);
    }
  }
  return [...latest.values()].sort((a, b) => a.server.localeCompare(b.server));
}

export interface McpSubscriptionStore {
  listMcpServerPrices(): Promise<McpServerPrice[]>;
  listMcpSubscriptions(tenantId?: string): Promise<McpSubscription[]>;
  subscribeMcpServer(input: {
    tenantId: string;
    server: string;
    consent?: { monthlyPrice: number; currency: string };
    acceptedBy: { id: string; name?: string };
  }): Promise<McpSubscribeResult>;
  unsubscribeMcpServer(input: {
    tenantId: string;
    server: string;
  }): Promise<McpSubscription | null>;
}

export interface McpSubscriptionHandlerDeps {
  store: McpSubscriptionStore;
  recordAuditEntry?: RecordAuditEntry;
  auditFailClosed?: boolean;
  now?: () => Date;
}

type AdminHandler = (req: ServerRequest, res: Response) => Promise<Response>;

export interface McpSubscriptionHandlers {
  listSubscriptions: AdminHandler;
  subscribe: AdminHandler;
  unsubscribe: AdminHandler;
}

const SUBSCRIBE_STATUS: Record<string, number> = {
  always_free: 400,
  consent_required: 400,
  not_priced: 404,
  price_changed: 409,
};

export function createMcpSubscriptionHandlers(
  deps: McpSubscriptionHandlerDeps,
): McpSubscriptionHandlers {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const emitAdminAudit = createAdminAuditEmitter({
    recordAuditEntry: deps.recordAuditEntry,
    failClosed: deps.auditFailClosed,
    logPrefix: '[mcpSubscriptions]',
  });

  const fail = (res: Response, label: string, error: unknown) => {
    logger.error(`[mcpSubscriptions] ${label} failed`, getSafeErrorMetadata(error));
    return res.status(500).json({ error: 'internal_error' });
  };

  const serverOf = (req: ServerRequest) => {
    const server = String((req.params as { server?: string }).server ?? '');
    return SERVER.test(server) ? server : undefined;
  };

  return {
    async listSubscriptions(req, res) {
      try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) return res.status(403).json({ error: 'tenant_required' });
        const [prices, subscriptions] = await Promise.all([
          store.listMcpServerPrices(),
          store.listMcpSubscriptions(tenantId),
        ]);
        const at = now();
        return res.json({
          prices: prices
            .filter((p) => p.monthlyPrice > 0 && !FREE_MCP_SERVERS.has(p.server))
            .map(({ server, monthlyPrice, currency }) => ({ server, monthlyPrice, currency })),
          subscriptions: latestPerServer(subscriptions).map((s) => toSubscriptionView(s, at)),
        });
      } catch (error) {
        return fail(res, 'list', error);
      }
    },

    async subscribe(req, res) {
      try {
        const tenantId = req.user?.tenantId;
        if (!tenantId || !req.user) return res.status(403).json({ error: 'tenant_required' });
        const server = serverOf(req);
        const parsed = consentSchema.safeParse(req.body ?? {});
        if (!server || !parsed.success) {
          return res.status(400).json({ error: 'invalid_subscription' });
        }
        const { monthlyPrice, currency } = parsed.data;
        if ((monthlyPrice === undefined) !== (currency === undefined)) {
          return res.status(400).json({ error: 'invalid_subscription' });
        }
        const userId = req.user._id?.toString() ?? req.user.id ?? '';
        const name = req.user.name || req.user.username || req.user.email;
        const result = await store.subscribeMcpServer({
          tenantId,
          server,
          ...(monthlyPrice !== undefined && currency && { consent: { monthlyPrice, currency } }),
          acceptedBy: { id: userId, ...(name && { name }) },
        });
        if (!result.ok) {
          const { code, price } = result.error;
          return res
            .status(SUBSCRIBE_STATUS[code] ?? 400)
            .json({ error: code, ...(price && { price }) });
        }
        const { subscription, change } = result.value;
        if (change !== 'unchanged') {
          await emitAdminAudit(req, {
            action: 'mcp_server.subscribed',
            outcome: 'success',
            severity: 'info',
            target: { type: 'mcp_server', id: server, name: server },
            metadata: {
              price: subscription.price,
              currency: subscription.currency,
              resumed: change === 'resumed',
            },
          });
        }
        return res.json({ subscription: toSubscriptionView(subscription, now()), change });
      } catch (error) {
        return fail(res, 'subscribe', error);
      }
    },

    async unsubscribe(req, res) {
      try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) return res.status(403).json({ error: 'tenant_required' });
        const server = serverOf(req);
        if (!server) return res.status(400).json({ error: 'invalid_subscription' });
        const ended = await store.unsubscribeMcpServer({ tenantId, server });
        if (!ended) return res.status(404).json({ error: 'not_subscribed' });
        await emitAdminAudit(req, {
          action: 'mcp_server.unsubscribed',
          outcome: 'success',
          severity: 'info',
          target: { type: 'mcp_server', id: server, name: server },
          metadata: { price: ended.price, currency: ended.currency },
        });
        return res.json({ subscription: toSubscriptionView(ended, now()) });
      } catch (error) {
        return fail(res, 'unsubscribe', error);
      }
    },
  };
}
