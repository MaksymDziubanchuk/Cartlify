import { describe, expect, it } from '@jest/globals';

import {
  ADMIN_ALERT_KINDS,
  alertKindsOf,
  workerStalled,
} from '@routes/api/admin/services/alerts.service.js';

// the kinds of alerts of each role and the stop of the reservation worker; the counts themselves
// are read from the database (tests/integration/api/admin/alerts.test.ts)
describe('alertKindsOf', () => {
  it('gives an admin the kinds of the work that waits', () => {
    expect(alertKindsOf('ADMIN')).toEqual([...ADMIN_ALERT_KINDS]);
  });

  it('gives root the actions of the admins too', () => {
    expect(alertKindsOf('ROOT')).toEqual([...ADMIN_ALERT_KINDS, 'admin_actions']);
  });
});

describe('workerStalled', () => {
  const now = Date.parse('2026-10-24T12:00:00.000Z');
  const ago = (seconds: number) => new Date(now - seconds * 1000);

  it('names no stop of a worker that never started', () => {
    expect(workerStalled({ startedAt: null, lastRunAt: null }, now)).toBe(false);
  });

  it('names no stop of a worker that ran within 180 seconds', () => {
    expect(workerStalled({ startedAt: ago(3600), lastRunAt: ago(30) }, now)).toBe(false);
  });

  it('names a stop of a worker that has not run for longer', () => {
    expect(workerStalled({ startedAt: ago(3600), lastRunAt: ago(181) }, now)).toBe(true);
  });

  // a worker that started and never ran is counted from its start
  it('gives a worker that never ran the time from its start', () => {
    expect(workerStalled({ startedAt: ago(60), lastRunAt: null }, now)).toBe(false);
    expect(workerStalled({ startedAt: ago(600), lastRunAt: null }, now)).toBe(true);
  });
});
