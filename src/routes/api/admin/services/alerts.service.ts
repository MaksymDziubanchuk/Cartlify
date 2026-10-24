import { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { NotFoundError } from '@utils/errors.js';
import { orderTimeoutWorkerState } from '../../../../workers/orderTimeout.worker.js';

import type {
  AdminAlertDto,
  AdminAlertKind,
  AdminAlertSubscriptionDto,
  GetAdminAlertsResponseDto,
} from 'types/dto/admin.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the alerts of an admin (GET /api/admin/alerts): what waits for the work of an admin, each kind
// with how many there are and the latest of them, counted when asked in one snapshot. Root has the
// actions of the admins too. Each admin and each root turns a kind off and on for themselves
// (admin_alert_mutes): every kind is on until it is turned off

export const ADMIN_ALERT_KINDS = [
  'paid_orders_waiting',
  'shipped_orders_waiting',
  'out_of_stock',
  'low_stock',
  'expiring_batches',
  'expired_batches',
  'chats_waiting',
  'refunded_payments',
  'worker_stalled',
] as const satisfies readonly AdminAlertKind[];

export const ROOT_ALERT_KINDS = ['admin_actions'] as const satisfies readonly AdminAlertKind[];

// how many of the latest of a kind an alert names
const LATEST = 20;
// the refunds of the late payments of the last week, the actions of the admins of the last day
const REFUNDS_DAYS = 7;
const ADMIN_ACTIONS_HOURS = 24;

export const alertKindsOf = (role: Role): AdminAlertKind[] =>
  role === 'ROOT' ? [...ADMIN_ALERT_KINDS, ...ROOT_ALERT_KINDS] : [...ADMIN_ALERT_KINDS];

type Db = Prisma.TransactionClient;
type Counted = { count: number; ids: Array<number | string> };

// the products of the catalog with their free units, the way the catalog counts them: the stock
// less the reserve and the units of the batches that are over, those of every product at once
// (cartlify.product_expired_units does one product), for every product of the shop
const PRODUCTS_FREE = Prisma.raw(`from (
    select p.id, p."deletedAt", greatest(p.stock - p."reservedStock" - coalesce(e.units, 0), 0) as free
    from cartlify.products as p
    left join (
      select b."productId", sum(b.remaining)::int as units
      from cartlify.product_batches as b
      where b.remaining > 0 and b."expiresAt" < cartlify.shop_today()
      group by b."productId"
    ) as e on e."productId" = p.id
  ) as t`);

async function countedRows(db: Db, where: Prisma.Sql, from: Prisma.Sql, order: Prisma.Sql) {
  const [counted] = await db.$queryRaw<
    { count: bigint }[]
  >`select count(*) as count ${from} ${where}`;
  const rows = await db.$queryRaw<{ id: number | string }[]>`
    select x.id from (select ${order} as sort, t.id ${from} ${where}) as x
    order by x.sort desc, x.id desc
    limit ${LATEST}
  `;
  return { count: Number(counted?.count ?? 0), ids: rows.map((row) => row.id) };
}

// the worker is pulsing when it ran within the stall time; one that started and never ran, or ran
// long ago, has stopped. A server that never started it (the tests) has no worker to stop
export function workerStalled(
  state: { startedAt: Date | null; lastRunAt: Date | null },
  now = Date.now(),
): boolean {
  if (!state.startedAt) return false;
  const stallMs = env.ALERT_WORKER_STALL_SECONDS * 1000;
  const last = state.lastRunAt ?? state.startedAt;
  return now - last.getTime() > stallMs;
}

const COUNTERS: Record<AdminAlertKind, (db: Db) => Promise<Counted>> = {
  // paid, to be shipped
  paid_orders_waiting: (db) =>
    countedRows(
      db,
      Prisma.sql`where t.status = 'paid'::cartlify."OrderStatus"`,
      Prisma.sql`from cartlify.orders as t`,
      Prisma.sql`t."paidAt"`,
    ),
  // shipped long ago and not delivered yet
  shipped_orders_waiting: (db) =>
    countedRows(
      db,
      Prisma.sql`where t.status = 'shipped'::cartlify."OrderStatus"
        and t."updatedAt" < (now() at time zone 'utc') - make_interval(days => ${env.ALERT_SHIPPED_DAYS})`,
      Prisma.sql`from cartlify.orders as t`,
      Prisma.sql`t."updatedAt"`,
    ),
  // products of the catalog with no free units
  out_of_stock: (db) =>
    countedRows(
      db,
      Prisma.sql`where t."deletedAt" is null and t.free = 0`,
      PRODUCTS_FREE,
      Prisma.sql`t.id`,
    ),
  // products of the catalog with few free units
  low_stock: (db) =>
    countedRows(
      db,
      Prisma.sql`where t."deletedAt" is null and t.free between 1 and ${env.ALERT_LOW_STOCK_UNITS}`,
      PRODUCTS_FREE,
      Prisma.sql`t.id`,
    ),
  // batches with units whose last good day is near, by the day of the shop
  expiring_batches: (db) =>
    countedRows(
      db,
      Prisma.sql`where t.remaining > 0 and t."expiresAt" >= cartlify.shop_today()
        and t."expiresAt" <= cartlify.shop_today() + ${env.ALERT_BATCH_EXPIRY_DAYS}::int`,
      Prisma.sql`from cartlify.product_batches as t`,
      Prisma.sql`t."createdAt"`,
    ),
  // batches with units that are over: to be written off
  expired_batches: (db) =>
    countedRows(
      db,
      Prisma.sql`where t.remaining > 0 and t."expiresAt" < cartlify.shop_today()`,
      Prisma.sql`from cartlify.product_batches as t`,
      Prisma.sql`t."createdAt"`,
    ),
  // chats with a message that waits for an admin
  chats_waiting: (db) =>
    countedRows(
      db,
      Prisma.sql`where t.type = 'admin'::cartlify."ChatType" and t.status = 'open'::cartlify."ChatStatus"
        and t."adminUnreadSince" is not null`,
      Prisma.sql`from cartlify.chat_threads as t`,
      Prisma.sql`t."adminUnreadSince"`,
    ),
  // late payments the shop gave back in the last week: the buyer may ask
  refunded_payments: (db) =>
    countedRows(
      db,
      Prisma.sql`where t.action = 'OTHER'::cartlify."AdminAuditAction"
        and t."entityType" = 'order'::cartlify."AdminAuditEntityType"
        and t.meta @> '[{"field": "refund"}]'::jsonb
        and t."createdAt" > (now() at time zone 'utc') - make_interval(days => ${REFUNDS_DAYS})`,
      Prisma.sql`from (select l.id as line, l."entityId" as id, l.action, l."entityType", l.meta, l."createdAt"
        from cartlify.admin_audit_log as l) as t`,
      Prisma.sql`t."createdAt"`,
    ),
  worker_stalled: async () => ({
    count: workerStalled(orderTimeoutWorkerState()) ? 1 : 0,
    ids: [],
  }),
  // root: the lines the admins wrote in the last day
  admin_actions: (db) =>
    countedRows(
      db,
      Prisma.sql`where t."actorRole" = 'ADMIN'::cartlify."Role"
        and t."createdAt" > (now() at time zone 'utc') - make_interval(hours => ${ADMIN_ACTIONS_HOURS})`,
      Prisma.sql`from cartlify.admin_audit_log as t`,
      Prisma.sql`t."createdAt"`,
    ),
};

const mutedOf = async (db: Db, userId: number) =>
  new Set(
    (await db.adminAlertMute.findMany({ where: { userId }, select: { kind: true } })).map(
      (row) => row.kind,
    ),
  );

export async function getAdminAlerts(actor: {
  actorId: UserId;
  actorRole: Role;
}): Promise<GetAdminAlertsResponseDto> {
  const alerts = await prisma.$transaction(
    async (db) => {
      await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
      const muted = await mutedOf(db, Number(actor.actorId));

      const list: AdminAlertDto[] = [];
      for (const kind of alertKindsOf(actor.actorRole)) {
        if (muted.has(kind)) continue;
        list.push({ kind, ...(await COUNTERS[kind](db)) });
      }
      return list;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  return {
    alerts,
    total: alerts.reduce((sum, alert) => sum + alert.count, 0),
    generatedAt: new Date().toISOString(),
  };
}

const assertKind = (kind: string, role: Role): AdminAlertKind => {
  if (!(alertKindsOf(role) as string[]).includes(kind)) {
    throw new NotFoundError('ALERT_KIND_NOT_FOUND', { kind });
  }
  return kind as AdminAlertKind;
};

export async function getAlertSubscriptions(actor: {
  actorId: UserId;
  actorRole: Role;
}): Promise<{ items: AdminAlertSubscriptionDto[] }> {
  const muted = await prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
    return mutedOf(db, Number(actor.actorId));
  });

  return {
    items: alertKindsOf(actor.actorRole).map((kind) => ({ kind, subscribed: !muted.has(kind) })),
  };
}

// turns a kind on (subscribed) or off for the actor; done already is no matter
export async function setAlertSubscription(args: {
  actorId: UserId;
  actorRole: Role;
  kind: string;
  subscribed: boolean;
}): Promise<AdminAlertSubscriptionDto> {
  const kind = assertKind(args.kind, args.actorRole);
  const userId = Number(args.actorId);

  await prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    if (args.subscribed) {
      await db.adminAlertMute.deleteMany({ where: { userId, kind } });
    } else {
      await db.adminAlertMute.createMany({ data: [{ userId, kind }], skipDuplicates: true });
    }
  });

  return { kind, subscribed: args.subscribed };
}
