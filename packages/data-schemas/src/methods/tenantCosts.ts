import type { PipelineStage } from 'mongoose';

/**
 * What a tenant's usage cost (fork-only), from its ledger: the credits its users spent on tokens
 * and on web searches (transactions of context `web_search`), per day, per model and, when asked,
 * per user and per group. Credits are USD-based (1,000,000 credits = 1 USD) and already carry the
 * operator's markup, since that is what was charged. Runs in the caller's tenant; tenant
 * isolation scopes every query as well.
 */

export const WEB_SEARCH_CONTEXT = 'web_search';

export type TenantCostPeriod = { days: 7 | 30 | 90 } | { month: string };

export interface TenantCostOptions {
  tenantId: string;
  period: TenantCostPeriod;
  /** IANA time zone the days are counted in; invalid zones fall back to UTC. */
  timeZone?: string;
  /** Adds the per-user and per-group lists. */
  byPerson?: boolean;
  now?: Date;
}

export interface TenantCostAmounts {
  /** Credits spent on tokens. */
  tokenCredits: number;
  /** Credits spent on web searches. */
  searchCredits: number;
  searches: number;
}

export interface TenantCostDay extends TenantCostAmounts {
  date: string;
}

export interface TenantCostModel {
  model: string;
  tokenCredits: number;
  promptTokens: number;
  completionTokens: number;
}

export interface TenantCostUser extends TenantCostAmounts {
  userId: string;
  name?: string;
  email?: string;
}

export interface TenantCostGroup extends TenantCostAmounts {
  groupId: string;
  name: string;
  members: number;
}

export interface TenantCosts {
  /** First and last day counted, `YYYY-MM-DD` in the requested time zone. */
  from: string;
  to: string;
  totals: TenantCostAmounts;
  daily: TenantCostDay[];
  models: TenantCostModel[];
  users?: TenantCostUser[];
  groups?: TenantCostGroup[];
}

export interface TenantCostMethods {
  getTenantCosts(options: TenantCostOptions): Promise<TenantCosts>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isCostMonth(value: string): boolean {
  return MONTH.test(value);
}

function zoneOf(timeZone?: string): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return timeZone;
  } catch {
    return 'UTC';
  }
}

const dayOf = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);

/** The days of the period, oldest first, never past today. */
function daysOf(period: TenantCostPeriod, zone: string, now: Date): string[] {
  const today = dayOf(now, zone);
  if ('days' in period) {
    return Array.from({ length: period.days }, (_, i) =>
      dayOf(new Date(now.getTime() - (period.days - 1 - i) * DAY_MS), zone),
    );
  }
  const [, year, month] = MONTH.exec(period.month) ?? [];
  const days: string[] = [];
  const length = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  for (let day = 1; day <= length; day++) {
    const date = `${period.month}-${String(day).padStart(2, '0')}`;
    if (date > today) break;
    days.push(date);
  }
  return days;
}

const dayKey = (timeZone: string) => ({
  $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: timeZone },
});

const spent = { $multiply: [-1, { $ifNull: ['$tokenValue', 0] }] };
const isSearch = { $eq: ['$context', WEB_SEARCH_CONTEXT] };
const isToken = { $in: ['$tokenType', ['prompt', 'completion']] };

const amountFields = {
  tokenCredits: { $sum: { $cond: [isToken, spent, 0] } },
  searchCredits: { $sum: { $cond: [isSearch, spent, 0] } },
  searches: { $sum: { $cond: [isSearch, 1, 0] } },
};

interface AmountRow {
  _id: string | null;
  tokenCredits?: number;
  searchCredits?: number;
  searches?: number;
}

interface ModelRow {
  _id: string | null;
  tokenCredits?: number;
  promptTokens?: number;
  completionTokens?: number;
}

interface UserDoc {
  _id: { toString(): string };
  name?: string;
  email?: string;
  idOnTheSource?: string;
}

interface GroupDoc {
  _id: { toString(): string };
  name: string;
  memberIds?: string[];
}

const zero = (): TenantCostAmounts => ({ tokenCredits: 0, searchCredits: 0, searches: 0 });

function amountsOf(row: AmountRow): TenantCostAmounts {
  return {
    tokenCredits: Math.round(row.tokenCredits ?? 0),
    searchCredits: Math.round(row.searchCredits ?? 0),
    searches: row.searches ?? 0,
  };
}

function add(into: TenantCostAmounts, from: TenantCostAmounts): void {
  into.tokenCredits += from.tokenCredits;
  into.searchCredits += from.searchCredits;
  into.searches += from.searches;
}

const total = (amounts: TenantCostAmounts) => amounts.tokenCredits + amounts.searchCredits;

export function createTenantCostMethods(mongoose: typeof import('mongoose')): TenantCostMethods {
  async function run<T>(modelName: string, pipeline: PipelineStage[]): Promise<T[]> {
    const model = mongoose.models[modelName];
    return model ? await model.aggregate<T>(pipeline) : [];
  }

  async function people(userIds: string[]): Promise<{ users: UserDoc[]; groups: GroupDoc[] }> {
    const User = mongoose.models.User;
    const Group = mongoose.models.Group;
    const ids = userIds.filter((id) => mongoose.isObjectIdOrHexString(id));
    const [users, groups] = await Promise.all([
      User && ids.length > 0
        ? User.find({ _id: { $in: ids } }, { name: 1, email: 1, idOnTheSource: 1 }).lean<
            UserDoc[]
          >()
        : Promise.resolve([] as UserDoc[]),
      Group ? Group.find({}, { name: 1, memberIds: 1 }).lean<GroupDoc[]>() : [],
    ]);
    return { users, groups };
  }

  return {
    async getTenantCosts({ tenantId, period, timeZone, byPerson = false, now = new Date() }) {
      const zone = zoneOf(timeZone);
      const dates = daysOf(period, zone, now);
      const first = dates[0] ?? dayOf(now, zone);
      const last = dates[dates.length - 1] ?? first;
      // The index narrows to a day around the period; the day key then cuts it exactly.
      const since = new Date(Date.parse(`${first}T00:00:00Z`) - DAY_MS);
      const until = new Date(Date.parse(`${last}T00:00:00Z`) + 2 * DAY_MS);
      const window: PipelineStage[] = [
        {
          $match: {
            tenantId,
            createdAt: { $gte: since, $lt: until },
            $or: [
              { tokenType: { $in: ['prompt', 'completion'] } },
              { context: WEB_SEARCH_CONTEXT },
            ],
          },
        },
        {
          $match: {
            $expr: { $and: [{ $gte: [dayKey(zone), first] }, { $lte: [dayKey(zone), last] }] },
          },
        },
      ];

      const [dayRows, modelRows, userRows] = await Promise.all([
        run<AmountRow>('Transaction', [
          ...window,
          { $group: { _id: dayKey(zone), ...amountFields } },
        ]),
        run<ModelRow>('Transaction', [
          ...window,
          { $match: { tokenType: { $in: ['prompt', 'completion'] } } },
          {
            $group: {
              _id: '$model',
              tokenCredits: { $sum: spent },
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
        byPerson
          ? run<AmountRow>('Transaction', [
              ...window,
              { $group: { _id: { $toString: '$user' }, ...amountFields } },
            ])
          : Promise.resolve([] as AmountRow[]),
      ]);

      const byDay = new Map(dates.map((date) => [date, { date, ...zero() }]));
      const totals = zero();
      for (const row of dayRows) {
        const day = row._id ? byDay.get(row._id) : undefined;
        if (!day) continue;
        const amounts = amountsOf(row);
        add(day, amounts);
        add(totals, amounts);
      }

      const models = modelRows
        .map((row) => ({
          model: row._id || 'unknown',
          tokenCredits: Math.round(row.tokenCredits ?? 0),
          promptTokens: Math.round(row.promptTokens ?? 0),
          completionTokens: Math.round(row.completionTokens ?? 0),
        }))
        .sort((a, b) => b.tokenCredits - a.tokenCredits || a.model.localeCompare(b.model));

      const result: TenantCosts = {
        from: first,
        to: last,
        totals,
        daily: [...byDay.values()],
        models,
      };
      if (!byPerson) {
        return result;
      }

      const spentBy = new Map(
        userRows.filter((row) => row._id).map((row) => [row._id as string, amountsOf(row)]),
      );
      const { users, groups } = await people([...spentBy.keys()]);
      const userById = new Map(users.map((user) => [user._id.toString(), user]));
      result.users = [...spentBy.entries()]
        .map(([userId, amounts]) => {
          const user = userById.get(userId);
          return {
            userId,
            ...(user?.name && { name: user.name }),
            ...(user?.email && { email: user.email }),
            ...amounts,
          };
        })
        .sort((a, b) => total(b) - total(a) || a.userId.localeCompare(b.userId));

      /** `memberIds` holds a user's `idOnTheSource` for external users, else the user id. */
      const memberKey = new Map<string, string>();
      for (const user of users) {
        const id = user._id.toString();
        memberKey.set(id, id);
        if (user.idOnTheSource) memberKey.set(user.idOnTheSource, id);
      }
      result.groups = groups
        .map((group) => {
          const amounts = zero();
          const members = new Set<string>();
          for (const member of group.memberIds ?? []) {
            const userId = memberKey.get(member);
            if (!userId || members.has(userId)) continue;
            members.add(userId);
            const own = spentBy.get(userId);
            if (own) add(amounts, own);
          }
          return {
            groupId: group._id.toString(),
            name: group.name,
            members: group.memberIds?.length ?? 0,
            ...amounts,
          };
        })
        .sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name));
      return result;
    },
  };
}
