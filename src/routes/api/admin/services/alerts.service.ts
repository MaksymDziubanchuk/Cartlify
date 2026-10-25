import { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { shopToday } from '@helpers/shopDay.js';
import { NotFoundError } from '@utils/errors.js';
import { orderTimeoutWorkerState } from '../../../../workers/orderTimeout.worker.js';
import { FREE_STOCK_SQL } from '../../products/services/helpers/getAllProducts.helper.js';
import { utcTime } from './helpers/accountingSql.helper.js';
import {
  dismissalFieldOf,
  dropDismissals,
  listDismissals,
  putCaseAside,
  readDismissals,
  takeCaseBack,
  type Dismissal,
} from './helpers/alertDismissals.helper.js';
import {
  alertKindsOf,
  alertListOf,
  alertWindowOf,
  assertThreshold,
  thresholdOf,
  workerStalled,
  type AlertWindow,
} from './helpers/alertKinds.helper.js';

import type {
  AdminAlertDismissalDto,
  AdminAlertDismissalItemDto,
  AdminAlertDto,
  AdminAlertKind,
  AdminAlertSubscriptionDto,
  GetAdminAlertsResponseDto,
} from 'types/dto/admin.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the alerts of an admin (GET /api/admin/alerts): what waits for the work of an admin, each kind
// with how many cases wait, counted when asked in one snapshot with the thresholds of the actor,
// and the request to the list of the app that shows those cases. Root has the actions of the
// admins too. Each admin and each root, for themselves, follows a kind or not and sets its
// threshold (admin_alert_settings), and puts single cases aside (in redis)

type Db = Prisma.TransactionClient;
type Actor = { actorId: UserId; actorRole: Role };

// the kinds whose cases have an id an admin can put aside: all but the stop of the worker
type CaseKind = Exclude<AdminAlertKind, 'worker_stalled'>;

const isCaseKind = (kind: AdminAlertKind): kind is CaseKind => kind !== 'worker_stalled';

// the cases of a kind: the rows they are read from (t, t.id the id of a case) and the ones that
// wait, in the window of the threshold; the same conditions as the filters of the list the
// alert names (alertListOf)
type Cases = { from: Prisma.Sql; where: Prisma.Sql };

const ORDERS = Prisma.sql`from cartlify.orders as t`;
const BATCHES = Prisma.sql`from cartlify.product_batches as t`;
const LOG = Prisma.sql`from cartlify.admin_audit_log as t`;
// the products with their free units, the number the catalog shows as stock
const PRODUCTS = Prisma.sql`from (
    select p.id, p."deletedAt", ${FREE_STOCK_SQL} as free from cartlify.products as p
  ) as t`;

const CASES: Record<CaseKind, (window: AlertWindow) => Cases> = {
  // paid, to be shipped
  paid_orders_waiting: () => ({
    from: ORDERS,
    where: Prisma.sql`t.status = 'paid'::cartlify."OrderStatus"`,
  }),
  // shipped long ago and not delivered yet
  shipped_orders_waiting: (window) => ({
    from: ORDERS,
    where: Prisma.sql`t.status = 'shipped'::cartlify."OrderStatus"
      and t."updatedAt" < ${utcTime(window.before ?? new Date(0))}`,
  }),
  // products of the catalog with no free units
  out_of_stock: () => ({
    from: PRODUCTS,
    where: Prisma.sql`t."deletedAt" is null and t.free = 0`,
  }),
  // products of the catalog with few free units
  low_stock: (window) => ({
    from: PRODUCTS,
    where: Prisma.sql`t."deletedAt" is null and t.free >= 1 and t.free <= ${window.units ?? 0}`,
  }),
  // batches with units whose last good day is near, by the day of the shop
  expiring_batches: (window) => ({
    from: BATCHES,
    where: Prisma.sql`t.remaining > 0 and t."expiresAt" >= cartlify.shop_today()
      and t."expiresAt" <= ${window.expiresBy ?? '1970-01-01'}::date`,
  }),
  // batches with units that are over: to be written off
  expired_batches: () => ({
    from: BATCHES,
    where: Prisma.sql`t.remaining > 0 and t."expiresAt" < cartlify.shop_today()`,
  }),
  // chats with a message no admin has read
  chats_waiting: () => ({
    from: Prisma.sql`from cartlify.chat_threads as t`,
    where: Prisma.sql`t.type = 'admin'::cartlify."ChatType" and t.status = 'open'::cartlify."ChatStatus"
      and t."adminUnreadSince" is not null`,
  }),
  // the lines of the late payments the shop gave back: the buyer may ask
  refunded_payments: (window) => ({
    from: LOG,
    where: Prisma.sql`t.action = 'OTHER'::cartlify."AdminAuditAction"
      and t."entityType" = 'order'::cartlify."AdminAuditEntityType"
      and t.meta @> '[{"field": "refund"}]'::jsonb
      and t."createdAt" >= ${utcTime(window.since ?? new Date(0))}`,
  }),
  // root: the lines the admins wrote
  admin_actions: (window) => ({
    from: LOG,
    where: Prisma.sql`t."actorRole" = 'ADMIN'::cartlify."Role"
      and t."createdAt" >= ${utcTime(window.since ?? new Date(0))}`,
  }),
};

// the cases of a kind that wait, without the ones put aside (aside: their ids), how many of those
// still wait, and which
async function countedCases(db: Db, kind: CaseKind, window: AlertWindow, aside: string[]) {
  const { from, where } = CASES[kind](window);
  const [row] = await db.$queryRaw<{ count: bigint; dismissed: bigint; found: string[] | null }[]>`
    select count(*) filter (where not (t.id::text = any(${aside}::text[]))) as count,
      count(*) filter (where t.id::text = any(${aside}::text[])) as dismissed,
      array_agg(t.id::text) filter (where t.id::text = any(${aside}::text[])) as found
    ${from}
    where ${where}
  `;

  return {
    count: Number(row?.count ?? 0),
    dismissed: Number(row?.dismissed ?? 0),
    found: row?.found ?? [],
  };
}

type Setting = { subscribed: boolean; threshold: number | null };

// a kind without a row is followed with the threshold the server gives
const DEFAULT_SETTING: Setting = { subscribed: true, threshold: null };

async function settingsOf(db: Db, userId: number): Promise<Map<string, Setting>> {
  const rows = await db.adminAlertSetting.findMany({
    where: { userId },
    select: { kind: true, subscribed: true, threshold: true },
  });
  return new Map(
    rows.map((row) => [row.kind, { subscribed: row.subscribed, threshold: row.threshold }]),
  );
}

// the threshold a kind is counted with, and its window now
const scopeOf = (kind: AdminAlertKind, setting: Setting, now: number) => {
  const threshold = thresholdOf(kind, setting.threshold)?.value ?? null;
  return { threshold, window: alertWindowOf(kind, threshold, now, shopToday(now)) };
};

const asideOf = (dismissals: Dismissal[] | null, kind: string) =>
  (dismissals ?? [])
    .filter((dismissal) => dismissal.kind === kind)
    .map((dismissal) => dismissal.id);

// the marks of the cases that are no longer aside: their case is over, or their kind is not one
// of the cases of the actor any more
const marksOver = (dismissals: Dismissal[], kept: Set<string>) =>
  dismissals
    .map((dismissal) => dismissalFieldOf(dismissal.kind, dismissal.id))
    .filter((field) => !kept.has(field));

// the alerts of the actor: every kind of their zone, or only the ones they follow (subscribed)
export async function getAdminAlerts(
  actor: Actor,
  opts: { subscribed?: boolean | undefined } = {},
): Promise<GetAdminAlertsResponseDto> {
  const now = Date.now();
  const userId = Number(actor.actorId);
  const dismissals = await readDismissals(userId);

  const { alerts, kept, countedKinds } = await prisma.$transaction(
    async (db) => {
      await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
      const settings = await settingsOf(db, userId);

      const alerts: AdminAlertDto[] = [];
      // the marks still aside, and the kinds counted: a mark of a kind not counted stays
      const kept = new Set<string>();
      const countedKinds = new Set<string>();
      for (const kind of alertKindsOf(actor.actorRole)) {
        const setting = settings.get(kind) ?? DEFAULT_SETTING;
        if (opts.subscribed && !setting.subscribed) continue;
        const { threshold, window } = scopeOf(kind, setting, now);

        let tally: { count: number; dismissed: number };
        if (isCaseKind(kind)) {
          const cases = await countedCases(db, kind, window, asideOf(dismissals, kind));
          for (const id of cases.found) kept.add(dismissalFieldOf(kind, id));
          countedKinds.add(kind);
          tally = { count: cases.count, dismissed: cases.dismissed };
        } else {
          const stalled = workerStalled(orderTimeoutWorkerState(), threshold ?? 0, now);
          tally = { count: stalled ? 1 : 0, dismissed: 0 };
        }

        alerts.push({
          kind,
          subscribed: setting.subscribed,
          ...tally,
          threshold,
          list: alertListOf(kind, window),
        });
      }
      return { alerts, kept, countedKinds };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  if (dismissals) {
    // a kind that is not counted keeps its marks, unless it is not a kind of the actor at all
    const kinds = new Set<string>(alertKindsOf(actor.actorRole));
    const looked = dismissals.filter(
      (dismissal) => countedKinds.has(dismissal.kind) || !kinds.has(dismissal.kind),
    );
    await dropDismissals(userId, marksOver(looked, kept));
  }

  return {
    alerts,
    total: alerts.reduce((sum, alert) => sum + alert.count, 0),
    dismissalsAvailable: dismissals !== null,
    generatedAt: new Date(now).toISOString(),
  };
}

const assertKind = (kind: string, role: Role): AdminAlertKind => {
  if (!(alertKindsOf(role) as string[]).includes(kind)) {
    throw new NotFoundError('ALERT_KIND_NOT_FOUND', { kind });
  }
  return kind as AdminAlertKind;
};

// a kind of the actor whose cases have an id
const assertCaseKind = (kind: string, role: Role): CaseKind => {
  const known = assertKind(kind, role);
  if (!isCaseKind(known)) throw new NotFoundError('ALERT_KIND_NOT_FOUND', { kind });
  return known;
};

const subscriptionOf = (kind: AdminAlertKind, setting: Setting): AdminAlertSubscriptionDto => ({
  kind,
  subscribed: setting.subscribed,
  threshold: thresholdOf(kind, setting.threshold),
});

export async function getAlertSubscriptions(
  actor: Actor,
): Promise<{ items: AdminAlertSubscriptionDto[] }> {
  const settings = await prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
    return settingsOf(db, Number(actor.actorId));
  });

  return {
    items: alertKindsOf(actor.actorRole).map((kind) =>
      subscriptionOf(kind, settings.get(kind) ?? DEFAULT_SETTING),
    ),
  };
}

// one part of the setting of a kind of the actor, the other one as it is: the row is added or
// changed in one step, so two changes at once do not lose one another
async function writeSetting(
  actor: Actor,
  kind: AdminAlertKind,
  change: { subscribed: boolean } | { threshold: number | null },
): Promise<Setting> {
  const userId = Number(actor.actorId);
  const setsSubscribed = 'subscribed' in change;
  const subscribed = 'subscribed' in change ? change.subscribed : DEFAULT_SETTING.subscribed;
  const threshold = 'threshold' in change ? change.threshold : DEFAULT_SETTING.threshold;

  const [row] = await prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
    return db.$queryRaw<Setting[]>`
      insert into cartlify.admin_alert_settings as s ("userId", kind, subscribed, threshold)
      values (${userId}, ${kind}, ${subscribed}, ${threshold}::int)
      on conflict ("userId", kind) do update set
        subscribed = case when ${setsSubscribed} then excluded.subscribed else s.subscribed end,
        threshold = case when ${setsSubscribed} then s.threshold else excluded.threshold end
      returning subscribed, threshold
    `;
  });

  return row ?? DEFAULT_SETTING;
}

// follows a kind (subscribed) or not; its threshold stays; done already is no matter
export async function setAlertSubscription(args: {
  actorId: UserId;
  actorRole: Role;
  kind: string;
  subscribed: boolean;
}): Promise<AdminAlertSubscriptionDto> {
  const kind = assertKind(args.kind, args.actorRole);
  const setting = await writeSetting(args, kind, { subscribed: args.subscribed });
  return subscriptionOf(kind, setting);
}

// sets the threshold of a kind, or gives it back to the server (null); whether it is followed
// stays
export async function setAlertThreshold(args: {
  actorId: UserId;
  actorRole: Role;
  kind: string;
  value: number | null;
}): Promise<AdminAlertSubscriptionDto> {
  const kind = assertKind(args.kind, args.actorRole);
  if (args.value === null) {
    if (!thresholdOf(kind, null)) throw new NotFoundError('ALERT_THRESHOLD_NOT_FOUND', { kind });
  } else {
    assertThreshold(kind, args.value);
  }

  const setting = await writeSetting(args, kind, { threshold: args.value });
  return subscriptionOf(kind, setting);
}

// the cases the actor put aside that still wait, the latest first; the rest go
export async function getAlertDismissals(
  actor: Actor,
): Promise<{ items: AdminAlertDismissalItemDto[] }> {
  const now = Date.now();
  const userId = Number(actor.actorId);
  const dismissals = await listDismissals(userId);

  const kept = await prisma.$transaction(
    async (db) => {
      await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
      const settings = await settingsOf(db, userId);

      const kept = new Set<string>();
      for (const kind of alertKindsOf(actor.actorRole)) {
        const aside = asideOf(dismissals, kind);
        if (!isCaseKind(kind) || !aside.length) continue;
        const { window } = scopeOf(kind, settings.get(kind) ?? DEFAULT_SETTING, now);
        const { found } = await countedCases(db, kind, window, aside);
        for (const id of found) kept.add(dismissalFieldOf(kind, id));
      }
      return kept;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  await dropDismissals(userId, marksOver(dismissals, kept));

  return {
    items: dismissals
      .filter((dismissal) => kept.has(dismissalFieldOf(dismissal.kind, dismissal.id)))
      .sort((a, b) => b.dismissedAt.localeCompare(a.dismissedAt))
      .map((dismissal) => ({
        kind: dismissal.kind as AdminAlertKind,
        id: dismissal.id,
        dismissedAt: dismissal.dismissedAt,
      })),
  };
}

// puts one case of a kind aside for the actor, or takes it back; done already is no matter. Only
// a case the kind counts now is put aside
export async function setAlertDismissal(args: {
  actorId: UserId;
  actorRole: Role;
  kind: string;
  id: string;
  dismissed: boolean;
}): Promise<AdminAlertDismissalDto> {
  const kind = assertCaseKind(args.kind, args.actorRole);
  const userId = Number(args.actorId);

  if (!args.dismissed) {
    await takeCaseBack(userId, kind, args.id);
    return { kind, id: args.id, dismissed: false };
  }

  const now = Date.now();
  const waits = await prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    const settings = await settingsOf(db, userId);
    const { window } = scopeOf(kind, settings.get(kind) ?? DEFAULT_SETTING, now);
    const { found } = await countedCases(db, kind, window, [args.id]);
    return found.length > 0;
  });
  if (!waits) throw new NotFoundError('ALERT_ITEM_NOT_FOUND', { kind, id: args.id });

  await putCaseAside(userId, kind, args.id);
  return { kind, id: args.id, dismissed: true };
}
