import { ConflictError, NotFoundError } from '@utils/errors.js';

import {
  applySales,
  nothingChanged,
  normalizeFindProductByIdInput,
  normalizeSaleEnd,
  saleRowSelect,
} from './helpers/index.js';
import { inVariantTx, lockVariants } from './helpers/variantTx.helper.js';

import type { PlannedSale, SaleRow } from './helpers/index.js';
import type { SetProductSaleDto, SetProductSaleResponseDto } from 'types/dto/products.dto.js';

// puts the variants of a product on sale until an end in the future, or takes their sales off
// (sale null). The variants are the ones named (variantIds, the ones for sale of this product), or
// every variant for sale. The database keeps the sale price: while the sale lasts the variant sells
// at it (db/05). A new sale writes over the one there is, an ended one too. The log of prices gets
// the start of a sale (from the price to the sale price in the mode of the discount, its size
// negative, and the end) and a sale taken off while it was on (from the sale price back to the
// price, by an amount); the admin log gets each of them as a sale (PRODUCT_SALE, about the
// variant): start, change or removed. Every sale is counted from the price of its variant, an
// amount off is the same money for each: if it does not fit one price (above it, or nothing) the
// whole request is refused and names those variants. A sale that was over is no sale: a new one
// over it starts. The answer gives the state of each variant (set, unchanged, removed); a request
// that leaves every variant as it was, the same sale that is on or no sale to take off, is done
// already: 409 and nothing is written
export async function setProductSale({
  productId: rawProductId,
  variantIds,
  actorId,
  actorRole,
  sale,
}: SetProductSaleDto): Promise<SetProductSaleResponseDto> {
  const { productId } = normalizeFindProductByIdInput({ productId: rawProductId });

  // a sale starts right away, its end is in the future
  const endsAt = sale ? normalizeSaleEnd(sale.endsAt) : null;

  return inVariantTx({ actorId, actorRole }, 'PRODUCTS_SALE_UNEXPECTED', async (db) => {
    const product = await db.product.findUnique({
      where: { id: productId },
      select: { id: true, deletedAt: true },
    });
    // a product removed from the catalog sells no more, a sale of it is no use
    if (!product || product.deletedAt) throw new NotFoundError('PRODUCT_NOT_FOUND');

    // the variants for sale: the ones named, or all of them by their place
    const there = await db.productVariant.findMany({
      where: { productId, deletedAt: null, ...(variantIds ? { id: { in: variantIds } } : {}) },
      select: { id: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    const found = new Set(there.map((row) => row.id));
    const missing = (variantIds ?? []).filter((id) => !found.has(id));
    if (missing.length) throw new NotFoundError('VARIANT_NOT_FOUND', { variantIds: missing });
    if (!there.length) throw new NotFoundError('VARIANT_NOT_FOUND');

    // the prices the sales are counted from cannot change until the sales are written
    await lockVariants(db, [...found]);
    const rows = await db.productVariant.findMany({
      where: { id: { in: [...found] } },
      select: saleRowSelect,
    });
    const byId = new Map<number, SaleRow>(rows.map((row) => [row.id, row]));

    const order = variantIds ?? there.map((row) => row.id);
    const planned: PlannedSale[] = order.map((variantId) => ({ variantId, sale, endsAt }));

    const results = await applySales({ db, actorId, actorRole }, planned, byId);

    // done already: nothing was written
    if (nothingChanged(results.values())) {
      throw new ConflictError(sale ? 'PRODUCT_SALE_ALREADY_SET' : 'PRODUCT_SALE_ALREADY_REMOVED', {
        variantIds: order,
      });
    }

    return { variants: order.map((id) => results.get(id)!) };
  });
}
