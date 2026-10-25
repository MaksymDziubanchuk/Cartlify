import { BadRequestError, NotFoundError } from '@utils/errors.js';

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
  'out_of_stock',
  'low_stock',
  'expiring_batches',
  'expired_batches',
  'chats_waiting',
  'refunded_payments',
  'worker_stalled',
] as const satisfies readonly AdminAlertKind[];

export const ROOT_ALERT_KINDS = ['admin_actions'] as const satisfies readonly AdminAlertKind[];

export const alertKindsOf = (role: Role): AdminAlertKind[] =>
  role === 'ROOT' ? [...ADMIN_ALERT_KINDS, ...ROOT_ALERT_KINDS] : [...ADMIN_ALERT_KINDS];

type ThresholdSpec = { unit: AdminAlertThresholdUnit; default: number; min: number; max: number };

// the kinds an admin sets a threshold for, with the one the server gives until they do; the
// other kinds have none: every paid order, every product with no free units waits
const THRESHOLDS: Partial<Record<AdminAlertKind, ThresholdSpec>> = {
  // shipped and not delivered for so many days
  shipped_orders_waiting: { unit: 'days', default: 14, min: 1, max: 365 },
  // at most so many free units
  low_stock: { unit: 'units', default: 5, min: 1, max: 100_000 },
  // the last good day of a batch within so many days
  expiring_batches: { unit: 'days', default: 7, min: 1, max: 365 },
  // the refunds of late payments of so many last days
  refunded_payments: { unit: 'days', default: 7, min: 1, max: 365 },
  // a worker that has not run for so many seconds; it runs every few seconds
  worker_stalled: { unit: 'seconds', default: 180, min: 60, max: 86_400 },
  // root: the lines the admins wrote in so many last hours
  admin_actions: { unit: 'hours', default: 24, min: 1, max: 720 },
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
// a last good day not later than one, at most some free units
export type AlertWindow = { before?: Date; since?: Date; expiresBy?: string; units?: number };

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
      return { before: new Date(now - threshold * DAY) };
    case 'low_stock':
      return { units: threshold };
    case 'expiring_batches':
      return { expiresBy: dayAfter(today, threshold) };
    case 'refunded_payments':
      return { since: new Date(now - threshold * DAY) };
    case 'admin_actions':
      return { since: new Date(now - threshold * HOUR) };
    default:
      return {};
  }
}

const isoOf = (date: Date | undefined) => (date ?? new Date(0)).toISOString();

// the request to the list of the app with the cases of a kind, the most urgent first; the
// frontend adds a limit, its own sort or a filter of its rows. The stop of the worker has none
export function alertListOf(kind: AdminAlertKind, window: AlertWindow): AdminAlertListDto | null {
  switch (kind) {
    case 'paid_orders_waiting':
      return {
        path: '/api/orders',
        query: { statuses: 'paid', sortBy: 'paidAt', sortDir: 'asc' },
      };
    case 'shipped_orders_waiting':
      return {
        path: '/api/orders',
        query: {
          statuses: 'shipped',
          updatedTo: isoOf(window.before),
          sortBy: 'updatedAt',
          sortDir: 'asc',
        },
      };
    case 'out_of_stock':
      return {
        path: '/api/products',
        query: { maxStock: '0', sort: 'popularity', order: 'desc' },
      };
    case 'low_stock':
      return {
        path: '/api/products',
        query: {
          inStock: 'true',
          maxStock: String(window.units ?? 0),
          sort: 'stock',
          order: 'asc',
        },
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
    case 'refunded_payments':
      return {
        path: '/api/admin/audit-log',
        query: {
          actions: 'OTHER',
          entityType: 'order',
          field: 'refund',
          from: isoOf(window.since),
        },
      };
    case 'worker_stalled':
      return null;
    case 'admin_actions':
      return {
        path: '/api/admin/audit-log',
        query: { actorRole: 'ADMIN', from: isoOf(window.since) },
      };
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
