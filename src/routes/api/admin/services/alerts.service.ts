import { Prisma } from '@prisma/client';

import { isAvailableLocale } from '@config/locales.js';
import { missingShopSettingsFields, shopSettings } from '@config/shopSettings.js';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { askMoneyManager, isMoneyManager } from '@db/moneyManager.helper.js';
import { askNewsletterManager, isNewsletterManager } from '@db/newsletterManager.helper.js';
import { shopToday } from '@helpers/shopDay.js';
import { NotFoundError } from '@utils/errors.js';
import { orderTimeoutWorkerState } from '../../../../workers/orderTimeout.worker.js';
import {
  FREE_STOCK_SQL,
  visibleSql,
} from '../../products/services/helpers/getAllProducts.helper.js';
import {
  SHARE_STATUSES,
  shareCondition,
  type CampaignShare,
} from '../../newsletters/services/helpers/campaignShares.helper.js';
import { readSendingHalt } from '../../newsletters/services/helpers/sendingHalt.helper.js';
import { andOf, returnConditions } from '../../returns/services/helpers/returnFilters.helper.js';
import {
  MONEY_REFUNDS,
  moneyRefundConditions,
  type MoneyRefundFilters,
} from '../../payments/services/helpers/moneyRefunds.helper.js';
import { disputeConditions } from '../../payments/services/listDisputes.service.js';
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
  type AlertRights,
  alertListOf,
  alertWindowOf,
  assertThreshold,
  HELD_ORDER_ALERTS,
  REFUND_ALERT_PURPOSES,
  thresholdOf,
  workerStalled,
  type AlertWindow,
} from './helpers/alertKinds.helper.js';

import type { OrderHoldReason } from '@helpers/orderHolds.js';

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
// threshold (admin_alert_settings), and puts single cases aside (in redis). The cases of the
// stock are variants (a product with three variants out of stock is three cases). The kinds of the
// newsletters (their cases are campaigns, but for the stop of the sending worker, which is one state
// the pass writes in redis) are of root and of the admins root allowed to run the newsletters: the
// right is asked of the database in every call, so an admin who lost it stops seeing, counting and
// setting these kinds at once, and one who got it starts

type Db = Prisma.TransactionClient;
type Actor = { actorId: UserId; actorRole: Role };

// the kinds whose cases have an id an admin can put aside: all but the stop of the worker, the
// empty fields of the data of the shop, its missing dictionary and the stop of the sending worker of
// the newsletters, which are a single state, not a list of rows
type CaseKind = Exclude<
  AdminAlertKind,
  | 'worker_stalled'
  | 'shop_settings_incomplete'
  | 'shop_locale_missing'
  | 'newsletter_sending_halted'
>;

const SINGLE_STATE_KINDS = new Set<AdminAlertKind>([
  'worker_stalled',
  'shop_settings_incomplete',
  'shop_locale_missing',
  'newsletter_sending_halted',
]);

const isCaseKind = (kind: AdminAlertKind): kind is CaseKind => !SINGLE_STATE_KINDS.has(kind);

// the cases of a kind: the rows they are read from (t, t.id the id of a case) and the ones that
// wait, in the window of the threshold; the same conditions as the filters of the list the
// alert names (alertListOf)
type Cases = { from: Prisma.Sql; where: Prisma.Sql };

const ORDERS = Prisma.sql`from cartlify.orders as t`;
const RETURNS = Prisma.sql`from cartlify.returns as t`;
const BATCHES = Prisma.sql`from cartlify.product_batches as t`;
const LOG = Prisma.sql`from cartlify.admin_audit_log as t`;
// the variants of the products of the catalog with their free units, the number the catalog shows
// as stock. A case is a variant: t.id is its id. A variant taken out of sale is none of the cases
// of the kinds that count variants (the stock and the shipping data); its batches still are cases
// of the kinds that count batches
const VARIANTS = Prisma.sql`from (
    select v.id, v."deletedAt", v."weightGrams", v."lengthMm", ${FREE_STOCK_SQL} as free
    from cartlify.product_variants as v
    join cartlify.products as p on p.id = v."productId"
    where p."deletedAt" is null
  ) as t`;

// the variants that lack a characteristic their category requires: the view of the database is the
// one place of the rule, the admin list (missingRequired) reads it too. A case is a variant: t.id is
// its id, whatever number of characteristics it lacks
const MISSING_REQUIRED = Prisma.sql`from (
    select distinct m.variant_id as id from cartlify.variants_missing_required as m
  ) as t`;
// the products of the catalog a buyer sees none of the variants of: no variant that is alive and
// shows a picture (the rule of the list of a buyer, visibleSql). A product removed from the catalog
// is none of them: it was removed on purpose. A case is a product: t.id is its id
const HIDDEN_PRODUCTS = Prisma.sql`from cartlify.products as t`;

// the campaigns of the newsletters; the alerts of the shares watch the campaigns that go out and the
// ones that started in the window (campaignShares.helper.ts is the rule of the shares, the list of
// the campaigns reads it too)
const CAMPAIGNS = Prisma.sql`from cartlify.newsletter_campaigns as t`;

// the share of the complaints is told in thousandths (window.permille), the others in per cent
const sharedCases =
  (share: CampaignShare) =>
  (window: AlertWindow): Cases => ({
    from: CAMPAIGNS,
    where: Prisma.sql`t.status = any(${[...SHARE_STATUSES]}::cartlify."NewsletterCampaignStatus"[])
      and t."startedAt" >= ${utcTime(window.since ?? new Date(0))}
      and ${shareCondition(share, (share === 'complaints' ? window.permille : window.percent) ?? 0)}`,
  });

// the order is delivered by the method: the delivery row of the order says it
const deliveryMethodIs = (method: 'manual' | 'pickup') => Prisma.sql`exists (
    select 1 from cartlify.order_deliveries d
    where d."orderId" = t.id and d.method = ${method}::cartlify."DeliveryMethod"
  )`;

// the cases of a kind about the statements of return: the statements of the filters of the list
const returnCases = (filters: Parameters<typeof returnConditions>[0]): Cases => ({
  from: RETURNS,
  where: andOf(returnConditions(filters, 't', Date.now())),
});

// the cases of a kind about the refunds of the money journal: the refunds of the filters of their list
// (a case is a refund: t.id is its first line). Every kind reads all the refunds, so they are counted
// in one pass over them
const REFUNDS = Prisma.sql`from ${MONEY_REFUNDS} as t`;
const refundCases = (filters: MoneyRefundFilters): Cases => ({
  from: REFUNDS,
  where: moneyRefundConditions(filters),
});

// the refunds of a kind asked before the time and not told sent, and its failures that wait for the
// shop
const refundsInTransit = (kind: keyof typeof REFUND_ALERT_PURPOSES) => (window: AlertWindow) =>
  refundCases({
    purpose: REFUND_ALERT_PURPOSES[kind],
    state: 'in_transit',
    to: window.before ?? new Date(0),
  });
const refundsFailed = (kind: keyof typeof REFUND_ALERT_PURPOSES) => () =>
  refundCases({ purpose: REFUND_ALERT_PURPOSES[kind], state: 'failed' });

// the cases of a kind about the disputes: the disputes of the filters of their list (a case is a
// dispute: t.id is its id)
const disputeCases = (filters: Parameters<typeof disputeConditions>[0]): Cases => ({
  from: Prisma.sql`from cartlify.payment_disputes as t`,
  where: disputeConditions(filters, 't'),
});

// the paid orders something of the reason holds from their sending, the filters holds and statuses
// of the list of orders (an element of the list holds with the reason)
const holdOf = (reason: OrderHoldReason) =>
  Prisma.sql`t.holds @> ${JSON.stringify([{ reason }])}::jsonb`;
const heldOrders = (kind: keyof typeof HELD_ORDER_ALERTS) => (): Cases => ({
  from: ORDERS,
  where: Prisma.sql`t.status = 'paid'::cartlify."OrderStatus" and ${holdOf(HELD_ORDER_ALERTS[kind])}`,
});

const CASES: Record<CaseKind, (window: AlertWindow) => Cases> = {
  // paid, to be shipped: nothing holds it (a dispute, a refund made by hand, a check of the payment
  // waits for the bank or for root; the filter holds=none of the list of orders)
  paid_orders_waiting: () => ({
    from: ORDERS,
    where: Prisma.sql`t.status = 'paid'::cartlify."OrderStatus" and t.holds = '[]'::jsonb`,
  }),
  // sent by hand long ago and not delivered yet
  shipped_orders_waiting: (window) => ({
    from: ORDERS,
    where: Prisma.sql`t.status = 'shipped'::cartlify."OrderStatus"
      and t."updatedAt" < ${utcTime(window.before ?? new Date(0))}
      and ${deliveryMethodIs('manual')}`,
  }),
  // a pickup ready long ago and not collected yet
  pickup_not_collected: (window) => ({
    from: ORDERS,
    where: Prisma.sql`t.status = 'shipped'::cartlify."OrderStatus"
      and t."updatedAt" < ${utcTime(window.before ?? new Date(0))}
      and ${deliveryMethodIs('pickup')}`,
  }),
  // orders with a send the shop owes something for, sent long ago, whose cost is not written: no
  // line of the money journal of what the shop pays the carrier names the send (the filters
  // shippingCostMissing and shippedTo of the list of orders)
  shipped_without_cost: (window) => ({
    from: ORDERS,
    where: Prisma.sql`exists (
      select 1 from cartlify.order_shipments s
      where s."orderId" = t.id and s."returnId" is null and s.expense
        and not exists (
          select 1 from cartlify.money_log l
          where l."orderShipmentId" = s.id and l.purpose = 'shipping'::cartlify."MoneyPurpose"
            and l.event <> 'money.received'
        )
        and s."shippedAt" < ${utcTime(window.before ?? new Date(0))}
    )`,
  }),
  // shipped by hand, the send on its way has no tracking number and was sent so many days ago
  // (the filters shippedWithoutNumber and shippedTo of the list of orders)
  shipped_without_tracking: (window) => ({
    from: ORDERS,
    where: Prisma.sql`t.status = 'shipped'::cartlify."OrderStatus"
      and exists (
        select 1 from cartlify.order_shipments s
        where s."orderId" = t.id and s."returnId" is null and s."rolledBackAt" is null
          and s."trackingNumber" is null
          and s."shippedAt" < ${utcTime(window.before ?? new Date(0))}
      )`,
  }),
  // the refunds of the late payments the shop gave back, that came to their state since the time:
  // the buyer may ask
  late_refunds: (window) =>
    refundCases({ purpose: 'late_payment', from: window.since ?? new Date(0) }),
  // each kind of refund apart: asked before the time and not told sent or failed, and failed while
  // the shop has to act on it (a failure the bank settles waits for the dispute, moneyRefunds.helper.ts)
  late_refunds_in_transit: refundsInTransit('late_refunds_in_transit'),
  late_refunds_failed: refundsFailed('late_refunds_failed'),
  return_refunds_in_transit: refundsInTransit('return_refunds_in_transit'),
  return_refunds_failed: refundsFailed('return_refunds_failed'),
  hand_refunds_in_transit: refundsInTransit('hand_refunds_in_transit'),
  hand_refunds_failed: refundsFailed('hand_refunds_failed'),
  compensation_refunds_in_transit: refundsInTransit('compensation_refunds_in_transit'),
  compensation_refunds_failed: refundsFailed('compensation_refunds_failed'),
  dispute_refunds_in_transit: refundsInTransit('dispute_refunds_in_transit'),
  dispute_refunds_failed: refundsFailed('dispute_refunds_failed'),
  // the disputes and inquiries of the bank open with no evidence submitted, and the ones lost since
  // the time
  disputes_to_answer: () => disputeCases({ toAnswer: true }),
  disputes_lost: (window) =>
    disputeCases({ statuses: ['lost'], closedFrom: window.since ?? new Date(0) }),
  // root: what a bank took for a dispute lost waits for the decision of what it was for
  bank_money_to_decide: () => disputeCases({ statuses: ['lost'], moneyUndecided: true }),
  // root: the statements whose money does not fit in what is left of the payment, and the ones of an
  // order whose money already with the buyer gave more than its statements took
  returns_money_short: () => returnCases({ state: 'open', moneyShort: true }),
  returns_money_overpaid: () => returnCases({ state: 'closed', moneyOverpaid: true }),
  // statements of return: the same conditions as the filters of the list of the statements
  returns_manual_check: () =>
    returnCases({ state: 'open', source: 'form_manual', accepted: false }),
  returns_proof_waiting: (window) =>
    returnCases({
      state: 'open',
      goods: 'proof_provided',
      proofOlderThanDays: window.days ?? 0,
    }),
  returns_goods_not_sent: (window) =>
    returnCases({ state: 'open', goods: 'waiting_no_proof', olderThanDays: window.days ?? 0 }),
  returns_money_late: (window) =>
    returnCases({ state: 'open', moneyDueForDays: window.days ?? 0, moneyHeld: false }),
  returns_goods_late: (window) =>
    returnCases({ state: 'open', paidAheadForDays: window.days ?? 0 }),
  // variants of the catalog with no free units
  out_of_stock: () => ({
    from: VARIANTS,
    where: Prisma.sql`t."deletedAt" is null and t.free = 0`,
  }),
  // variants of the catalog with few free units
  low_stock: (window) => ({
    from: VARIANTS,
    where: Prisma.sql`t."deletedAt" is null and t.free >= 1 and t.free <= ${window.units ?? 0}`,
  }),
  // variants of the catalog that lack the weight or the sizes (the sizes come all three or none)
  products_without_shipping_data: () => ({
    from: VARIANTS,
    where: Prisma.sql`t."deletedAt" is null and (t."weightGrams" is null or t."lengthMm" is null)`,
  }),
  // variants that lack a value of a characteristic their category requires
  variants_missing_required: () => ({
    from: MISSING_REQUIRED,
    where: Prisma.sql`true`,
  }),
  // products of the catalog none of whose variants a buyer sees
  products_hidden_from_buyers: () => ({
    from: HIDDEN_PRODUCTS,
    where: Prisma.sql`t."deletedAt" is null and not exists (
      select 1 from cartlify.product_variants as hv
      where hv."productId" = t.id and ${visibleSql('hv')}
    )`,
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
  // the newsletters: campaigns whose mails did not arrive, were not taken or were complained of
  newsletter_undelivered: sharedCases('undelivered'),
  newsletter_rejected: sharedCases('rejected'),
  newsletter_complaints: sharedCases('complaints'),
  // a campaign that goes out and started before the time
  newsletter_running_long: (window) => ({
    from: CAMPAIGNS,
    where: Prisma.sql`t.status = 'sending'::cartlify."NewsletterCampaignStatus"
      and t."startedAt" < ${utcTime(window.before ?? new Date(0))}`,
  }),
  // a campaign scheduled to start before the time, one whose time has passed included: it waits
  newsletter_starting_soon: (window) => ({
    from: CAMPAIGNS,
    where: Prisma.sql`t.status = 'scheduled'::cartlify."NewsletterCampaignStatus"
      and t."scheduledAt" < ${utcTime(window.until ?? new Date(0))}`,
  }),
  // a campaign the limit of the campaigns called off (not a manager), since the time
  newsletter_cancelled_by_limit: (window) => ({
    from: CAMPAIGNS,
    where: Prisma.sql`t.status = 'cancelled'::cartlify."NewsletterCampaignStatus"
      and t."cancelReason" = 'limit'::cartlify."NewsletterCancelReason"
      and t."cancelledAt" >= ${utcTime(window.since ?? new Date(0))}`,
  }),
  // root: the refunds made by hand that wait for root to say what they were for
  hand_refunds_to_explain: () =>
    refundCases({ purpose: 'hand', state: 'unassigned', need: 'explain' }),
  // root: the paid orders held for what root decides on (part of the order came back by hand, an
  // early warning of fraud), or by an open review of the provider
  hand_refunds_to_decide: heldOrders('hand_refunds_to_decide'),
  fraud_warnings: heldOrders('fraud_warnings'),
  payment_reviews: heldOrders('payment_reviews'),
  // root: the orders sent that the provider warned of since the time (the filter fraudWarnedFrom of
  // the list of orders)
  fraud_warnings_shipped: (window) => ({
    from: ORDERS,
    where: Prisma.sql`t."fraudWarnedAt" >= ${utcTime(window.since ?? new Date(0))}`,
  }),
  // root: the lines the admins wrote
  admin_actions: (window) => ({
    from: LOG,
    where: Prisma.sql`t."actorRole" = 'ADMIN'::cartlify."Role"
      and t."createdAt" >= ${utcTime(window.since ?? new Date(0))}`,
  }),
};

type Counted = { count: number; dismissed: number; found: string[] };
type CaseScope = { kind: CaseKind; window: AlertWindow; aside: string[] };

// the rows several kinds count in one pass: the refunds of the money journal, each made from its
// lines, counted with conditions on their columns only (measured, 12.11.2026: one pass is the
// fastest for them; the variants, the batches and the campaigns are faster a query a kind, the
// database narrows their rows by the conditions of the query)
const SHARED_ROWS: ReadonlySet<Prisma.Sql> = new Set([REFUNDS]);

// the cases of the kinds that wait, without the ones put aside (aside: their ids), how many of those
// still wait, and which; one query after the other. The kinds of the shared rows are counted in one
// pass over them, a column of each kind: the rows are made once. Any other kind keeps a query of its
// own: the database narrows its rows, and joins the other tables its conditions ask (exists), only
// for a condition of the query itself, not for a filter of a count
async function countedCasesOf(db: Db, scopes: CaseScope[]): Promise<Map<CaseKind, Counted>> {
  const groups = new Map<
    string,
    { from: Prisma.Sql; kinds: (CaseScope & { where: Prisma.Sql })[] }
  >();
  for (const scope of scopes) {
    const { from, where } = CASES[scope.kind](scope.window);
    const key = SHARED_ROWS.has(from) ? from.sql : scope.kind;
    const group = groups.get(key) ?? { from, kinds: [] };
    group.kinds.push({ ...scope, where });
    groups.set(key, group);
  }

  const counted = new Map<CaseKind, Counted>();
  for (const { from, kinds } of groups.values()) {
    const one = kinds.length === 1 ? kinds[0]!.where : null;
    const columns = kinds.map(({ where, aside }, at) => {
      const isAside = Prisma.sql`t.id::text = any(${aside}::text[])`;
      const of = one ? Prisma.sql`true` : Prisma.sql`(${where})`;
      return Prisma.sql`count(*) filter (where ${of} and not ${isAside}) as ${Prisma.raw(`"count${at}"`)},
        count(*) filter (where ${of} and ${isAside}) as ${Prisma.raw(`"dismissed${at}"`)},
        array_agg(t.id::text) filter (where ${of} and ${isAside}) as ${Prisma.raw(`"found${at}"`)}`;
    });
    const [row] = await db.$queryRaw<Record<string, bigint | string[] | null>[]>(
      Prisma.sql`select ${Prisma.join(columns, ', ')} ${from} where ${one ?? Prisma.sql`true`}`,
    );
    kinds.forEach(({ kind }, at) => {
      counted.set(kind, {
        count: Number(row?.[`count${at}`] ?? 0),
        dismissed: Number(row?.[`dismissed${at}`] ?? 0),
        found: (row?.[`found${at}`] as string[] | null) ?? [],
      });
    });
  }
  return counted;
}

// the same for one kind
async function countedCases(
  db: Db,
  kind: CaseKind,
  window: AlertWindow,
  aside: string[],
): Promise<Counted> {
  return (await countedCasesOf(db, [{ kind, window, aside }])).get(kind)!;
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

// may the actor run the newsletters, and handle the money, and so see the kinds of each? Root always;
// an admin while root allows it (asked now, in the transaction that has the actor's context, one
// question after the other); nobody else. The routes of the alerts are for admins and root, so the
// other roles are no more than a guard
async function rightsOf(db: Db, actor: Actor): Promise<AlertRights> {
  if (actor.actorRole === 'ROOT') return { newsletters: true, money: true };
  if (actor.actorRole !== 'ADMIN') return { newsletters: false, money: false };

  const newsletters = await askNewsletterManager(db);
  const money = await askMoneyManager(db);

  return { newsletters, money };
}

// the same for a call that has no transaction of its own
async function rightsNow(actor: Actor): Promise<AlertRights> {
  if (actor.actorRole === 'ROOT') return { newsletters: true, money: true };
  if (actor.actorRole !== 'ADMIN') return { newsletters: false, money: false };

  const who = { userId: Number(actor.actorId), role: actor.actorRole };
  const newsletters = await isNewsletterManager(who);
  const money = await isMoneyManager(who);

  return { newsletters, money };
}

// the alerts of the actor: every kind of their zone, or only the ones they follow (subscribed), or
// only the kinds named (a kind not counted keeps its marks aside, as one not followed)
export async function getAdminAlerts(
  actor: Actor,
  opts: { subscribed?: boolean | undefined; kinds?: string[] | undefined } = {},
): Promise<GetAdminAlertsResponseDto> {
  const now = Date.now();
  const userId = Number(actor.actorId);
  const dismissals = await readDismissals(userId);
  // the last stop of the sending worker, read before the snapshot of the database (it is in redis)
  const halt = await readSendingHalt();

  const { alerts, kept, countedKinds, kinds } = await prisma.$transaction(
    async (db) => {
      await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
      const settings = await settingsOf(db, userId);
      const kinds = alertKindsOf(actor.actorRole, await rightsOf(db, actor));

      // the kinds told, each with its setting, threshold and window, and the cases of all of them
      const told = kinds
        .map((kind) => ({ kind, setting: settings.get(kind) ?? DEFAULT_SETTING }))
        .filter(({ setting }) => !opts.subscribed || setting.subscribed)
        .filter(({ kind }) => !opts.kinds || opts.kinds.includes(kind))
        .map(({ kind, setting }) => ({ kind, setting, ...scopeOf(kind, setting, now) }));
      const counted = await countedCasesOf(
        db,
        told.flatMap(({ kind, window }) =>
          isCaseKind(kind) ? [{ kind, window, aside: asideOf(dismissals, kind) }] : [],
        ),
      );

      const alerts: AdminAlertDto[] = [];
      // the marks still aside, and the kinds counted: a mark of a kind not counted stays
      const kept = new Set<string>();
      const countedKinds = new Set<string>();
      for (const { kind, setting, threshold, window } of told) {
        let tally: { count: number; dismissed: number };
        if (isCaseKind(kind)) {
          const cases = counted.get(kind)!;
          for (const id of cases.found) kept.add(dismissalFieldOf(kind, id));
          countedKinds.add(kind);
          tally = { count: cases.count, dismissed: cases.dismissed };
        } else if (kind === 'worker_stalled') {
          const stalled = workerStalled(orderTimeoutWorkerState(), threshold ?? 0, now);
          tally = { count: stalled ? 1 : 0, dismissed: 0 };
        } else if (kind === 'newsletter_sending_halted') {
          tally = { count: halt ? 1 : 0, dismissed: 0 };
        } else if (kind === 'shop_locale_missing') {
          tally = { count: isAvailableLocale(shopSettings().shopLocale) ? 0 : 1, dismissed: 0 };
        } else {
          tally = { count: missingShopSettingsFields().length, dismissed: 0 };
        }

        alerts.push({
          kind,
          subscribed: setting.subscribed,
          ...tally,
          threshold,
          list: alertListOf(kind, window),
          occurredAt: kind === 'newsletter_sending_halted' && halt ? halt.at.toISOString() : null,
        });
      }
      return { alerts, kept, countedKinds, kinds };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  );

  if (dismissals) {
    // a kind that is not counted keeps its marks, unless it is not a kind of the actor at all (a
    // kind of the newsletters, once the actor lost the right to run them, is none of theirs)
    const own = new Set<string>(kinds);
    const looked = dismissals.filter(
      (dismissal) => countedKinds.has(dismissal.kind) || !own.has(dismissal.kind),
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

const assertKind = async (kind: string, actor: Actor): Promise<AdminAlertKind> => {
  const kinds: string[] = alertKindsOf(actor.actorRole, await rightsNow(actor));
  if (!kinds.includes(kind)) throw new NotFoundError('ALERT_KIND_NOT_FOUND', { kind });
  return kind as AdminAlertKind;
};

// a kind of the actor whose cases have an id
const assertCaseKind = async (kind: string, actor: Actor): Promise<CaseKind> => {
  const known = await assertKind(kind, actor);
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
  const { settings, kinds } = await prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
    return {
      settings: await settingsOf(db, Number(actor.actorId)),
      kinds: alertKindsOf(actor.actorRole, await rightsOf(db, actor)),
    };
  });

  return {
    items: kinds.map((kind) => subscriptionOf(kind, settings.get(kind) ?? DEFAULT_SETTING)),
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
  const kind = await assertKind(args.kind, args);
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
  const kind = await assertKind(args.kind, args);
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
      const kinds = alertKindsOf(actor.actorRole, await rightsOf(db, actor));

      const scopes = kinds.flatMap((kind) => {
        const aside = asideOf(dismissals, kind);
        if (!isCaseKind(kind) || !aside.length) return [];
        const { window } = scopeOf(kind, settings.get(kind) ?? DEFAULT_SETTING, now);
        return [{ kind, window, aside }];
      });

      const kept = new Set<string>();
      for (const [kind, { found }] of await countedCasesOf(db, scopes)) {
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
  const kind = await assertCaseKind(args.kind, args);
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
