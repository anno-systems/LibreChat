import { Schema } from 'mongoose';
import type { Model, PipelineStage } from 'mongoose';
import { runAsSystem } from '~/config/tenantContext';

/**
 * How the whole platform is used, for the operator's overview (fork-only). Totals and per-day
 * sums across every tenant leave this module, never a row per tenant or per person.
 *
 * Sign-ins are not recorded upstream: a session document exists only for local refresh tokens
 * (not with `OPENID_REUSE_TOKENS`) and is removed at sign-out or expiry. So each chat sign-in
 * through the identity provider writes a `PlatformSignIn` with its tenant and time only, no
 * user, kept for `SIGN_IN_RETENTION_DAYS` (the longest period the overview shows, with margin).
 */

export const PLATFORM_USAGE_DAYS = [7, 30, 90] as const;
export type PlatformUsageDays = (typeof PLATFORM_USAGE_DAYS)[number];

/** Longer than the 90-day period, so a day at the edge of the window is still complete. */
export const SIGN_IN_RETENTION_DAYS = 100;

export interface PlatformUsageOptions {
  days: PlatformUsageDays;
  /** IANA time zone the days are counted in; invalid zones fall back to UTC. */
  timeZone?: string;
  now?: Date;
}

export interface PlatformUsageDay {
  date: string;
  signIns: number;
  activeUsers: number;
  messages: number;
  promptTokens: number;
  completionTokens: number;
  webSearches: number;
}

export interface PlatformUsage {
  /** First and last day shown, `YYYY-MM-DD` in the requested time zone. */
  from: string;
  to: string;
  days: PlatformUsageDays;
  /** The time zone the days were counted in. */
  timeZone: string;
  totals: {
    /** Accounts on the platform now. */
    users: number;
    /** Agents users built (not the copies of platform agents) now. */
    agents: number;
    /** Distinct users who sent at least one message in the period. */
    activeUsers: number;
    signIns: number;
    messages: number;
    promptTokens: number;
    completionTokens: number;
    webSearches: number;
  };
  daily: PlatformUsageDay[];
}

export interface PlatformSignIn {
  tenantId?: string;
  createdAt: Date;
}

export interface PlatformUsageMethods {
  getPlatformUsage(options: PlatformUsageOptions): Promise<PlatformUsage>;
  /** Records one chat sign-in; the tenant is the only detail kept. */
  recordPlatformSignIn(entry: { tenantId?: string; at?: Date }): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The search tool's name in a reply's tool calls (`Tools.web_search`). */
const WEB_SEARCH_TOOL = 'web_search';

const platformSignInSchema = new Schema<PlatformSignIn>({
  tenantId: { type: String },
  createdAt: { type: Date, required: true },
});
platformSignInSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: SIGN_IN_RETENTION_DAYS * 24 * 60 * 60 },
);

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
  count?: number;
  activeUsers?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export function createPlatformUsageMethods(
  mongoose: typeof import('mongoose'),
): PlatformUsageMethods {
  const SignIn: Model<PlatformSignIn> =
    mongoose.models.PlatformSignIn ||
    mongoose.model<PlatformSignIn>('PlatformSignIn', platformSignInSchema);

  async function run<T>(modelName: string, pipeline: PipelineStage[]): Promise<T[]> {
    const model = mongoose.models[modelName];
    return model ? await model.aggregate<T>(pipeline) : [];
  }

  async function count(modelName: string, filter: Record<string, unknown> = {}): Promise<number> {
    const model = mongoose.models[modelName];
    return model ? await model.countDocuments(filter) : 0;
  }

  return {
    async recordPlatformSignIn({ tenantId, at = new Date() }) {
      await SignIn.create({ ...(tenantId && { tenantId }), createdAt: at });
    },

    getPlatformUsage({ days, timeZone, now = new Date() }) {
      return runAsSystem(async () => {
        const zone = zoneOf(timeZone);
        const dates = Array.from({ length: days }, (_, i) =>
          dayOf(new Date(now.getTime() - (days - 1 - i) * DAY_MS), zone),
        );
        const since = new Date(now.getTime() - days * DAY_MS);
        // `createdAt` narrows by index to a day more than shown; the day key then cuts at the
        // first day in the requested zone.
        const window = (extra: Record<string, unknown> = {}): PipelineStage[] => [
          { $match: { createdAt: { $gte: since, $lte: now }, ...extra } },
          { $match: { $expr: { $gte: [dayKey(zone), dates[0]] } } },
        ];
        // Transactions are indexed by tenant and time only; their ObjectId (creation time, a
        // day early against clock skew) lets the `_id` index bound the range across tenants.
        const idSince = mongoose.Types.ObjectId.createFromTime(
          Math.floor((since.getTime() - DAY_MS) / 1000),
        );

        const [users, agents, messageDays, activeTotal, tokenDays, searchDays, signInDays] =
          await Promise.all([
            count('User'),
            count('Agent', { platformAgentId: { $exists: false } }),
            run<DayRow>('Message', [
              ...window({ isCreatedByUser: true }),
              { $group: { _id: dayKey(zone), count: { $sum: 1 }, users: { $addToSet: '$user' } } },
              { $project: { count: 1, activeUsers: { $size: '$users' } } },
            ]),
            run<{ activeUsers: number }>('Message', [
              ...window({ isCreatedByUser: true }),
              { $group: { _id: '$user' } },
              { $count: 'activeUsers' },
            ]),
            run<DayRow>('Transaction', [
              { $match: { _id: { $gte: idSince } } },
              ...window({ tokenType: { $in: ['prompt', 'completion'] } }),
              {
                $group: {
                  _id: dayKey(zone),
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
            run<DayRow>('Message', [
              ...window({ isCreatedByUser: false, 'content.tool_call.name': WEB_SEARCH_TOOL }),
              { $unwind: '$content' },
              { $match: { 'content.tool_call.name': WEB_SEARCH_TOOL } },
              { $group: { _id: dayKey(zone), count: { $sum: 1 } } },
            ]),
            SignIn.aggregate<DayRow>([
              ...window(),
              { $group: { _id: dayKey(zone), count: { $sum: 1 } } },
            ]),
          ]);

        const byDay = new Map<string, PlatformUsageDay>(
          dates.map((date) => [
            date,
            {
              date,
              signIns: 0,
              activeUsers: 0,
              messages: 0,
              promptTokens: 0,
              completionTokens: 0,
              webSearches: 0,
            },
          ]),
        );
        for (const row of messageDays) {
          const day = byDay.get(row._id);
          if (!day) continue;
          day.messages = row.count ?? 0;
          day.activeUsers = row.activeUsers ?? 0;
        }
        for (const row of tokenDays) {
          const day = byDay.get(row._id);
          if (!day) continue;
          day.promptTokens = Math.round(row.promptTokens ?? 0);
          day.completionTokens = Math.round(row.completionTokens ?? 0);
        }
        for (const row of searchDays) {
          const day = byDay.get(row._id);
          if (day) day.webSearches = row.count ?? 0;
        }
        for (const row of signInDays) {
          const day = byDay.get(row._id);
          if (day) day.signIns = row.count ?? 0;
        }

        const daily = [...byDay.values()];
        const sum = (key: keyof Omit<PlatformUsageDay, 'date'>) =>
          daily.reduce((total, d) => total + d[key], 0);
        return {
          from: dates[0]!,
          to: dates[dates.length - 1]!,
          days,
          timeZone: zone,
          totals: {
            users,
            agents,
            activeUsers: activeTotal[0]?.activeUsers ?? 0,
            signIns: sum('signIns'),
            messages: sum('messages'),
            promptTokens: sum('promptTokens'),
            completionTokens: sum('completionTokens'),
            webSearches: sum('webSearches'),
          },
          daily,
        };
      });
    },
  };
}
