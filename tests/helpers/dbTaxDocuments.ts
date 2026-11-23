import { randomBytes } from 'node:crypto';

import type { DbSession } from './db.js';
import { cartOf, confirm, pay } from './dbOrders.js';

// the tax documents the database makes (docs/taxes.md), for the tests of the database: the data of
// the shop they copy, written in the transaction of the test only, and an order paid with its tax,
// which makes the invoice

// a prefix no other test takes
export const seriesPrefix = () => `T${randomBytes(4).toString('hex').toUpperCase().slice(0, 7)}`;

export type InvoiceSeries = { invoice: string; credit: string };

// root writes the data of the shop that the documents copy: the series of its own, the seller and the
// text at the bottom
export async function invoiceShopOf(
  db: DbSession,
  rootId: number,
  mode: 'every_order' | 'on_request' = 'every_order',
  series: InvoiceSeries = { invoice: seriesPrefix(), credit: seriesPrefix() },
): Promise<InvoiceSeries> {
  await db.as({ role: 'ROOT', userId: rootId });
  for (const [key, value] of [
    ['invoiceMode', mode],
    ['invoicePrefix', series.invoice],
    ['creditNotePrefix', series.credit],
    ['invoiceYearly', false],
    ['sellerLegalName', 'Cartlify S.L.'],
    ['sellerAddress', 'Calle Mayor 1, Madrid'],
    ['sellerTaxId', 'ESB12345678'],
    ['sellerTaxIdLabel', 'NIF'],
    ['sellerCountry', 'ES'],
    ['documentFooter', 'Registro Mercantil de Madrid'],
  ] as const) {
    await db.rows(
      `insert into cartlify.shop_settings (key, value, "setById") values ($1, $2::jsonb, $3)`,
      key,
      JSON.stringify(value),
      rootId,
    );
  }
  return series;
}

// root writes when the shop registers the receipt of a sale (null: the shop makes no receipts)
export async function receiptMomentOf(
  db: DbSession,
  rootId: number,
  moment: 'payment' | 'shipment' | null,
): Promise<void> {
  await db.as({ role: 'ROOT', userId: rootId });
  await db.rows(
    `insert into cartlify.shop_settings (key, value, "setById") values ('receiptMoment', $1::jsonb, $2)`,
    JSON.stringify(moment),
    rootId,
  );
}

// the tax of a line of the price given at the rate, half up (null: no tax)
const taxIn = (gross: number, rate: number | null) =>
  rate === null ? 0 : Math.round(((gross * rate) / (100 + rate)) * 100 + Number.EPSILON) / 100;

// a paid order of the buyer: two units at 10 of each variant and a delivery of 5, taxed by the rule
// in the country at the rate given (Spain by the rule seller at 20 % unless said: 3.33 of each item,
// 0.83 of the delivery; a rate null holds no tax). The invoice comes with the payment (on request:
// when the buyer asked for one)
export async function invoicedOrderOf(
  db: DbSession,
  who: { buyerId: number; adminId: number; variantId?: number; variantIds?: number[] },
  invoice = false,
  rule: { rule: string; country: string; rate: number | null } = {
    rule: 'seller',
    country: 'ES',
    rate: 20,
  },
): Promise<number> {
  const variants = who.variantIds ?? [who.variantId!];
  const orderId = await cartOf(
    db,
    who.buyerId,
    variants.map((variantId) => [variantId, 2] as [number, number]),
  );
  await db.as({ role: 'ADMIN', userId: who.adminId });
  const items = await db.rows<{ id: number }>(
    `select id from cartlify.order_items where "orderId" = $1 order by id`,
    orderId,
  );
  const confirmed = await confirm(db, who.buyerId, orderId, '15 minutes', {
    flat: 5,
    expected: 5,
    invoice,
    tax: {
      items: items.map((item) => ({
        id: item.id,
        rule: rule.rule,
        country: rule.country,
        groupId: null,
        rate: rule.rate,
        unitPrice: 10,
        tax: taxIn(20, rule.rate),
      })),
      delivery: {
        rule: rule.rule,
        parts: rule.rate === null ? [] : [{ rate: rule.rate, gross: 5, tax: taxIn(5, rule.rate) }],
      },
    },
  });
  if (!confirmed.ok) throw new Error(`confirm_order refused: ${confirmed.message}`);
  const paid = await pay(db, who.adminId, orderId, { currency: 'EUR' });
  if (paid !== 'PAID') throw new Error(`the order was not paid: ${String(paid)}`);
  return orderId;
}
