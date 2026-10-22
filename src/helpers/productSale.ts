import { decimalToNumber } from '@helpers/safeNormalizer.js';

// the sale of a product: a sale price and the end of the sale (db/06 keeps both or neither). It
// lasts while its end is ahead, the way cartlify.product_current_price reads it in the database;
// past the end its fields stay in the row until a new sale writes over them, and mean nothing
export type ProductSaleFields = { salePrice: unknown; saleEndsAt: Date | null };

export function isSaleOn(row: ProductSaleFields, now = Date.now()): boolean {
  return row.salePrice != null && row.saleEndsAt != null && row.saleEndsAt.getTime() > now;
}

// the price the product sells at now: the sale price while the sale lasts, the price otherwise
export function currentPrice(
  row: ProductSaleFields & { price: unknown },
  now = Date.now(),
): number {
  return decimalToNumber(isSaleOn(row, now) ? row.salePrice : row.price);
}

// the sale as an answer shows it, next to the price; a sale that is over is left out
export function saleFieldsOf(
  row: ProductSaleFields,
  now = Date.now(),
): { salePrice: number; saleEndsAt: string } | Record<string, never> {
  if (!isSaleOn(row, now)) return {};

  return { salePrice: decimalToNumber(row.salePrice), saleEndsAt: row.saleEndsAt!.toISOString() };
}
