import { describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';

import { MONEY_LOG_EVENTS } from '@config/journalEvents.js';
import {
  moneyLogArgsOf,
  moneyLogItemOf,
  type MoneyRow,
} from '@routes/api/admin/services/moneyLog.service.js';
import type { UserId } from 'types/ids.js';

import { thrownBy } from '../../../../../helpers/errors.js';

// what a query of the money log is made of (its filters, its sorts, its events) and what a line of
// it gives an admin and root. The lines themselves come from the database
// (tests/integration/api/admin/moneyLog.test.ts)

const actor = { id: 7 as UserId, role: 'ADMIN' as const };

describe('moneyLogArgsOf', () => {
  it('takes every filter as it is', () => {
    const args = moneyLogArgsOf(
      {
        orderId: 12,
        userId: 5,
        returnId: 3,
        disputeId: 9,
        paymentId: 'pi_3NabcDEF',
        purpose: 'return',
        state: 'in_transit',
      },
      actor,
    );

    expect(args).toMatchObject({
      orderId: 12,
      userId: 5,
      returnId: 3,
      disputeId: 9,
      // the id of the provider keeps its case: Stripe tells ids apart by it
      paymentId: 'pi_3NabcDEF',
      purpose: 'return',
      state: 'in_transit',
    });
  });

  it('has no filter unless it is asked for', () => {
    const args = moneyLogArgsOf({}, actor);

    expect(args).toMatchObject({
      orderId: undefined,
      userId: undefined,
      returnId: undefined,
      disputeId: undefined,
      paymentId: undefined,
      purpose: undefined,
      state: undefined,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
  });

  it('sorts by any column of the journal that is a simple one', () => {
    for (const sortBy of [
      'amount',
      'purpose',
      'part',
      'state',
      'stateAt',
      'paymentId',
      'refundId',
      'byDashboard',
      'happenedAt',
      'failure',
      'coversId',
    ]) {
      expect(moneyLogArgsOf({ sortBy }, actor).sortBy).toBe(sortBy);
    }
  });

  it('refuses a sort by a column made of other values, and names the ones it sorts by', () => {
    for (const sortBy of ['meta', 'actor', 'user']) {
      const err = thrownBy(() => moneyLogArgsOf({ sortBy }, actor));

      expect(err).toMatchObject({
        errorCode: 'LOG_SORT_INVALID',
        details: { sortBy, allowed: expect.arrayContaining(['amount', 'state']) },
      });
    }
  });

  it('takes the events of the money log and none of another journal or of an old line', () => {
    expect(moneyLogArgsOf({ events: 'money.refund,money.refund_failed' }, actor).events).toEqual([
      'money.refund',
      'money.refund_failed',
    ]);

    const err = thrownBy(() => moneyLogArgsOf({ events: 'legacy.unknown,stock.sale' }, actor));

    expect(err).toMatchObject({
      errorCode: 'LOG_EVENTS_INVALID',
      details: {
        events: ['legacy.unknown', 'stock.sale'],
        allowed: [...MONEY_LOG_EVENTS],
      },
    });
  });
});

// a line as the database gives it: a transfer of a statement started by an admin
const lineOf = (over: Partial<MoneyRow> = {}): MoneyRow => ({
  id: 41,
  createdAt: new Date('2026-11-11T10:00:00.000Z'),
  actorId: 7,
  actorRole: 'ADMIN',
  actorName: 'Olena',
  actorEmail: 'olena@example.com',
  actorRoleNow: 'ADMIN',
  actorDeleted: false,
  event: 'money.refund',
  purpose: 'return',
  part: 'goods',
  amount: new Prisma.Decimal('-10.50'),
  currency: null,
  orderId: 12,
  userId: 5,
  userName: 'Ivan',
  userEmail: 'ivan@example.com',
  userRoleNow: 'USER',
  userDeleted: false,
  returnId: 3,
  orderShipmentId: null,
  disputeId: null,
  coversId: null,
  provider: 'stripe',
  paymentId: 'pi_1',
  refundId: 're_1',
  transferKey: 'refund:5b3a',
  stripeTxId: null,
  bankReference: null,
  byDashboard: false,
  state: 'sent',
  stateAt: new Date('2026-11-11T10:05:00.000Z'),
  failure: null,
  failureText: null,
  method: null,
  note: null,
  happenedAt: null,
  moneyUse: null,
  ip: '203.0.113.10',
  userAgent: 'Admin browser',
  meta: [{ returnItemId: 8, variantId: 31, amount: 10.5 }],
  ...over,
});

describe('moneyLogItemOf', () => {
  it('gives the sum as a number to the cent, the times in iso and the line as it is', () => {
    const item = moneyLogItemOf(lineOf(), 'ADMIN');

    expect(item).toEqual({
      id: 41,
      createdAt: '2026-11-11T10:00:00.000Z',
      actorId: 7,
      actor: { id: 7, name: 'Olena', email: 'olena@example.com', role: 'ADMIN' },
      actorRole: 'ADMIN',
      event: 'money.refund',
      purpose: 'return',
      part: 'goods',
      amount: -10.5,
      currency: null,
      orderId: 12,
      userId: 5,
      user: { id: 5, name: 'Ivan', email: 'ivan@example.com', role: 'USER', deleted: false },
      returnId: 3,
      orderShipmentId: null,
      disputeId: null,
      coversId: null,
      provider: 'stripe',
      paymentId: 'pi_1',
      refundId: 're_1',
      transferKey: 'refund:5b3a',
      stripeTxId: null,
      bankReference: null,
      byDashboard: false,
      state: 'sent',
      stateAt: '2026-11-11T10:05:00.000Z',
      failure: null,
      failureText: null,
      method: null,
      note: null,
      happenedAt: null,
      moneyUse: null,
      ip: '203.0.113.10',
      userAgent: 'Admin browser',
      meta: [{ returnItemId: 8, variantId: 31, amount: 10.5 }],
    });
  });

  it('gives a line of the system no account, and a line without what it is made of an empty list', () => {
    const item = moneyLogItemOf(
      lineOf({
        actorId: null,
        actorRole: null,
        actorName: null,
        actorEmail: null,
        actorRoleNow: null,
        actorDeleted: null,
        ip: null,
        userAgent: null,
        meta: null,
      }),
      'ADMIN',
    );

    expect(item).toMatchObject({ actorId: null, actor: null, actorRole: null, meta: [] });
  });

  it('gives a line with no buyer no account of one', () => {
    const item = moneyLogItemOf(
      lineOf({
        userId: null,
        userName: null,
        userEmail: null,
        userRoleNow: null,
        userDeleted: null,
      }),
      'ADMIN',
    );

    expect(item).toMatchObject({ userId: null, user: null });
  });

  it('hides from an admin who root is in a line root wrote: the account, the address, the browser', () => {
    const rootLine = lineOf({
      actorId: 1,
      actorRole: 'ROOT',
      actorName: 'Root',
      actorEmail: 'root@example.com',
      actorRoleNow: 'ROOT',
      event: 'money.outside',
      method: 'bank_transfer',
      note: 'Sent by bank transfer',
      ip: '198.51.100.7',
      userAgent: 'Root browser',
    });

    const seenByAdmin = moneyLogItemOf(rootLine, 'ADMIN');
    const seenByRoot = moneyLogItemOf(rootLine, 'ROOT');

    expect(seenByAdmin).toMatchObject({
      actorId: 0,
      actor: { id: 0, name: 'hidden', email: 'hidden', role: 'ROOT' },
      actorRole: 'ROOT',
      ip: 'hidden',
      userAgent: 'hidden',
      // what the line says of the money is no secret
      method: 'bank_transfer',
      note: 'Sent by bank transfer',
      amount: -10.5,
    });
    expect(seenByRoot).toMatchObject({
      actorId: 1,
      actor: { id: 1, name: 'Root', email: 'root@example.com', role: 'ROOT' },
      ip: '198.51.100.7',
      userAgent: 'Root browser',
    });
    expect(Object.keys(seenByAdmin).sort()).toEqual(Object.keys(seenByRoot).sort());
  });

  it('hides root from an admin also when it was an admin then, and when the money is its own', () => {
    // an account that is root now wrote the line as an admin
    const promoted = moneyLogItemOf(lineOf({ actorRoleNow: 'ROOT' }), 'ADMIN');
    // root bought the order
    const rootBuyer = moneyLogItemOf(
      lineOf({ userId: 1, userName: 'Root', userEmail: 'root@example.com', userRoleNow: 'ROOT' }),
      'ADMIN',
    );
    const rootBuyerForRoot = moneyLogItemOf(
      lineOf({ userId: 1, userName: 'Root', userEmail: 'root@example.com', userRoleNow: 'ROOT' }),
      'ROOT',
    );

    expect(promoted).toMatchObject({
      actorId: 0,
      actor: { id: 0, email: 'hidden', role: 'ROOT' },
      actorRole: 'ADMIN',
      ip: 'hidden',
    });
    expect(rootBuyer).toMatchObject({
      userId: 0,
      user: { id: 0, name: 'hidden', email: 'hidden', role: 'ROOT', deleted: false },
      // the line of the admin is the admin's: the address of the request is not hidden
      actorId: 7,
      ip: '203.0.113.10',
    });
    expect(rootBuyerForRoot).toMatchObject({
      userId: 1,
      user: { id: 1, email: 'root@example.com', role: 'ROOT' },
    });
  });

  it('keeps the lines of a deleted account, not its email', () => {
    const item = moneyLogItemOf(lineOf({ actorDeleted: true, userDeleted: true }), 'ROOT');

    expect(item).toMatchObject({
      actor: { id: 7, name: 'Olena', email: null, role: 'ADMIN' },
      user: { id: 5, name: 'Ivan', email: null, role: 'USER', deleted: true },
    });
  });
});
