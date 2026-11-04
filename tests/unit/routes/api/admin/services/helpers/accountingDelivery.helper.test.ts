import { describe, expect, it } from '@jest/globals';

import { Prisma } from '@prisma/client';

import { toCsv } from '@helpers/csv.js';
import { deliveryCsvColumns } from '@routes/api/admin/services/helpers/accountingCsv.helper.js';
import {
  deliveryMoneyOf,
  isWholeShop,
  summaryOf,
  type DeliveryColumns,
} from '@routes/api/admin/services/helpers/accountingSql.helper.js';
import type { AdminDeliveryMoneyDto } from 'types/dto/admin.dto.js';

// the delivery of a period in the reports: what the orders paid in it paid for the delivery (cancelled
// later or not), what went back with the returns in it, what the sends cost the shop and what is
// left. It is of no product, so only a report of the whole shop has it

const dec = (value: string) => new Prisma.Decimal(value);

const columns = (patch: Partial<DeliveryColumns> = {}): DeliveryColumns => ({
  paid_orders: 9n,
  paid_revenue: dec('45.00'),
  refunded_orders: 1n,
  refunded_revenue: dec('5.00'),
  sends: 10n,
  ship_cost: dec('36.50'),
  sends_without_cost: 2n,
  return_sends: 1n,
  return_ship_cost: dec('4.50'),
  return_sends_without_cost: 0n,
  return_ship_deducted: dec('0'),
  return_ship_reimbursed: dec('0'),
  ...patch,
});

describe('deliveryMoneyOf', () => {
  // the income keeps the orders cancelled later: what went back is told apart and comes off the
  // result, and so do the sends and the parcels back
  it('gives the income, the refunds apart, the cost of the sends and the parcels back and the result', () => {
    expect(deliveryMoneyOf(columns())).toEqual({
      income: { orders: 9, revenue: 45 },
      refunded: { orders: 1, revenue: 5 },
      shipping: { sends: 10, cost: 36.5, withoutCost: 2 },
      returnShipping: { sends: 1, cost: 4.5, withoutCost: 0, deducted: 0, reimbursed: 0 },
      // 45 - 5 - 36.5 - 4.5
      result: -1,
    });
  });

  // the way back the buyers owed is an income of the delivery, the one paid back to them is spent
  it('adds the way back the buyers owed to the result and takes the one paid back to them off', () => {
    const out = deliveryMoneyOf(
      columns({ return_ship_deducted: dec('6.00'), return_ship_reimbursed: dec('2.50') }),
    );

    expect(out.returnShipping).toEqual({
      sends: 1,
      cost: 4.5,
      withoutCost: 0,
      deducted: 6,
      reimbursed: 2.5,
    });
    // 45 - 5 - 36.5 - 4.5 + 6 - 2.5
    expect(out.result).toBe(2.5);
  });

  it('gives a negative result when the carriers cost more than the buyers paid', () => {
    expect(deliveryMoneyOf(columns({ ship_cost: dec('52.25') })).result).toBe(-16.75);
  });

  it('counts the parcels back that have no cost written apart, and takes their cost off the result', () => {
    const out = deliveryMoneyOf(
      columns({ return_sends: 3n, return_ship_cost: dec('9.00'), return_sends_without_cost: 2n }),
    );

    expect(out.returnShipping).toEqual({
      sends: 3,
      cost: 9,
      withoutCost: 2,
      deducted: 0,
      reimbursed: 0,
    });
    expect(out.result).toBe(-5.5);
  });

  // decimals, not floats: 0.1 + 0.2 is not 0.3 in a float
  it('adds the money in decimals', () => {
    const out = deliveryMoneyOf(
      columns({
        paid_revenue: dec('0.30'),
        refunded_revenue: dec('0.10'),
        ship_cost: dec('0.10'),
        return_ship_cost: dec('0'),
      }),
    );

    expect(out.result).toBe(0.1);
  });

  it('takes the numbers a database gives as text, big integers or numbers', () => {
    expect(
      deliveryMoneyOf(
        columns({
          paid_orders: 2,
          paid_revenue: '10.005',
          refunded_orders: '0' as unknown as number,
          refunded_revenue: 0,
          sends: 3n,
          ship_cost: '1',
          sends_without_cost: 0,
          return_sends: 0,
          return_ship_cost: '0',
          return_sends_without_cost: 0n,
          return_ship_deducted: '0',
          return_ship_reimbursed: 0,
        }),
      ),
    ).toEqual({
      income: { orders: 2, revenue: 10.01 },
      refunded: { orders: 0, revenue: 0 },
      shipping: { sends: 3, cost: 1, withoutCost: 0 },
      returnShipping: { sends: 0, cost: 0, withoutCost: 0, deducted: 0, reimbursed: 0 },
      result: 9.01,
    });
  });

  it('gives zeros for a period with nothing in it', () => {
    const zero = dec('0');
    expect(
      deliveryMoneyOf(
        columns({
          paid_orders: 0n,
          paid_revenue: zero,
          refunded_orders: 0n,
          refunded_revenue: zero,
          sends: 0n,
          ship_cost: zero,
          sends_without_cost: 0n,
          return_sends: 0n,
          return_ship_cost: zero,
          return_sends_without_cost: 0n,
          return_ship_deducted: zero,
          return_ship_reimbursed: zero,
        }),
      ),
    ).toEqual({
      income: { orders: 0, revenue: 0 },
      refunded: { orders: 0, revenue: 0 },
      shipping: { sends: 0, cost: 0, withoutCost: 0 },
      returnShipping: { sends: 0, cost: 0, withoutCost: 0, deducted: 0, reimbursed: 0 },
      result: 0,
    });
  });
});

describe('summaryOf', () => {
  it('gives the income, the expenses and the margins of the whole shop', () => {
    expect(
      summaryOf({
        itemsRevenue: dec('100.00'),
        itemsCost: dec('60.00'),
        writeOffs: 4,
        delivery: columns(),
      }),
    ).toEqual({
      // the delivery less what went back with the returns: 45 - 5
      income: { items: 100, delivery: 40, total: 140 },
      // the sends to the buyers and the parcels back are the one expense of the carriers: 36.5 + 4.5
      expenses: { costOfGoods: 60, writeOffs: 4, shipping: 41, total: 105 },
      margin: { items: 40, delivery: -1, total: 35 },
    });
  });

  it('counts the way back the buyers owed in the income of the delivery and the one paid back to them in the expense', () => {
    const out = summaryOf({
      itemsRevenue: dec('100.00'),
      itemsCost: dec('60.00'),
      writeOffs: 4,
      delivery: columns({ return_ship_deducted: dec('6.00'), return_ship_reimbursed: dec('2.50') }),
    });

    // 45 - 5 + 6
    expect(out.income).toEqual({ items: 100, delivery: 46, total: 146 });
    // 36.5 + 4.5 + 2.5
    expect(out.expenses).toEqual({ costOfGoods: 60, writeOffs: 4, shipping: 43.5, total: 107.5 });
    expect(out.margin).toEqual({ items: 40, delivery: 2.5, total: 38.5 });
  });

  it('gives none for the delivery and the sends of a report of some products', () => {
    expect(
      summaryOf({ itemsRevenue: '10.10', itemsCost: '3.05', writeOffs: '1.01', delivery: null }),
    ).toEqual({
      income: { items: 10.1, delivery: null, total: 10.1 },
      expenses: { costOfGoods: 3.05, writeOffs: 1.01, shipping: null, total: 4.06 },
      margin: { items: 7.05, delivery: null, total: 6.04 },
    });
  });

  it('adds the money in decimals', () => {
    const out = summaryOf({
      itemsRevenue: '0.10',
      itemsCost: '0.20',
      writeOffs: '0.10',
      delivery: columns({
        paid_revenue: dec('0.20'),
        refunded_revenue: dec('0'),
        ship_cost: dec('0.10'),
        return_ship_cost: dec('0'),
      }),
    });

    expect(out.income.total).toBe(0.3);
    expect(out.expenses.total).toBe(0.4);
    expect(out.margin).toEqual({ items: -0.1, delivery: 0.1, total: -0.1 });
  });
});

describe('isWholeShop', () => {
  it('is true for a report with no product, no variant and no category asked for', () => {
    expect(isWholeShop({ branch: true })).toBe(true);
    expect(isWholeShop({ branch: false })).toBe(true);
  });

  it('is false when products, variants or a category are asked for', () => {
    expect(isWholeShop({ productIds: [1], branch: true })).toBe(false);
    expect(isWholeShop({ productIds: [], branch: true })).toBe(false);
    expect(isWholeShop({ variantIds: [1], branch: true })).toBe(false);
    expect(isWholeShop({ variantIds: [], branch: true })).toBe(false);
    expect(isWholeShop({ categoryId: 3, branch: true })).toBe(false);
  });
});

describe('deliveryCsvColumns', () => {
  const delivery: AdminDeliveryMoneyDto = deliveryMoneyOf(columns());
  const csv = (rows: { delivery: AdminDeliveryMoneyDto | null }[]) =>
    toCsv(
      deliveryCsvColumns<{ delivery: AdminDeliveryMoneyDto | null }>((row) => row.delivery),
      rows,
    )
      .replace(/^\uFEFF/, '')
      .split('\r\n');

  it('names the columns and gives the delivery of a row', () => {
    expect(csv([{ delivery }])).toEqual([
      'delivery_income,delivery_refunded,shipping_sends,shipping_cost,shipping_sends_without_cost,return_shipping_sends,return_shipping_cost,return_shipping_sends_without_cost,return_shipping_deducted,return_shipping_reimbursed,delivery_result',
      '45.00,5.00,10,36.50,2,1,4.50,0,0.00,0.00,-1.00',
      '',
    ]);
  });

  it('leaves the columns empty for a row without the delivery', () => {
    expect(csv([{ delivery: null }])[1]).toBe(',,,,,,,,,,');
  });
});
