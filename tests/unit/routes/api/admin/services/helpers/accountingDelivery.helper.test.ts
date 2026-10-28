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

// the delivery of a period in the reports: what the orders paid in it and not cancelled paid for
// the delivery, told apart what went back with the cancels, what the sends cost the shop and what
// is left. It is of no product, so only a report of the whole shop has it

const dec = (value: string) => new Prisma.Decimal(value);

const columns = (patch: Partial<DeliveryColumns> = {}): DeliveryColumns => ({
  paid_orders: 9n,
  paid_revenue: dec('45.00'),
  refunded_orders: 1n,
  refunded_revenue: dec('5.00'),
  sends: 10n,
  ship_cost: dec('36.50'),
  sends_without_cost: 2n,
  ...patch,
});

describe('deliveryMoneyOf', () => {
  // the income has no cancelled order: the refund is told apart and the result does not take it
  it('gives the income, the refunds apart, the cost of the sends and the result', () => {
    expect(deliveryMoneyOf(columns())).toEqual({
      income: { orders: 9, revenue: 45 },
      refunded: { orders: 1, revenue: 5 },
      shipping: { sends: 10, cost: 36.5, withoutCost: 2 },
      result: 8.5,
    });
  });

  it('gives a negative result when the carriers cost more than the buyers paid', () => {
    expect(deliveryMoneyOf(columns({ ship_cost: dec('52.25') })).result).toBe(-7.25);
  });

  // decimals, not floats: 0.1 + 0.2 is not 0.3 in a float
  it('adds the money in decimals', () => {
    const out = deliveryMoneyOf(
      columns({ paid_revenue: dec('0.30'), refunded_revenue: dec('0.10'), ship_cost: dec('0.10') }),
    );

    expect(out.result).toBe(0.2);
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
        }),
      ),
    ).toEqual({
      income: { orders: 2, revenue: 10.01 },
      refunded: { orders: 0, revenue: 0 },
      shipping: { sends: 3, cost: 1, withoutCost: 0 },
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
        }),
      ),
    ).toEqual({
      income: { orders: 0, revenue: 0 },
      refunded: { orders: 0, revenue: 0 },
      shipping: { sends: 0, cost: 0, withoutCost: 0 },
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
      income: { items: 100, delivery: 45, total: 145 },
      expenses: { costOfGoods: 60, writeOffs: 4, shipping: 36.5, total: 100.5 },
      margin: { items: 40, delivery: 8.5, total: 44.5 },
    });
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
      delivery: columns({ paid_revenue: dec('0.20'), ship_cost: dec('0.10') }),
    });

    expect(out.income.total).toBe(0.3);
    expect(out.expenses.total).toBe(0.4);
    expect(out.margin).toEqual({ items: -0.1, delivery: 0.1, total: -0.1 });
  });
});

describe('isWholeShop', () => {
  it('is true for a report with no product and no category asked for', () => {
    expect(isWholeShop({ branch: true })).toBe(true);
    expect(isWholeShop({ branch: false })).toBe(true);
  });

  it('is false when products or a category are asked for', () => {
    expect(isWholeShop({ productIds: [1], branch: true })).toBe(false);
    expect(isWholeShop({ productIds: [], branch: true })).toBe(false);
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
      'delivery_income,delivery_refunded,shipping_sends,shipping_cost,shipping_sends_without_cost,delivery_result',
      '45.00,5.00,10,36.50,2,8.50',
      '',
    ]);
  });

  it('leaves the columns empty for a row without the delivery', () => {
    expect(csv([{ delivery: null }])[1]).toBe(',,,,,');
  });
});
