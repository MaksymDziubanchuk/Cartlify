import { describe, expect, it } from '@jest/globals';

import { Prisma } from '@prisma/client';

import { toCsv } from '@helpers/csv.js';
import {
  paymentsCsvColumns,
  summaryCsvColumns,
} from '@routes/api/admin/services/helpers/accountingCsv.helper.js';
import {
  paymentsMoneyOf,
  summaryOf,
  type DeliveryColumns,
  type PaymentsColumns,
} from '@routes/api/admin/services/helpers/accountingSql.helper.js';
import type { AdminMoneySummaryDto, AdminPaymentsMoneyDto } from 'types/dto/admin.dto.js';

// the money of a period that moved past the sales and the returns of the statements, of the whole
// shop: what the bank took for the disputes and gave back, the refunds made by hand in the dashboard
// of the provider (told apart by what root or the system decided they were), and the payments the
// orders could not take with what of them went back. The money of a dispute or of a refund by hand
// that a transfer of a statement took as money the buyer had back is in the returns: it comes off
// here (used), so nothing is counted twice. What a dispute and a refund by hand left is an expense
// of the summary; a late payment is the buyer's money, never an income

const dec = (value: string) => new Prisma.Decimal(value);

const columns = (patch: Partial<PaymentsColumns> = {}): PaymentsColumns => ({
  dispute_withdrawn: dec('30.00'),
  dispute_reinstated: dec('10.00'),
  dispute_used: dec('5.00'),
  hand_compensations: dec('4.00'),
  hand_coverage: dec('20.00'),
  hand_undecided: dec('6.00'),
  hand_used: dec('20.00'),
  late_received: dec('51.00'),
  late_refunded: dec('40.00'),
  dispute_undecided: dec('0'),
  compensations_given: dec('0'),
  received_buyers: dec('0'),
  received_carriers: dec('0'),
  // the 5 of the bank a statement used went to the goods: the report by product has them
  dispute_goods: dec('5.00'),
  dispute_delivery_used: dec('0'),
  hand_delivery: dec('0'),
  hand_delivery_used: dec('0'),
  shares_moved_goods: dec('0'),
  received_share_delivery: dec('0'),
  ...patch,
});

const zero = dec('0');
const NONE: PaymentsColumns = {
  dispute_withdrawn: zero,
  dispute_reinstated: zero,
  dispute_used: zero,
  hand_compensations: zero,
  hand_coverage: zero,
  hand_undecided: zero,
  hand_used: zero,
  late_received: zero,
  late_refunded: zero,
  dispute_undecided: zero,
  compensations_given: zero,
  received_buyers: zero,
  received_carriers: zero,
  dispute_goods: zero,
  dispute_delivery_used: zero,
  hand_delivery: zero,
  hand_delivery_used: zero,
  shares_moved_goods: zero,
  received_share_delivery: zero,
};

const delivery = (patch: Partial<DeliveryColumns> = {}): DeliveryColumns => ({
  paid_orders: 1n,
  paid_revenue: dec('10.00'),
  refunded_orders: 0n,
  refunded_revenue: zero,
  sends: 1n,
  ship_cost: dec('4.00'),
  sends_without_cost: 0n,
  return_sends: 0n,
  return_ship_cost: zero,
  return_sends_without_cost: 0n,
  return_ship_deducted: zero,
  return_ship_reimbursed: zero,
  ...patch,
});

describe('paymentsMoneyOf', () => {
  it('gives the disputes, the refunds by hand and the late payments with what each left', () => {
    expect(paymentsMoneyOf(columns())).toEqual({
      // the bank took 30 and gave 10 back; 5 of it a transfer took as money the buyer had back
      disputes: { withdrawn: 30, reinstated: 10, used: 5, undecided: 0, result: -15 },
      // 30 went out by hand: 4 a compensation, 20 that counts for a statement, 6 not decided yet;
      // a transfer took 20 of it
      handRefunds: {
        refunded: 30,
        compensations: 4,
        coverage: 20,
        undecided: 6,
        used: 20,
        result: -10,
      },
      // 51 came in that the orders could not take, 40 went back: 11 is still with the shop
      latePayments: { received: 51, refunded: 40, result: 11 },
      compensations: { given: 0, result: 0 },
      received: { buyers: 0, carriers: 0, result: 0 },
    });
  });

  // a transfer in the period may use money that went out by hand or to the bank in an earlier one:
  // the period then has the use and none of the money
  it('gives a period that only used money of an earlier one a result above 0', () => {
    const out = paymentsMoneyOf({ ...NONE, dispute_used: dec('25.00'), hand_used: dec('8.00') });

    expect(out.disputes).toEqual({
      withdrawn: 0,
      reinstated: 0,
      used: 25,
      undecided: 0,
      result: 25,
    });
    expect(out.handRefunds).toMatchObject({ refunded: 0, used: 8, result: 8 });
  });

  // a failure gives the money back in the period it happened in: the sums of the period may be
  // below 0
  it('keeps a period with only the failure of a refund below 0', () => {
    const out = paymentsMoneyOf({
      ...NONE,
      hand_compensations: dec('-4.00'),
      late_refunded: dec('-12.50'),
    });

    expect(out.handRefunds).toMatchObject({ refunded: -4, compensations: -4, result: 4 });
    expect(out.latePayments).toEqual({ received: 0, refunded: -12.5, result: 12.5 });
  });

  it('adds the money in decimals', () => {
    const out = paymentsMoneyOf({
      ...NONE,
      dispute_withdrawn: dec('0.30'),
      dispute_reinstated: dec('0.10'),
      dispute_used: dec('0.20'),
      hand_compensations: dec('0.10'),
      hand_coverage: dec('0.20'),
      late_received: dec('0.30'),
      late_refunded: dec('0.10'),
    });

    expect(out.disputes.result).toBe(0);
    expect(out.handRefunds.refunded).toBe(0.3);
    expect(out.latePayments.result).toBe(0.2);
  });

  // what the bank took and waits for the decision is told apart; a compensation of the app goes out,
  // money that came back outside the app comes in
  it('gives what waits for the decision, the compensations and the money that came back', () => {
    const out = paymentsMoneyOf({
      ...NONE,
      dispute_withdrawn: dec('20.00'),
      dispute_undecided: dec('20.00'),
      compensations_given: dec('5.00'),
      received_buyers: dec('10.00'),
      received_carriers: dec('2.50'),
    });

    expect(out.disputes).toEqual({
      withdrawn: 20,
      reinstated: 0,
      used: 0,
      undecided: 20,
      result: -20,
    });
    expect(out.compensations).toEqual({ given: 5, result: -5 });
    expect(out.received).toEqual({ buyers: 10, carriers: 2.5, result: 12.5 });
  });

  it('takes the numbers a database gives as text or numbers', () => {
    expect(
      paymentsMoneyOf({
        ...NONE,
        dispute_withdrawn: '12.5',
        hand_undecided: 3,
        late_received: '0',
      }),
    ).toEqual({
      disputes: { withdrawn: 12.5, reinstated: 0, used: 0, undecided: 0, result: -12.5 },
      handRefunds: {
        refunded: 3,
        compensations: 0,
        coverage: 0,
        undecided: 3,
        used: 0,
        result: -3,
      },
      latePayments: { received: 0, refunded: 0, result: 0 },
      compensations: { given: 0, result: 0 },
      received: { buyers: 0, carriers: 0, result: 0 },
    });
  });

  it('gives zeros for a period with nothing in it', () => {
    expect(paymentsMoneyOf(NONE)).toEqual({
      disputes: { withdrawn: 0, reinstated: 0, used: 0, undecided: 0, result: 0 },
      handRefunds: {
        refunded: 0,
        compensations: 0,
        coverage: 0,
        undecided: 0,
        used: 0,
        result: 0,
      },
      latePayments: { received: 0, refunded: 0, result: 0 },
      compensations: { given: 0, result: 0 },
      received: { buyers: 0, carriers: 0, result: 0 },
    });
  });
});

describe('summaryOf with the disputes and the refunds by hand', () => {
  it('takes what the disputes and the refunds by hand left off as an expense, the late payments not', () => {
    const out = summaryOf({
      itemsRevenue: dec('100.00'),
      itemsCost: dec('60.00'),
      writeOffs: 0,
      delivery: delivery(),
      payments: columns(),
    });

    // the late payments are the buyers' money until it goes back: no income
    expect(out.income).toEqual({ items: 100, delivery: 10, total: 110 });
    // the disputes left -15, the refunds by hand -10
    expect(out.expenses).toEqual({
      costOfGoods: 60,
      writeOffs: 0,
      shipping: 4,
      otherRefunds: 25,
      total: 89,
    });
    expect(out.margin).toEqual({ items: 40, delivery: 6, total: 21 });
  });

  // root gave up 12 of an overpaid share of the goods: no more their return, a loss; the buyer gave
  // back 3 of an overpaid share of the delivery: less of what went out
  it('takes what root gave up of an overpaid share of the goods as an expense, and what the buyer gave back of the delivery off it', () => {
    const out = summaryOf({
      itemsRevenue: dec('0'),
      itemsCost: dec('0'),
      writeOffs: 0,
      delivery: delivery({ paid_revenue: zero, ship_cost: zero }),
      payments: { ...NONE, shares_moved_goods: dec('12.00'), received_share_delivery: dec('3.00') },
    });

    expect(out.expenses).toMatchObject({ otherRefunds: 9, total: 9 });
  });

  it('makes money that came back from the bank a negative expense', () => {
    const out = summaryOf({
      itemsRevenue: dec('0'),
      itemsCost: dec('0'),
      writeOffs: 0,
      delivery: delivery({ paid_revenue: zero, ship_cost: zero }),
      payments: { ...NONE, dispute_reinstated: dec('30.00') },
    });

    expect(out.expenses).toMatchObject({ otherRefunds: -30, total: -30 });
    expect(out.margin.total).toBe(30);
  });

  it('gives none of it to a report of some products', () => {
    const out: AdminMoneySummaryDto = summaryOf({
      itemsRevenue: '10.00',
      itemsCost: '4.00',
      writeOffs: 0,
      delivery: null,
      payments: null,
    });

    expect(out.expenses).toEqual({
      costOfGoods: 4,
      writeOffs: 0,
      shipping: null,
      otherRefunds: null,
      total: 4,
    });
    expect(out.margin.total).toBe(6);
  });
});

describe('paymentsCsvColumns', () => {
  const payments: AdminPaymentsMoneyDto = paymentsMoneyOf(columns());
  const csv = (rows: { payments: AdminPaymentsMoneyDto | null }[]) =>
    toCsv(
      paymentsCsvColumns<{ payments: AdminPaymentsMoneyDto | null }>((row) => row.payments),
      rows,
    )
      .replace(/^\uFEFF/, '')
      .split('\r\n');

  it('names the columns and gives the money of a row', () => {
    expect(csv([{ payments }])).toEqual([
      'dispute_withdrawn,dispute_reinstated,dispute_used,dispute_undecided,dispute_result,' +
        'hand_refunded,hand_compensations,hand_coverage,hand_undecided,hand_used,hand_result,' +
        'late_received,late_refunded,late_result,compensations_given,received_buyers,' +
        'received_carriers',
      '30.00,10.00,5.00,0.00,-15.00,30.00,4.00,20.00,6.00,20.00,-10.00,51.00,40.00,11.00,0.00,' +
        '0.00,0.00',
      '',
    ]);
  });

  it('leaves the columns empty for a row of some products', () => {
    expect(csv([{ payments: null }])[1]).toBe(',,,,,,,,,,,,,,,,');
  });
});

describe('summaryCsvColumns', () => {
  it('has the expense of the disputes and the refunds by hand after the sends', () => {
    const summary = summaryOf({
      itemsRevenue: dec('100.00'),
      itemsCost: dec('60.00'),
      writeOffs: 0,
      delivery: delivery(),
      payments: columns(),
    });
    const lines = toCsv(
      summaryCsvColumns<{ summary: AdminMoneySummaryDto }>((row) => row.summary),
      [{ summary }],
    )
      .replace(/^\uFEFF/, '')
      .split('\r\n');

    expect(lines[0]).toBe(
      'income_items,income_delivery,income_total,expense_cost_of_goods,expense_write_offs,' +
        'expense_shipping,expense_other_refunds,expense_total,margin_items,margin_delivery,' +
        'margin_total',
    );
    expect(lines[1]).toBe('100.00,10.00,110.00,60.00,0.00,4.00,25.00,89.00,40.00,6.00,21.00');
  });
});
