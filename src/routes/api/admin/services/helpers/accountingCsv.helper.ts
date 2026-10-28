import type { CsvColumn } from '@helpers/csv.js';

import type {
  AdminDeliveryMoneyDto,
  AdminMoneyBreakdownDto,
  AdminMoneySummaryDto,
} from 'types/dto/admin.dto.js';

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
    {
      header: 'sold_margin_percent',
      kind: 'money',
      value: (row) => moneyOf(row).sales.marginPercent,
    },
    { header: 'cancelled_units', kind: 'number', value: (row) => moneyOf(row).cancellations.units },
    {
      header: 'cancelled_revenue',
      kind: 'money',
      value: (row) => moneyOf(row).cancellations.revenue,
    },
    { header: 'cancelled_cost', kind: 'money', value: (row) => moneyOf(row).cancellations.cost },
    { header: 'written_off_units', kind: 'number', value: (row) => moneyOf(row).writeOffs.units },
    { header: 'written_off_value', kind: 'money', value: (row) => moneyOf(row).writeOffs.value },
    {
      header: 'margin_after_write_offs',
      kind: 'money',
      value: (row) => moneyOf(row).afterWriteOffs.margin,
    },
    {
      header: 'margin_after_write_offs_percent',
      kind: 'money',
      value: (row) => moneyOf(row).afterWriteOffs.marginPercent,
    },
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

// the delivery columns of a csv of the reports: empty for a report of some products
export function deliveryCsvColumns<T>(
  deliveryOf: (row: T) => AdminDeliveryMoneyDto | null,
): CsvColumn<T>[] {
  return [
    { header: 'delivery_income', kind: 'money', value: (row) => deliveryOf(row)?.income.revenue },
    {
      header: 'delivery_refunded',
      kind: 'money',
      value: (row) => deliveryOf(row)?.refunded.revenue,
    },
    { header: 'shipping_sends', kind: 'number', value: (row) => deliveryOf(row)?.shipping.sends },
    { header: 'shipping_cost', kind: 'money', value: (row) => deliveryOf(row)?.shipping.cost },
    {
      header: 'shipping_sends_without_cost',
      kind: 'number',
      value: (row) => deliveryOf(row)?.shipping.withoutCost,
    },
    { header: 'delivery_result', kind: 'money', value: (row) => deliveryOf(row)?.result },
  ];
}

// the columns of the income, the expenses and the margins; the delivery and the sends are empty
// for a report of some products
export function summaryCsvColumns<T>(summaryOf: (row: T) => AdminMoneySummaryDto): CsvColumn<T>[] {
  return [
    { header: 'income_items', kind: 'money', value: (row) => summaryOf(row).income.items },
    { header: 'income_delivery', kind: 'money', value: (row) => summaryOf(row).income.delivery },
    { header: 'income_total', kind: 'money', value: (row) => summaryOf(row).income.total },
    {
      header: 'expense_cost_of_goods',
      kind: 'money',
      value: (row) => summaryOf(row).expenses.costOfGoods,
    },
    {
      header: 'expense_write_offs',
      kind: 'money',
      value: (row) => summaryOf(row).expenses.writeOffs,
    },
    { header: 'expense_shipping', kind: 'money', value: (row) => summaryOf(row).expenses.shipping },
    { header: 'expense_total', kind: 'money', value: (row) => summaryOf(row).expenses.total },
    { header: 'margin_items', kind: 'money', value: (row) => summaryOf(row).margin.items },
    { header: 'margin_delivery', kind: 'money', value: (row) => summaryOf(row).margin.delivery },
    { header: 'margin_total', kind: 'money', value: (row) => summaryOf(row).margin.total },
  ];
}

// the name of the file of a report: the report and its period by the days of utc
export const csvFileName = (report: string, from: Date, to: Date) =>
  `accounting-${report}-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv`;
