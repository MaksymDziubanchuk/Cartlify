import { describe, expect, it } from '@jest/globals';

import {
  ADMIN_ALERT_KINDS,
  alertKindsOf,
  alertListOf,
  alertWindowOf,
  assertThreshold,
  thresholdOf,
  workerStalled,
} from '@routes/api/admin/services/helpers/alertKinds.helper.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

// the kinds of alerts of each role, the thresholds an admin sets for them, the window of the cases
// a threshold gives and the request to the list of the app that shows those cases; the counts
// themselves are read from the database (tests/integration/api/admin/alerts.test.ts)

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const DAY = 86_400_000;

describe('alertKindsOf', () => {
  it('gives an admin the kinds of the work that waits', () => {
    expect(alertKindsOf('ADMIN')).toEqual([...ADMIN_ALERT_KINDS]);
  });

  it('gives root the actions of the admins too', () => {
    expect(alertKindsOf('ROOT')).toEqual([...ADMIN_ALERT_KINDS, 'admin_actions']);
  });
});

describe('workerStalled', () => {
  const ago = (seconds: number) => new Date(NOW - seconds * 1000);

  it('names no stop of a worker that never started', () => {
    expect(workerStalled({ startedAt: null, lastRunAt: null }, 180, NOW)).toBe(false);
  });

  it('names no stop of a worker that ran within the seconds of the threshold', () => {
    expect(workerStalled({ startedAt: ago(3600), lastRunAt: ago(30) }, 180, NOW)).toBe(false);
    expect(workerStalled({ startedAt: ago(3600), lastRunAt: ago(180) }, 180, NOW)).toBe(false);
  });

  it('names a stop of a worker that has not run for longer', () => {
    expect(workerStalled({ startedAt: ago(3600), lastRunAt: ago(181) }, 180, NOW)).toBe(true);
    expect(workerStalled({ startedAt: ago(3600), lastRunAt: ago(400) }, 600, NOW)).toBe(false);
  });

  // a worker that started and never ran is counted from its start
  it('gives a worker that never ran the time from its start', () => {
    expect(workerStalled({ startedAt: ago(60), lastRunAt: null }, 180, NOW)).toBe(false);
    expect(workerStalled({ startedAt: ago(600), lastRunAt: null }, 180, NOW)).toBe(true);
  });
});

describe('thresholdOf', () => {
  it('gives the threshold the server sets until the admin sets one', () => {
    expect(thresholdOf('low_stock', null)).toEqual({
      value: 5,
      default: 5,
      min: 1,
      max: 100_000,
      unit: 'units',
      custom: false,
    });
  });

  it('gives the threshold the admin set', () => {
    expect(thresholdOf('shipped_orders_waiting', 3)).toEqual({
      value: 3,
      default: 14,
      min: 1,
      max: 365,
      unit: 'days',
      custom: true,
    });
  });

  it.each([
    ['expiring_batches', 7, 'days'],
    ['refunded_payments', 7, 'days'],
    ['worker_stalled', 180, 'seconds'],
    ['admin_actions', 24, 'hours'],
  ] as const)('gives %s %p %s unless set', (kind, value, unit) => {
    expect(thresholdOf(kind, null)).toMatchObject({ value, unit, custom: false });
  });

  it.each(['paid_orders_waiting', 'out_of_stock', 'expired_batches', 'chats_waiting'] as const)(
    'gives %s no threshold',
    (kind) => {
      expect(thresholdOf(kind, null)).toBeNull();
    },
  );
});

describe('assertThreshold', () => {
  it('takes a threshold within the bounds of its kind', () => {
    expect(() => assertThreshold('shipped_orders_waiting', 1)).not.toThrow();
    expect(() => assertThreshold('shipped_orders_waiting', 365)).not.toThrow();
    expect(() => assertThreshold('worker_stalled', 60)).not.toThrow();
  });

  it.each([
    ['shipped_orders_waiting', 366, { min: 1, max: 365 }],
    ['worker_stalled', 59, { min: 60, max: 86_400 }],
    ['admin_actions', 721, { min: 1, max: 720 }],
    ['low_stock', 0, { min: 1, max: 100_000 }],
  ] as const)('refuses %s at %p and names the bounds', (kind, value, details) => {
    expect(thrownBy(() => assertThreshold(kind, value))).toMatchObject({
      statusCode: 400,
      errorCode: 'ALERT_THRESHOLD_INVALID',
      details,
    });
  });

  it('answers ALERT_THRESHOLD_NOT_FOUND for a kind without a threshold', () => {
    expect(thrownBy(() => assertThreshold('paid_orders_waiting', 3))).toMatchObject({
      statusCode: 404,
      errorCode: 'ALERT_THRESHOLD_NOT_FOUND',
      details: { kind: 'paid_orders_waiting' },
    });
  });
});

describe('alertWindowOf', () => {
  it('starts the time of a period the threshold back from now', () => {
    expect(alertWindowOf('shipped_orders_waiting', 14, NOW, '2026-10-25')).toEqual({
      before: new Date(NOW - 14 * DAY),
    });
    expect(alertWindowOf('refunded_payments', 7, NOW, '2026-10-25')).toEqual({
      since: new Date(NOW - 7 * DAY),
    });
    expect(alertWindowOf('admin_actions', 24, NOW, '2026-10-25')).toEqual({
      since: new Date(NOW - 24 * 3_600_000),
    });
  });

  it('gives the last day of the batches the days of the threshold after the day of the shop', () => {
    expect(alertWindowOf('expiring_batches', 7, NOW, '2026-10-25')).toEqual({
      expiresBy: '2026-11-01',
    });
    expect(alertWindowOf('expiring_batches', 7, NOW, '2026-12-28')).toEqual({
      expiresBy: '2027-01-04',
    });
  });

  it('gives the free units of the threshold of low stock', () => {
    expect(alertWindowOf('low_stock', 5, NOW, '2026-10-25')).toEqual({ units: 5 });
  });

  it('gives a kind without a threshold no window', () => {
    expect(alertWindowOf('paid_orders_waiting', null, NOW, '2026-10-25')).toEqual({});
  });
});

describe('alertListOf', () => {
  const listOf = (kind: Parameters<typeof alertListOf>[0], threshold: number | null) =>
    alertListOf(kind, alertWindowOf(kind, threshold, NOW, '2026-10-25'));

  it('sends to the paid orders, the longest waiting first', () => {
    expect(listOf('paid_orders_waiting', null)).toEqual({
      path: '/api/orders',
      query: { statuses: 'paid', sortBy: 'paidAt', sortDir: 'asc' },
    });
  });

  it('sends to the shipped orders changed before the threshold, the oldest first', () => {
    expect(listOf('shipped_orders_waiting', 14)).toEqual({
      path: '/api/orders',
      query: {
        statuses: 'shipped',
        updatedTo: new Date(NOW - 14 * DAY).toISOString(),
        sortBy: 'updatedAt',
        sortDir: 'asc',
      },
    });
  });

  it('sends to the products with no free units, the most popular first', () => {
    expect(listOf('out_of_stock', null)).toEqual({
      path: '/api/products',
      query: { maxStock: '0', sort: 'popularity', order: 'desc' },
    });
  });

  it('sends to the products with some free units up to the threshold, the fewest first', () => {
    expect(listOf('low_stock', 5)).toEqual({
      path: '/api/products',
      query: { inStock: 'true', maxStock: '5', sort: 'stock', order: 'asc' },
    });
  });

  it('sends to the batches with units by their last day, the nearest first', () => {
    expect(listOf('expiring_batches', 7)).toEqual({
      path: '/api/admin/stock/batches',
      query: {
        inStock: 'true',
        expired: 'false',
        expiresBy: '2026-11-01',
        sortBy: 'expiresAt',
        sortOrder: 'asc',
      },
    });
    expect(listOf('expired_batches', null)).toEqual({
      path: '/api/admin/stock/batches',
      query: { inStock: 'true', expired: 'true', sortBy: 'expiresAt', sortOrder: 'asc' },
    });
  });

  it('sends to the chats with a message no admin has read', () => {
    expect(listOf('chats_waiting', null)).toEqual({
      path: '/api/chat/admin/threads',
      query: { queue: 'unread' },
    });
  });

  it('sends to the lines of the admin log of the refunds and of the admins', () => {
    expect(listOf('refunded_payments', 7)).toEqual({
      path: '/api/admin/audit-log',
      query: {
        actions: 'OTHER',
        entityType: 'order',
        field: 'refund',
        from: new Date(NOW - 7 * DAY).toISOString(),
      },
    });
    expect(listOf('admin_actions', 24)).toEqual({
      path: '/api/admin/audit-log',
      query: { actorRole: 'ADMIN', from: new Date(NOW - 24 * 3_600_000).toISOString() },
    });
  });

  it('sends nowhere for the stop of the worker', () => {
    expect(listOf('worker_stalled', 180)).toBeNull();
  });
});
