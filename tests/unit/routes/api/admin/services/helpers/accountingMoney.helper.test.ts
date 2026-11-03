import { describe, expect, it } from '@jest/globals';

import { Prisma } from '@prisma/client';

import { moneyCsvColumns } from '@routes/api/admin/services/helpers/accountingCsv.helper.js';
import {
  moneyOf,
  type MoneyColumns,
} from '@routes/api/admin/services/helpers/accountingSql.helper.js';
import { toCsv } from '@helpers/csv.js';

// the money of a row of a report as the answers give it: the sales of the orders paid in the
// period, the returns whose money went back in it, the net (the sales less the returns), the
// write-offs and the margin after them, the purchases and the stock (opening, received, left,
// closing, on the way back). Decimals, not floats; the percents are of the revenue

const dec = (value: string) => new Prisma.Decimal(value);

const columns = (patch: Partial<MoneyColumns> = {}): MoneyColumns => ({
  sold_units: 10n,
  sold_revenue: dec('100.00'),
  sold_cost: dec('60.00'),
  returned_units: 2n,
  returned_revenue: dec('20.00'),
  returned_cost: dec('12.00'),
  written_units: 1n,
  written_value: dec('5.00'),
  bought_units: 20n,
  bought_value: dec('150.00'),
  stock_open_units: 5n,
  stock_open_value: dec('30.00'),
  stock_in_units: 22n,
  stock_in_value: dec('162.00'),
  stock_out_units: 11n,
  stock_out_value: dec('65.00'),
  stock_units: 16n,
  stock_value: dec('127.00'),
  way_units: 1n,
  way_value: dec('6.00'),
  ...patch,
});

describe('moneyOf', () => {
  it('gives the sales, the returns and the net as the sales less the returns', () => {
    const out = moneyOf(columns());

    expect(out.sales).toEqual({
      units: 10,
      revenue: 100,
      cost: 60,
      margin: 40,
      marginPercent: 40,
    });
    expect(out.returns).toEqual({ units: 2, revenue: 20, cost: 12 });
    // 100 - 20 of the money, 60 - 12 of the cost
    expect(out.net).toEqual({ units: 8, revenue: 80, cost: 48, margin: 32, marginPercent: 40 });
  });

  it('takes the write-offs off the margin of the net, not of the sales', () => {
    const out = moneyOf(columns());

    expect(out.writeOffs).toEqual({ units: 1, value: 5 });
    // 32 - 5, of the 80 of the net
    expect(out.afterWriteOffs).toEqual({ margin: 27, marginPercent: 33.75 });
  });

  it('gives a negative net for a period that has returns of earlier sales and no sales', () => {
    const out = moneyOf(
      columns({
        sold_units: 0n,
        sold_revenue: dec('0'),
        sold_cost: dec('0'),
        written_units: 0n,
        written_value: dec('0'),
      }),
    );

    expect(out.sales).toEqual({ units: 0, revenue: 0, cost: 0, margin: 0, marginPercent: null });
    expect(out.net).toEqual({
      units: -2,
      revenue: -20,
      cost: -12,
      margin: -8,
      marginPercent: 40,
    });
  });

  it('gives no percent where the net has no revenue', () => {
    const out = moneyOf(columns({ returned_revenue: dec('100.00'), returned_cost: dec('60.00') }));

    expect(out.net).toMatchObject({ revenue: 0, margin: 0, marginPercent: null });
    expect(out.afterWriteOffs).toEqual({ margin: -5, marginPercent: null });
  });

  it('adds the money in decimals', () => {
    const out = moneyOf(
      columns({
        sold_revenue: dec('0.30'),
        sold_cost: dec('0.10'),
        returned_revenue: dec('0.10'),
        returned_cost: dec('0.10'),
        written_value: dec('0.10'),
      }),
    );

    expect(out.net.revenue).toBe(0.2);
    expect(out.net.margin).toBe(0.2);
    expect(out.afterWriteOffs.margin).toBe(0.1);
  });

  it('gives the stock of the period: opening, what came in and went out, the end, and the goods on the way back', () => {
    expect(moneyOf(columns()).stock).toEqual({
      opening: { units: 5, value: 30 },
      received: { units: 22, value: 162 },
      left: { units: 11, value: 65 },
      closing: { units: 16, value: 127 },
      onTheWayBack: { units: 1, value: 6 },
    });
  });

  it('gives a stock of zeros for a row that has none of it (the steps of a timeline)', () => {
    const zero = { units: 0, value: 0 };
    const row: MoneyColumns = {
      sold_units: 1,
      sold_revenue: '10',
      sold_cost: '4',
      returned_units: 0,
      returned_revenue: 0,
      returned_cost: 0,
      written_units: 0,
      written_value: 0,
      bought_units: 0,
      bought_value: 0,
    };

    expect(moneyOf(row).stock).toEqual({
      opening: zero,
      received: zero,
      left: zero,
      closing: zero,
      onTheWayBack: zero,
    });
  });

  it('takes the numbers a database gives as text, big integers or numbers', () => {
    const out = moneyOf(
      columns({
        sold_units: '4' as unknown as number,
        sold_revenue: '10.005',
        sold_cost: 4,
        returned_units: 0,
        returned_revenue: '0',
        returned_cost: 0n as unknown as number,
      }),
    );

    expect(out.sales.revenue).toBe(10.01);
    expect(out.net.units).toBe(4);
  });
});

describe('moneyCsvColumns', () => {
  const csv = (rows: MoneyColumns[], stock: boolean) =>
    toCsv(
      moneyCsvColumns<MoneyColumns>((row) => moneyOf(row), { stock }),
      rows,
    )
      .replace(/^\uFEFF/, '')
      .split('\r\n');

  it('names the returns, the net and the stock columns, and gives the row', () => {
    const [header, line] = csv([columns()], true);

    expect(header).toBe(
      [
        'sold_units,sold_revenue,sold_cost,sold_margin,sold_margin_percent',
        'returned_units,returned_revenue,returned_cost',
        'net_units,net_revenue,net_cost,net_margin,net_margin_percent',
        'written_off_units,written_off_value',
        'margin_after_write_offs,margin_after_write_offs_percent',
        'purchased_units,purchased_value',
        'stock_opening_units,stock_opening_value',
        'stock_received_units,stock_received_value',
        'stock_left_units,stock_left_value',
        'stock_closing_units,stock_closing_value',
        'stock_on_the_way_back_units,stock_on_the_way_back_value',
      ].join(','),
    );
    expect(line).toBe(
      [
        '10,100.00,60.00,40.00,40.00',
        '2,20.00,12.00',
        '8,80.00,48.00,32.00,40.00',
        '1,5.00',
        '27.00,33.75',
        '20,150.00',
        '5,30.00',
        '22,162.00',
        '11,65.00',
        '16,127.00',
        '1,6.00',
      ].join(','),
    );
  });

  it('leaves the stock columns out of a report of the steps of time', () => {
    const [header] = csv([columns()], false);

    expect(header).not.toContain('stock_');
    expect(header).toContain('net_margin_percent');
  });
});
