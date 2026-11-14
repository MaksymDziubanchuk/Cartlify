import { describe, expect, it } from '@jest/globals';

import {
  deductibleOf,
  movementOf,
  rowPaidOf,
  rowSharesOf,
  sentAtOf,
  shipmentCostOf,
  sumsOf,
  wayBackOutsideOf,
  type ReturnMoneyLine,
} from '@routes/api/returns/services/helpers/returnMoneyLines.helper.js';

// the money of a statement read from its lines of the money journal: a transfer is written in parts
// under one key (the goods, the delivery, the deduction for the way back, the way back the shop
// pays, what other money covered), money sent outside the app in parts written together, a failure is new lines with the
// opposite sums; the parcels back cost what their lines say, corrections with the difference

const T1 = new Date('2026-11-11T10:00:00.000Z');
const T2 = new Date('2026-11-11T11:00:00.000Z');

let nextId = 1;

function line(over: Partial<ReturnMoneyLine>): ReturnMoneyLine {
  return {
    id: nextId++,
    event: 'money.refund',
    purpose: 'return',
    part: 'goods',
    amount: -10,
    currency: 'eur',
    state: null,
    stateAt: null,
    createdAt: T1,
    happenedAt: null,
    refundId: null,
    bankReference: null,
    byDashboard: false,
    transferKey: null,
    coversId: null,
    failure: null,
    failureText: null,
    method: null,
    note: null,
    actorId: null,
    orderShipmentId: null,
    meta: null,
    ...over,
  };
}

describe('movementOf', () => {
  it('takes the parts of a transfer under its key, not those of another transfer', () => {
    const goods = line({ transferKey: 'refund:a', part: 'goods', amount: -100 });
    const delivery = line({ transferKey: 'refund:a', part: 'delivery', amount: -10 });
    const deduction = line({ transferKey: 'refund:a', part: 'deduction', amount: 8 });
    const other = line({ transferKey: 'refund:b', part: 'goods', amount: -50 });

    expect(movementOf([goods, delivery, deduction, other], goods)).toEqual([
      goods,
      delivery,
      deduction,
    ]);
  });

  it('takes the parts written together for money without a key: sent outside the app', () => {
    const goods = line({ event: 'money.outside', part: 'goods', amount: -100, method: 'cash' });
    const delivery = line({
      event: 'money.outside',
      part: 'delivery',
      amount: -10,
      method: 'cash',
    });
    const earlier = line({ event: 'money.outside', part: 'goods', createdAt: T2, method: 'cash' });
    const transfer = line({ transferKey: 'refund:a', part: 'goods' });

    expect(movementOf([goods, delivery, earlier, transfer], goods)).toEqual([goods, delivery]);
  });

  it('gives a failure the transfer it reversed', () => {
    const goods = line({ transferKey: 'refund:a', part: 'goods', amount: -100 });
    const delivery = line({ transferKey: 'refund:a', part: 'delivery', amount: -10 });
    const failed = line({
      event: 'money.refund_failed',
      transferKey: 'refund:a',
      part: 'goods',
      amount: 100,
      coversId: goods.id,
      createdAt: T2,
    });

    expect(movementOf([goods, delivery, failed], failed)).toEqual([goods, delivery]);
  });
});

describe('sumsOf', () => {
  // the example of the decision: 100 for the goods, 10 for the delivery, 8 kept for the way back
  it('gives the goods, the delivery and the deduction, and what the buyer got of them', () => {
    expect(
      sumsOf([
        line({ part: 'goods', amount: -100 }),
        line({ part: 'delivery', amount: -10 }),
        line({ part: 'deduction', amount: 8 }),
      ]),
    ).toEqual({ goods: 100, delivery: 10, deduction: 8, wayBack: 0, covered: 0, total: 102 });
  });

  it('counts what other money covered as part of what the buyer got', () => {
    expect(
      sumsOf([line({ part: 'goods', amount: -30 }), line({ part: 'covered', amount: 20 })]),
    ).toEqual({ goods: 30, delivery: 0, deduction: 0, wayBack: 0, covered: 20, total: 30 });
  });

  it('adds the cents without float math', () => {
    expect(
      sumsOf([line({ part: 'goods', amount: -10.15 }), line({ part: 'delivery', amount: -0.05 })])
        .total,
    ).toBe(10.2);
  });
});

describe('deductibleOf', () => {
  // the parcel the goods of the statement came back to the shop in
  const WAY_BACK = 900;

  const parcel = (amount: number, over: Partial<ReturnMoneyLine> = {}) =>
    line({
      event: 'money.return_parcel_cost',
      purpose: 'shipping',
      part: 'whole',
      amount,
      orderShipmentId: WAY_BACK,
      ...over,
    });

  it('is nothing without a parcel', () => {
    expect(deductibleOf(WAY_BACK, [])).toBe(0);
  });

  it('is what the parcels cost while no transfer took anything for them', () => {
    expect(deductibleOf(WAY_BACK, [parcel(-7)])).toBe(7);
  });

  it('is the cost less what the transfers took', () => {
    expect(
      deductibleOf(WAY_BACK, [
        parcel(-7),
        line({ transferKey: 'refund:a', part: 'deduction', amount: 5 }),
      ]),
    ).toBe(2);
  });

  // the failed transfer did not keep its deduction: the money of the parcel may be taken again
  it('gives back what a failed transfer meant to take', () => {
    const deduction = line({ transferKey: 'refund:a', part: 'deduction', amount: 5 });

    expect(
      deductibleOf(WAY_BACK, [
        parcel(-7),
        deduction,
        line({
          event: 'money.refund_failed',
          transferKey: 'refund:a',
          part: 'deduction',
          amount: -5,
          coversId: deduction.id,
        }),
      ]),
    ).toBe(7);
  });

  it('follows a correction of the cost of a parcel', () => {
    const first = parcel(-7);

    expect(
      deductibleOf(WAY_BACK, [
        first,
        line({
          event: 'money.correction',
          purpose: 'shipping',
          orderShipmentId: WAY_BACK,
          part: 'whole',
          amount: 2,
          coversId: first.id,
        }),
      ]),
    ).toBe(5);
  });

  it('is never below nothing', () => {
    expect(deductibleOf(WAY_BACK, [parcel(-3), line({ part: 'deduction', amount: 5 })])).toBe(0);
  });

  // the shop sends goods it did not accept back to the buyer at its own cost: that parcel is not
  // the way back, a transfer takes none of it off
  it('counts only the parcel back to the shop', () => {
    expect(deductibleOf(WAY_BACK, [parcel(-7), parcel(-6, { orderShipmentId: 901 })])).toBe(7);
    expect(deductibleOf(null, [parcel(-6, { orderShipmentId: 901 })])).toBe(0);
  });
});

describe('shipmentCostOf', () => {
  it('is none for a parcel without a line of its cost', () => {
    expect(shipmentCostOf([], 4)).toBeNull();
  });

  it('is the first cost with its corrections, of that parcel only', () => {
    const first = line({
      event: 'money.return_parcel_cost',
      purpose: 'shipping',
      part: 'whole',
      amount: -7,
      orderShipmentId: 4,
    });
    const lines = [
      first,
      line({
        event: 'money.correction',
        purpose: 'shipping',
        part: 'whole',
        amount: 2,
        orderShipmentId: 4,
        coversId: first.id,
      }),
      line({
        event: 'money.return_parcel_cost',
        purpose: 'shipping',
        part: 'whole',
        amount: -9,
        orderShipmentId: 5,
      }),
    ];

    expect(shipmentCostOf(lines, 4)).toBe(5);
    expect(shipmentCostOf(lines, 5)).toBe(9);
  });
});

describe('wayBackOutsideOf', () => {
  const outside = (over: Partial<ReturnMoneyLine>) =>
    line({
      event: 'money.outside',
      part: 'way_back',
      amount: -6,
      method: 'bank_transfer',
      note: 'Sent to the account of the buyer.',
      happenedAt: T1,
      ...over,
    });

  it('is the last way back the shop paid outside the app, none before it, none of a transfer', () => {
    const first = outside({});
    const second = outside({ createdAt: T2 });

    expect(wayBackOutsideOf([line({ part: 'way_back', transferKey: 'refund:a' })])).toBeNull();
    expect(wayBackOutsideOf([first, second])).toBe(second);
  });
});

describe('sumsOf and the way back', () => {
  it('adds the way back the shop paid to what the buyer got', () => {
    const sums = sumsOf([
      line({ transferKey: 'refund:a', part: 'goods', amount: -20 }),
      line({ transferKey: 'refund:a', part: 'way_back', amount: -6.5 }),
    ]);

    expect(sums).toMatchObject({ goods: 20, wayBack: 6.5, total: 26.5 });
  });
});

// what a row of a statement got with its money now: the part of the delivery and the deduction for
// the way back the parts of its movements name it with (the last row of a transfer carries them),
// a failure gives them back, money sent outside the app after it names them again
describe('rowSharesOf', () => {
  const delivery = (over: Partial<ReturnMoneyLine>) =>
    line({ part: 'delivery', amount: -5, meta: [{ returnItemId: 7, amount: 5 }], ...over });
  const deduction = (over: Partial<ReturnMoneyLine>) =>
    line({ part: 'deduction', amount: 3, meta: [{ returnItemId: 7, amount: 3 }], ...over });

  it('gives a row the delivery and the deduction its transfer named it with', () => {
    const shares = rowSharesOf([
      line({
        meta: [
          { returnItemId: 6, amount: 10 },
          { returnItemId: 7, amount: 10 },
        ],
      }),
      delivery({}),
      deduction({}),
    ]);

    expect(shares.get(7)).toEqual({ delivery: 5, deduction: 3 });
    // the other row of the transfer carries none of them
    expect(shares.get(6)).toBeUndefined();
  });

  it('takes them back with the failure of the transfer and gives them again with the money sent outside the app', () => {
    const failedDelivery = delivery({ event: 'money.refund_failed', amount: 5 });
    const failedDeduction = deduction({ event: 'money.refund_failed', amount: -3 });

    expect(
      rowSharesOf([delivery({}), deduction({}), failedDelivery, failedDeduction]).get(7),
    ).toEqual({ delivery: 0, deduction: 0 });
    expect(
      rowSharesOf([
        delivery({}),
        failedDelivery,
        delivery({ event: 'money.outside', method: 'cash' }),
      ]).get(7),
    ).toEqual({ delivery: 5, deduction: 0 });
  });

  it('adds the money in cents', () => {
    const shares = rowSharesOf([
      delivery({ amount: -0.1, meta: [{ returnItemId: 7, amount: 0.1 }] }),
      delivery({ amount: -0.2, meta: [{ returnItemId: 7, amount: 0.2 }] }),
    ]);

    expect(shares.get(7)).toEqual({ delivery: 0.3, deduction: 0 });
  });

  it('leaves out the lines of the parcels, the way back paid back and a meta that is not a list', () => {
    const shares = rowSharesOf([
      line({ purpose: 'shipping', part: 'whole', event: 'money.return_parcel_cost', amount: -4 }),
      line({ part: 'whole', event: 'money.return_shipping_paid', amount: -2 }),
      delivery({ meta: { returnItemId: 7, amount: 5 } }),
    ]);

    expect(shares.size).toBe(0);
  });
});

// when the money of a row went, as the buyer is told: a refund when it was told sent, the time it
// was asked while it is on its way, money sent outside the app on the day it really went
describe('sentAtOf', () => {
  it('gives the time a refund was told sent, the time it was asked before that', () => {
    expect(sentAtOf(line({ state: 'sent', stateAt: T2 }))).toBe(T2.toISOString());
    expect(sentAtOf(line({ state: 'in_transit', stateAt: T1 }))).toBe(T1.toISOString());
  });

  it('gives the day money sent outside the app went, the time it was written without one', () => {
    expect(sentAtOf(line({ event: 'money.outside', happenedAt: T2 }))).toBe(T2.toISOString());
    expect(sentAtOf(line({ event: 'money.outside', happenedAt: null }))).toBe(T1.toISOString());
  });

  it('gives none without a line', () => {
    expect(sentAtOf(null)).toBeNull();
  });
});

// a row is paid in parts: what the provider could hold of the payment, the rest outside the app:
// the card says "paid X of Y"
describe('rowPaidOf', () => {
  const goods = (over: Partial<ReturnMoneyLine>) =>
    line({
      part: 'goods',
      amount: -15,
      meta: [
        { returnItemId: 6, amount: 10 },
        { returnItemId: 7, amount: 5 },
      ],
      ...over,
    });

  it('gives each row what the goods of its transfers and the money sent outside the app paid of it', () => {
    const paid = rowPaidOf([
      goods({}),
      goods({ event: 'money.outside', amount: -5, meta: [{ returnItemId: 7, amount: 5 }] }),
    ]);

    expect(paid.get(6)).toBe(10);
    expect(paid.get(7)).toBe(10);
  });

  it('takes back what a failed transfer paid, and counts no other part', () => {
    const paid = rowPaidOf([
      goods({}),
      goods({ event: 'money.refund_failed', amount: 15 }),
      line({ part: 'delivery', amount: -5, meta: [{ returnItemId: 7, amount: 5 }] }),
      line({ part: 'covered', amount: 3, meta: [{ returnItemId: 7, amount: 3 }] }),
    ]);

    expect(paid.get(6)).toBe(0);
    expect(paid.get(7)).toBe(0);
  });

  it('adds the money in cents', () => {
    const paid = rowPaidOf([
      goods({ amount: -0.1, meta: [{ returnItemId: 7, amount: 0.1 }] }),
      goods({ event: 'money.outside', amount: -0.2, meta: [{ returnItemId: 7, amount: 0.2 }] }),
    ]);

    expect(paid.get(7)).toBe(0.3);
  });
});
