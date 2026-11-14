import { BadRequestError, NotFoundError } from '@utils/errors.js';

import {
  SHARE_STATUSES,
  SHARE_UNITS,
  SHARE_WATCH_DAYS,
} from '../../../newsletters/services/helpers/campaignShares.helper.js';

import type { OrderHoldReason } from '@helpers/orderHolds.js';
import type { MoneyRefundPurpose } from '../../../payments/services/helpers/moneyRefunds.helper.js';
import type {
  AdminAlertKind,
  AdminAlertListDto,
  AdminAlertThresholdDto,
  AdminAlertThresholdUnit,
} from 'types/dto/admin.dto.js';
import type { Role } from 'types/user.js';

// the kinds of alerts of each role, the thresholds an admin sets for them and what a threshold
// makes of a kind: the window of its cases and the request to the list of the app that shows
// them. The alert counts its cases in the same window (alerts.service.ts), so its count and the
// total of its list agree

export const ADMIN_ALERT_KINDS = [
  'paid_orders_waiting',
  'shipped_orders_waiting',
  'pickup_not_collected',
  'shipped_without_cost',
  'shipped_without_tracking',
  'out_of_stock',
  'low_stock',
  'products_without_shipping_data',
  'variants_missing_required',
  'products_hidden_from_buyers',
  'expiring_batches',
  'expired_batches',
  'chats_waiting',
  // the money of the payments, each kind of refund apart (each admin follows the ones of their work): the late payments given
  // back, then each kind of refund in transit too long and failed, then the disputes at the bank
  'late_refunds',
  'late_refunds_in_transit',
  'late_refunds_failed',
  'return_refunds_in_transit',
  'return_refunds_failed',
  'dispute_refunds_in_transit',
  'disputes_to_answer',
  'disputes_lost',
  'returns_manual_check',
  'returns_proof_waiting',
  'returns_goods_not_sent',
  'returns_money_late',
  'returns_goods_late',
  'worker_stalled',
  'shop_settings_incomplete',
  'shop_locale_missing',
] as const satisfies readonly AdminAlertKind[];

// the kinds of the newsletters: root sees them, and so does an admin root allowed to run the
// newsletters (the right is asked of the database at every request, never read from the token)
export const NEWSLETTER_ALERT_KINDS = [
  'newsletter_undelivered',
  'newsletter_rejected',
  'newsletter_complaints',
  'newsletter_running_long',
  'newsletter_starting_soon',
  'newsletter_cancelled_by_limit',
  'newsletter_sending_halted',
] as const satisfies readonly AdminAlertKind[];

// the kinds of the money that root decides on, and so does an admin root allowed to handle the money
// (a refund made by hand to explain, to tie to a statement, an order not sent part of which came back
// by hand to decide on, the checks of a payment the provider asks for; each follows them for
// themselves, a case goes for all of them once one acts)
export const MONEY_ALERT_KINDS = [
  // the refunds made by hand in transit too long and failed, the compensations of the app the same,
  // the refusal of the rest after a dispute lost (root and a
  // money admin send them another way)
  'hand_refunds_in_transit',
  'hand_refunds_failed',
  'compensation_refunds_in_transit',
  'compensation_refunds_failed',
  'dispute_refunds_failed',
  // what a bank took for a dispute lost on an order sent waits for the decision, a statement
  // whose money does not fit in what is left of the payment, money already with the buyer for goods
  // no statement owes any more
  'bank_money_to_decide',
  'returns_money_short',
  'returns_money_overpaid',
  'hand_refunds_to_explain',
  'hand_refunds_to_decide',
  'fraud_warnings',
  'fraud_warnings_shipped',
  'payment_reviews',
] as const satisfies readonly AdminAlertKind[];

// the kinds of root alone: the actions of the admins
export const ROOT_ALERT_KINDS = ['admin_actions'] as const satisfies readonly AdminAlertKind[];

// the rights of an admin that open kinds of their own, as the database says them at the request
export type AlertRights = { newsletters: boolean; money: boolean };

// the kinds of a role in the order they are told: those of every admin, the newsletters (for root,
// and for an admin who may run them), the money (for root, and for an admin who may handle it), those
// of root. Nobody but root and an admin can have a kind of a right, whatever `rights` says
export const alertKindsOf = (role: Role, rights: AlertRights): AdminAlertKind[] => [
  ...ADMIN_ALERT_KINDS,
  ...(role === 'ROOT' || (role === 'ADMIN' && rights.newsletters) ? NEWSLETTER_ALERT_KINDS : []),
  ...(role === 'ROOT' || (role === 'ADMIN' && rights.money) ? MONEY_ALERT_KINDS : []),
  ...(role === 'ROOT' ? ROOT_ALERT_KINDS : []),
];

type ThresholdSpec = { unit: AdminAlertThresholdUnit; default: number; min: number; max: number };

// the kinds an admin sets a threshold for, with the one the server gives until they do; the
// other kinds have none: every paid order, every product with no free units waits
const THRESHOLDS: Partial<Record<AdminAlertKind, ThresholdSpec>> = {
  // sent by hand and not delivered for so many days
  shipped_orders_waiting: { unit: 'days', default: 14, min: 1, max: 365 },
  // a pickup ready and not collected for so many days
  pickup_not_collected: { unit: 'days', default: 7, min: 1, max: 365 },
  // a send the shop owes something for, whose cost is not written for so many days
  shipped_without_cost: { unit: 'days', default: 3, min: 1, max: 365 },
  // an order shipped by hand, whose send has no tracking number, for so many days
  shipped_without_tracking: { unit: 'days', default: 2, min: 1, max: 365 },
  // statements: the proof of the parcel is told and the shop has not confirmed it for so many days
  returns_proof_waiting: { unit: 'days', default: 2, min: 1, max: 365 },
  // statements: the buyer told nothing of the parcel and the goods are not in, so many days after
  // the statement (14 to send and a week on the road)
  returns_goods_not_sent: { unit: 'days', default: 21, min: 1, max: 365 },
  // statements: the money is due (the goods are in, or the proof confirmed) and not back, so many
  // days after the statement
  returns_money_late: { unit: 'days', default: 10, min: 1, max: 365 },
  // statements: the money went back and the goods are not in, so many days after it
  returns_goods_late: { unit: 'days', default: 14, min: 1, max: 365 },
  // at most so many free units
  low_stock: { unit: 'units', default: 5, min: 1, max: 100_000 },
  // the last good day of a batch within so many days
  expiring_batches: { unit: 'days', default: 7, min: 1, max: 365 },
  // the refunds of late payments that came to their state in so many last days
  late_refunds: { unit: 'days', default: 7, min: 1, max: 365 },
  // a refund of each kind asked so many days ago whose money was not told sent or failed
  late_refunds_in_transit: { unit: 'days', default: 3, min: 1, max: 365 },
  return_refunds_in_transit: { unit: 'days', default: 3, min: 1, max: 365 },
  hand_refunds_in_transit: { unit: 'days', default: 3, min: 1, max: 365 },
  compensation_refunds_in_transit: { unit: 'days', default: 3, min: 1, max: 365 },
  dispute_refunds_in_transit: { unit: 'days', default: 3, min: 1, max: 365 },
  // the disputes lost in so many last days
  disputes_lost: { unit: 'days', default: 7, min: 1, max: 365 },
  // root: the orders sent the provider warned of fraud in so many last days
  fraud_warnings_shipped: { unit: 'days', default: 7, min: 1, max: 365 },
  // a worker that has not run for so many seconds; it runs every few seconds
  worker_stalled: { unit: 'seconds', default: 180, min: 60, max: 86_400 },
  // root: the lines the admins wrote in so many last hours
  admin_actions: { unit: 'hours', default: 24, min: 1, max: 720 },
  // the newsletters: a campaign whose mails did not arrive or were not taken by the provider, over so
  // many per cent (whole numbers: the least a share can be set to is 1%)
  newsletter_undelivered: { unit: 'percent', default: 5, min: 1, max: SHARE_UNITS.undelivered.max },
  newsletter_rejected: { unit: 'percent', default: 5, min: 1, max: SHARE_UNITS.rejected.max },
  // ...or complained of, over so many in a thousand (per mille): a complaint is rare, the mail
  // providers judge a sender by a few in a thousand, and a whole per cent would be far too coarse
  newsletter_complaints: { unit: 'permille', default: 3, min: 1, max: SHARE_UNITS.complaints.max },
  // a campaign that has been going out for so many days
  newsletter_running_long: { unit: 'days', default: 3, min: 1, max: 365 },
  // a campaign scheduled to start within so many hours
  newsletter_starting_soon: { unit: 'hours', default: 24, min: 1, max: 720 },
  // a campaign the limit of the campaigns called off, in the last so many days
  newsletter_cancelled_by_limit: { unit: 'days', default: 7, min: 1, max: 365 },
};

// the threshold of a kind: the one the admin set (custom) or the one the server gives; null for
// a kind without one
export function thresholdOf(
  kind: AdminAlertKind,
  custom: number | null,
): AdminAlertThresholdDto | null {
  const spec = THRESHOLDS[kind];
  if (!spec) return null;

  return {
    value: custom ?? spec.default,
    default: spec.default,
    min: spec.min,
    max: spec.max,
    unit: spec.unit,
    custom: custom !== null,
  };
}

// a threshold an admin sets for a kind: one the kind has, within its bounds
export function assertThreshold(kind: AdminAlertKind, value: number): void {
  const spec = THRESHOLDS[kind];
  if (!spec) throw new NotFoundError('ALERT_THRESHOLD_NOT_FOUND', { kind });

  if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
    throw new BadRequestError('ALERT_THRESHOLD_INVALID', { min: spec.min, max: spec.max });
  }
}

// the window of the cases of a kind a threshold makes: changed before a time, written since one,
// a last good day not later than one, at most some free units, a time before which a campaign
// starts, the per cent a share of mails is over (the complaints: the thousandths)
export type AlertWindow = {
  before?: Date;
  since?: Date;
  until?: Date;
  percent?: number;
  permille?: number;
  expiresBy?: string;
  units?: number;
  // the days of a statement of return (the filters of the list of the statements count in days)
  days?: number;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// the day so many days after a day of the calendar (yyyy-mm-dd)
const dayAfter = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// now by the clock of the app, today the day of the shop (shopToday)
export function alertWindowOf(
  kind: AdminAlertKind,
  threshold: number | null,
  now: number,
  today: string,
): AlertWindow {
  if (threshold === null) return {};

  switch (kind) {
    case 'shipped_orders_waiting':
    case 'pickup_not_collected':
    case 'shipped_without_cost':
    case 'shipped_without_tracking':
      return { before: new Date(now - threshold * DAY) };
    case 'returns_proof_waiting':
    case 'returns_goods_not_sent':
    case 'returns_money_late':
    case 'returns_goods_late':
      return { days: threshold };
    case 'low_stock':
      return { units: threshold };
    case 'expiring_batches':
      return { expiresBy: dayAfter(today, threshold) };
    case 'late_refunds':
    case 'disputes_lost':
    case 'fraud_warnings_shipped':
      return { since: new Date(now - threshold * DAY) };
    case 'late_refunds_in_transit':
    case 'return_refunds_in_transit':
    case 'hand_refunds_in_transit':
    case 'compensation_refunds_in_transit':
    case 'dispute_refunds_in_transit':
      return { before: new Date(now - threshold * DAY) };
    case 'admin_actions':
      return { since: new Date(now - threshold * HOUR) };
    // the shares are watched for SHARE_WATCH_DAYS after a campaign started
    case 'newsletter_undelivered':
    case 'newsletter_rejected':
      return { since: new Date(now - SHARE_WATCH_DAYS * DAY), percent: threshold };
    case 'newsletter_complaints':
      return { since: new Date(now - SHARE_WATCH_DAYS * DAY), permille: threshold };
    // the campaigns the limit called off in the last days
    case 'newsletter_cancelled_by_limit':
      return { since: new Date(now - threshold * DAY) };
    case 'newsletter_running_long':
      return { before: new Date(now - threshold * DAY) };
    case 'newsletter_starting_soon':
      return { until: new Date(now + threshold * HOUR) };
    default:
      return {};
  }
}

const isoOf = (date: Date | undefined) => (date ?? new Date(0)).toISOString();

const CAMPAIGNS_PATH = '/api/newsletters/campaigns';
const REFUNDS_PATH = '/api/payments/refunds';
const DISPUTES_PATH = '/api/payments/disputes';

// the kinds of each refund in transit too long and failed, with the purpose of their refunds in the
// list of the refunds of the money journal
export const REFUND_ALERT_PURPOSES = {
  late_refunds_in_transit: 'late_payment',
  late_refunds_failed: 'late_payment',
  return_refunds_in_transit: 'return',
  return_refunds_failed: 'return',
  hand_refunds_in_transit: 'hand',
  hand_refunds_failed: 'hand',
  compensation_refunds_in_transit: 'compensation',
  compensation_refunds_failed: 'compensation',
  dispute_refunds_in_transit: 'dispute_remainder',
  dispute_refunds_failed: 'dispute_remainder',
} as const satisfies Partial<Record<AdminAlertKind, MoneyRefundPurpose>>;

// the paid orders root decides on, with what holds them
export const HELD_ORDER_ALERTS = {
  hand_refunds_to_decide: 'hand_refund',
  fraud_warnings: 'fraud_warning',
  payment_reviews: 'payment_review',
} as const satisfies Partial<Record<AdminAlertKind, OrderHoldReason>>;

// the paid orders held for the reason, the order paid first first: the buyer waits since they paid
// (each row names since when the hold waits, holds[].since)
const heldOrders = (reason: OrderHoldReason): AdminAlertListDto => ({
  path: '/api/orders',
  query: { statuses: 'paid', holds: reason, sortBy: 'paidAt', sortDir: 'asc' },
});

// the request to the list of the app with the cases of a kind, the most urgent first; the
// frontend adds a limit, its own sort or a filter of its rows. The stop of the worker and the stop of
// the sending worker have none
export function alertListOf(kind: AdminAlertKind, window: AlertWindow): AdminAlertListDto | null {
  switch (kind) {
    // an order held from its sending waits for the bank or for root, not for the shop to send it
    case 'paid_orders_waiting':
      return {
        path: '/api/orders',
        query: { statuses: 'paid', holds: 'none', sortBy: 'paidAt', sortDir: 'asc' },
      };
    case 'shipped_orders_waiting':
      return {
        path: '/api/orders',
        query: {
          statuses: 'shipped',
          deliveryMethod: 'manual',
          updatedTo: isoOf(window.before),
          sortBy: 'updatedAt',
          sortDir: 'asc',
        },
      };
    case 'pickup_not_collected':
      return {
        path: '/api/orders',
        query: {
          statuses: 'shipped',
          deliveryMethod: 'pickup',
          updatedTo: isoOf(window.before),
          sortBy: 'updatedAt',
          sortDir: 'asc',
        },
      };
    case 'shipped_without_cost':
      return {
        path: '/api/orders',
        query: {
          shippingCostMissing: 'true',
          shippedTo: isoOf(window.before),
          sortBy: 'shippingCostMissingSince',
          sortDir: 'asc',
        },
      };
    case 'shipped_without_tracking':
      return {
        path: '/api/orders',
        query: {
          shippedWithoutNumber: 'true',
          shippedTo: isoOf(window.before),
          sortBy: 'updatedAt',
          sortDir: 'asc',
        },
      };
    // the refunds of the money journal: the list counts them with the same filters
    // (moneyRefunds.helper.ts is the rule of its rows), those asked before the days of the threshold
    // and not told sent, and the failures that wait for the shop
    case 'late_refunds':
      return { path: REFUNDS_PATH, query: { purpose: 'late_payment', from: isoOf(window.since) } };
    case 'late_refunds_in_transit':
    case 'return_refunds_in_transit':
    case 'hand_refunds_in_transit':
    case 'compensation_refunds_in_transit':
    case 'dispute_refunds_in_transit':
      return {
        path: REFUNDS_PATH,
        query: {
          purpose: REFUND_ALERT_PURPOSES[kind],
          state: 'in_transit',
          to: isoOf(window.before),
        },
      };
    case 'late_refunds_failed':
    case 'return_refunds_failed':
    case 'hand_refunds_failed':
    case 'compensation_refunds_failed':
    case 'dispute_refunds_failed':
      return {
        path: REFUNDS_PATH,
        query: { purpose: REFUND_ALERT_PURPOSES[kind], state: 'failed' },
      };
    // root: the refunds made by hand that wait for root to say what they were for
    case 'hand_refunds_to_explain':
      return {
        path: REFUNDS_PATH,
        query: { purpose: 'hand', state: 'unassigned', need: 'explain' },
      };
    // root: the paid orders held for what root decides on, or until the review of the provider ends
    case 'hand_refunds_to_decide':
    case 'fraud_warnings':
    case 'payment_reviews':
      return heldOrders(HELD_ORDER_ALERTS[kind]);
    // root: the orders sent the provider warned of (newest orders first, the default of the list)
    case 'fraud_warnings_shipped':
      return { path: '/api/orders', query: { fraudWarnedFrom: isoOf(window.since) } };
    // the disputes and the inquiries of the bank: the list puts the nearest date due first and marks
    // the ones of an order with an open statement (returnOpen)
    case 'disputes_to_answer':
      return { path: DISPUTES_PATH, query: { toAnswer: 'true' } };
    case 'disputes_lost':
      return { path: DISPUTES_PATH, query: { status: 'lost', closedFrom: isoOf(window.since) } };
    // root: what a bank took for a dispute lost waits for the decision of what it was for
    case 'bank_money_to_decide':
      return { path: DISPUTES_PATH, query: { status: 'lost', moneyUndecided: 'true' } };
    // root: the statements whose money does not fit in the payment, and the ones of an order whose
    // money already with the buyer gave more than its statements took
    case 'returns_money_short':
      return { path: '/api/returns', query: { state: 'open', moneyShort: 'true' } };
    case 'returns_money_overpaid':
      return { path: '/api/returns', query: { state: 'closed', moneyOverpaid: 'true' } };
    // the cases of the statements of return are statements: the list of the statements counts
    // them with the same filters (returnFilters.helper.ts)
    case 'returns_manual_check':
      return {
        path: '/api/returns',
        query: {
          state: 'open',
          source: 'form_manual',
          accepted: 'false',
          sortBy: 'statedAt',
          sortDir: 'asc',
        },
      };
    case 'returns_proof_waiting':
      return {
        path: '/api/returns',
        query: {
          state: 'open',
          goods: 'proof_provided',
          proofOlderThanDays: String(window.days ?? 0),
          sortBy: 'statedAt',
          sortDir: 'asc',
        },
      };
    case 'returns_goods_not_sent':
      return {
        path: '/api/returns',
        query: {
          state: 'open',
          goods: 'waiting_no_proof',
          olderThanDays: String(window.days ?? 0),
          sortBy: 'statedAt',
          sortDir: 'asc',
        },
      };
    // the money held by a dispute of the payment or by a refund made by hand that waits for root is
    // not late for the shop: the bank or root acts on it
    case 'returns_money_late':
      return {
        path: '/api/returns',
        query: {
          state: 'open',
          moneyDueForDays: String(window.days ?? 0),
          moneyHeld: 'false',
          sortBy: 'statedAt',
          sortDir: 'asc',
        },
      };
    case 'returns_goods_late':
      return {
        path: '/api/returns',
        query: {
          state: 'open',
          paidAheadForDays: String(window.days ?? 0),
          sortBy: 'statedAt',
          sortDir: 'asc',
        },
      };
    // the cases of the alerts of the variants (the stock, the shipping data, the required
    // characteristics) are variants: each variant has a row of its own in the list (group=false),
    // the alert counts what its list shows
    case 'out_of_stock':
      return {
        path: '/api/products',
        query: { maxStock: '0', group: 'false', sort: 'popularity', order: 'desc' },
      };
    case 'low_stock':
      return {
        path: '/api/products',
        query: {
          inStock: 'true',
          maxStock: String(window.units ?? 0),
          group: 'false',
          sort: 'stock',
          order: 'asc',
        },
      };
    case 'products_without_shipping_data':
      return {
        path: '/api/products',
        query: { withoutShippingData: 'true', group: 'false', sort: 'popularity', order: 'desc' },
      };
    case 'variants_missing_required':
      return {
        path: '/api/products',
        query: { missingRequired: 'true', group: 'false', sort: 'popularity', order: 'desc' },
      };
    // the cases are products, the rows of the list are products (a filter of a product leaves them
    // so), so the total of the list is the count of the alert
    case 'products_hidden_from_buyers':
      return {
        path: '/api/products',
        query: { hiddenFromBuyers: 'true', sort: 'popularity', order: 'desc' },
      };
    case 'expiring_batches':
      return {
        path: '/api/admin/stock/batches',
        query: {
          inStock: 'true',
          expired: 'false',
          expiresBy: window.expiresBy ?? '',
          sortBy: 'expiresAt',
          sortOrder: 'asc',
        },
      };
    case 'expired_batches':
      return {
        path: '/api/admin/stock/batches',
        query: { inStock: 'true', expired: 'true', sortBy: 'expiresAt', sortOrder: 'asc' },
      };
    case 'chats_waiting':
      return { path: '/api/chat/admin/threads', query: { queue: 'unread' } };
    case 'worker_stalled':
      return null;
    // the fields of the data of the shop root has not set yet (missingShopSettingsFields): the
    // list names them, its length is the count of the alert; root fills them in with
    // PUT /api/root/shop-settings
    case 'shop_settings_incomplete':
      return { path: '/api/admin/shop-settings/missing', query: {} };
    // the language of the shop (shopLocale) has no dictionary any more (src/locales): a deploy
    // that dropped a file after root set the language, not a list of rows either
    case 'shop_locale_missing':
      return null;
    case 'admin_actions':
      return {
        path: '/api/admin/audit-log',
        query: { actorRole: 'ADMIN', from: isoOf(window.since) },
      };
    // the cases of the newsletters are campaigns: the list of the campaigns counts them with the
    // same filters (campaignShares.helper.ts is the rule of the shares)
    case 'newsletter_undelivered':
      return {
        path: CAMPAIGNS_PATH,
        query: {
          status: SHARE_STATUSES.join(','),
          startedFrom: isoOf(window.since),
          undeliveredOver: String(window.percent ?? 0),
        },
      };
    case 'newsletter_rejected':
      return {
        path: CAMPAIGNS_PATH,
        query: {
          status: SHARE_STATUSES.join(','),
          startedFrom: isoOf(window.since),
          rejectedOver: String(window.percent ?? 0),
        },
      };
    case 'newsletter_complaints':
      return {
        path: CAMPAIGNS_PATH,
        query: {
          status: SHARE_STATUSES.join(','),
          startedFrom: isoOf(window.since),
          complaintsOver: String(window.permille ?? 0),
        },
      };
    case 'newsletter_running_long':
      return {
        path: CAMPAIGNS_PATH,
        query: { status: 'sending', startedTo: isoOf(window.before) },
      };
    case 'newsletter_starting_soon':
      return {
        path: CAMPAIGNS_PATH,
        query: { status: 'scheduled', scheduledTo: isoOf(window.until) },
      };
    case 'newsletter_cancelled_by_limit':
      return {
        path: CAMPAIGNS_PATH,
        query: { status: 'cancelled', cancelReason: 'limit', cancelledFrom: isoOf(window.since) },
      };
    // the stop of the sending worker is one state, not a list of rows
    case 'newsletter_sending_halted':
      return null;
  }
}

// the worker is pulsing when it ran within the seconds of the threshold; one that started and
// never ran, or ran long ago, has stopped. A server that never started it (the tests) has no
// worker to stop
export function workerStalled(
  state: { startedAt: Date | null; lastRunAt: Date | null },
  stallSeconds: number,
  now = Date.now(),
): boolean {
  if (!state.startedAt) return false;
  const last = state.lastRunAt ?? state.startedAt;
  return now - last.getTime() > stallSeconds * 1000;
}
