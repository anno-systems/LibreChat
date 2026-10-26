import type { PipelineStage } from 'mongoose';

/**
 * A tenant's chat usage for the admin dashboard (fork-only). Only totals and per-day or
 * per-model aggregates leave this method: no user names, ids or message content, so the
 * dashboard shows how the tenant uses the platform without monitoring individual people.
 * Runs in the caller's tenant; tenant isolation scopes every pipeline as well.
 */

export const TENANT_USAGE_DAYS = [7, 30, 90] as const;
export type TenantUsageDays = (typeof TENANT_USAGE_DAYS)[number];

export interface TenantUsageOptions {
  tenantId: string;
  days: TenantUsageDays;
  /** IANA time zone the days are counted in; invalid zones fall back to UTC. */
  timeZone?: string;
  now?: Date;
}

export interface TenantUsageDay {
  date: string;
  activeUsers: number;
  messages: number;
  conversations: number;
}

export interface TenantUsageModel {
  /** The reply's model; for an agent's replies LibreChat stores the agent id here. */
  model: string;
  /** Set when `model` is an agent of the tenant: its current name, for display. */
  agentName?: string;
  replies: number;
  promptTokens: number;
  completionTokens: number;
}

export interface TenantUsage {
  /** First and last day shown, `YYYY-MM-DD` in the requested time zone. */
  from: string;
  to: string;
  days: TenantUsageDays;
  totals: {
    activeUsers: number;
    messages: number;
    conversations: number;
    promptTokens: number;
    completionTokens: number;
  };
  daily: TenantUsageDay[];
  models: TenantUsageModel[];
}

export interface TenantUsageMethods {
  getTenantUsage(options: TenantUsageOptions): Promise<TenantUsage>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** LibreChat's agent ids (`agent_<nanoid>`), which agent replies carry as their model. */
const AGENT_ID_PREFIX = 'agent_';

function zoneOf(timeZone?: string): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function dayOf(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

const dayKey = (timeZone: string) => ({
  $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: timeZone },
});

interface DayRow {
  _id: string;
  messages?: number;
  activeUsers?: number;
  conversations?: number;
}
interface ModelRow {
  _id: string | null;
  replies?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export function createTenantUsageMethods(mongoose: typeof import('mongoose')): TenantUsageMethods {
  async function run<T>(modelName: string, pipeline: PipelineStage[]): Promise<T[]> {
    const model = mongoose.models[modelName];
    return model ? await model.aggregate<T>(pipeline) : [];
  }

  return {
    async getTenantUsage({ tenantId, days, timeZone, now = new Date() }) {
      const zone = zoneOf(timeZone);
      const dates = Array.from({ length: days }, (_, i) =>
        dayOf(new Date(now.getTime() - (days - 1 - i) * DAY_MS), zone),
      );
      const since = new Date(now.getTime() - days * DAY_MS);
      // The index narrows to a day more than shown; the day key then cuts at the first day.
      const window: PipelineStage[] = [
        { $match: { tenantId, createdAt: { $gte: since, $lte: now } } },
        { $match: { $expr: { $gte: [dayKey(zone), dates[0]] } } },
      ];
      const inRange = (extra: Record<string, unknown> = {}): PipelineStage[] => [
        ...window,
        ...(Object.keys(extra).length > 0 ? [{ $match: extra }] : []),
      ];

      const [userDays, userTotals, conversationDays, replies, tokens] = await Promise.all([
        run<DayRow>('Message', [
          ...inRange({ isCreatedByUser: true }),
          {
            $group: {
              _id: dayKey(zone),
              messages: { $sum: 1 },
              users: { $addToSet: '$user' },
            },
          },
          { $project: { messages: 1, activeUsers: { $size: '$users' } } },
        ]),
        run<{ _id: null; activeUsers: number }>('Message', [
          ...inRange({ isCreatedByUser: true }),
          { $group: { _id: '$user' } },
          { $count: 'activeUsers' },
          { $project: { _id: null, activeUsers: 1 } },
        ]),
        run<DayRow>('Conversation', [
          ...inRange(),
          { $group: { _id: dayKey(zone), conversations: { $sum: 1 } } },
        ]),
        run<ModelRow>('Message', [
          ...inRange({ isCreatedByUser: false }),
          { $group: { _id: '$model', replies: { $sum: 1 } } },
        ]),
        run<ModelRow>('Transaction', [
          ...inRange({ tokenType: { $in: ['prompt', 'completion'] } }),
          {
            $group: {
              _id: '$model',
              promptTokens: {
                $sum: { $cond: [{ $eq: ['$tokenType', 'prompt'] }, { $abs: '$rawAmount' }, 0] },
              },
              completionTokens: {
                $sum: {
                  $cond: [{ $eq: ['$tokenType', 'completion'] }, { $abs: '$rawAmount' }, 0],
                },
              },
            },
          },
        ]),
      ]);

      const byDay = new Map<string, TenantUsageDay>(
        dates.map((date) => [date, { date, activeUsers: 0, messages: 0, conversations: 0 }]),
      );
      for (const row of userDays) {
        const day = byDay.get(row._id);
        if (!day) continue;
        day.messages = row.messages ?? 0;
        day.activeUsers = row.activeUsers ?? 0;
      }
      for (const row of conversationDays) {
        const day = byDay.get(row._id);
        if (day) day.conversations = row.conversations ?? 0;
      }

      const byModel = new Map<string, TenantUsageModel>();
      const modelEntry = (name: string | null) => {
        const model = name || 'unknown';
        let entry = byModel.get(model);
        if (!entry) {
          entry = { model, replies: 0, promptTokens: 0, completionTokens: 0 };
          byModel.set(model, entry);
        }
        return entry;
      };
      for (const row of replies) modelEntry(row._id).replies = row.replies ?? 0;
      for (const row of tokens) {
        const entry = modelEntry(row._id);
        entry.promptTokens = Math.round(row.promptTokens ?? 0);
        entry.completionTokens = Math.round(row.completionTokens ?? 0);
      }
      const agentIds = [...byModel.keys()].filter((id) => id.startsWith(AGENT_ID_PREFIX));
      const agents = agentIds.length
        ? await run<{ _id: string; name?: string }>('Agent', [
            { $match: { id: { $in: agentIds } } },
            { $group: { _id: '$id', name: { $first: '$name' } } },
          ])
        : [];
      for (const agent of agents) {
        const entry = byModel.get(agent._id);
        if (entry && agent.name) entry.agentName = agent.name;
      }
      const models = [...byModel.values()].sort(
        (a, b) => b.replies - a.replies || a.model.localeCompare(b.model),
      );

      const daily = [...byDay.values()];
      return {
        from: dates[0]!,
        to: dates[dates.length - 1]!,
        days,
        totals: {
          activeUsers: userTotals[0]?.activeUsers ?? 0,
          messages: daily.reduce((sum, d) => sum + d.messages, 0),
          conversations: daily.reduce((sum, d) => sum + d.conversations, 0),
          promptTokens: models.reduce((sum, m) => sum + m.promptTokens, 0),
          completionTokens: models.reduce((sum, m) => sum + m.completionTokens, 0),
        },
        daily,
        models,
      };
    },
  };
}
