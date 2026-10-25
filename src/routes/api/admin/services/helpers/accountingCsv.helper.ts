import type { CsvColumn } from '@helpers/csv.js';

import type { AdminMoneyBreakdownDto } from 'types/dto/admin.dto.js';

// the money columns of a csv of the reports, the same names in every file
export function moneyCsvColumns<T>(
  moneyOf: (row: T) => Partial<AdminMoneyBreakdownDto> & Omit<AdminMoneyBreakdownDto, 'stock'>,
  opts: { stock: boolean },
): CsvColumn<T>[] {
  const columns: CsvColumn<T>[] = [
    { header: 'sold_units', kind: 'number', value: (row) => moneyOf(row).sales.units },
    { header: 'sold_revenue', kind: 'money', value: (row) => moneyOf(row).sales.revenue },
    { header: 'sold_cost', kind: 'money', value: (row) => moneyOf(row).sales.cost },
    { header: 'sold_margin', kind: 'money', value: (row) => moneyOf(row).sales.margin },
    { header: 'cancelled_units', kind: 'number', value: (row) => moneyOf(row).cancellations.units },
    {
      header: 'cancelled_revenue',
      kind: 'money',
      value: (row) => moneyOf(row).cancellations.revenue,
    },
    { header: 'cancelled_cost', kind: 'money', value: (row) => moneyOf(row).cancellations.cost },
    { header: 'net_units', kind: 'number', value: (row) => moneyOf(row).net.units },
    { header: 'net_revenue', kind: 'money', value: (row) => moneyOf(row).net.revenue },
    { header: 'net_cost', kind: 'money', value: (row) => moneyOf(row).net.cost },
    { header: 'net_margin', kind: 'money', value: (row) => moneyOf(row).net.margin },
    {
      header: 'net_margin_percent',
      kind: 'money',
      value: (row) => moneyOf(row).net.marginPercent,
    },
    { header: 'written_off_units', kind: 'number', value: (row) => moneyOf(row).writeOffs.units },
    { header: 'written_off_value', kind: 'money', value: (row) => moneyOf(row).writeOffs.value },
    { header: 'purchased_units', kind: 'number', value: (row) => moneyOf(row).purchases.units },
    { header: 'purchased_value', kind: 'money', value: (row) => moneyOf(row).purchases.value },
  ];

  if (opts.stock) {
    columns.push(
      { header: 'stock_units', kind: 'number', value: (row) => moneyOf(row).stock?.units },
      { header: 'stock_value', kind: 'money', value: (row) => moneyOf(row).stock?.value },
    );
  }

  return columns;
}

// the name of the file of a report: the report and its period by the days of utc
export const csvFileName = (report: string, from: Date, to: Date) =>
  `accounting-${report}-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv`;
