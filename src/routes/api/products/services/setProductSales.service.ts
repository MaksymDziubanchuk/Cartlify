import { Prisma } from '@prisma/client';

import { BadRequestError, NotFoundError } from '@utils/errors.js';

import {
  applySales,
  assertCategoryExists,
  normalizeSaleEnd,
  saleRowSelect,
} from './helpers/index.js';
import { inVariantTx, lockVariants } from './helpers/variantTx.helper.js';

import type { PlannedSale, SaleRow } from './helpers/index.js';
import type {
  ProductSalesItemDto,
  ProductSalesResponseDto,
  SetProductSalesDto,
} from 'types/dto/products.dto.js';

// sales of many variants at once, all of them or none (POST /api/products/sales): a sale for each
// variant, or for all the variants of a product (`items`), or one sale for the variants of the
// products of the catalog of a category and its branch. Each sale is the step of the sale route
// (putSaleOn) with every line of the logs; a variant that has the same sale already stays as it is
// (unchanged). The rows are locked by id, in every request
export async function setProductSales(dto: SetProductSalesDto): Promise<ProductSalesResponseDto> {
  const { actorId, actorRole } = dto;
  const itemsIn = 'items' in dto ? dto.items : null;

  // the ends first: a sale starts right away and ends in the future
  const late = (itemsIn ?? []).flatMap((item, index) =>
    endsAhead(item.sale.endsAt)
      ? []
      : [
          {
            index,
            ...(item.variantId !== undefined
              ? { variantId: item.variantId }
              : { productId: item.productId }),
          },
        ],
  );
  if (late.length) throw new BadRequestError('PRODUCT_SALE_ENDS_AT_INVALID', { items: late });

  const categorySale = 'items' in dto ? null : dto;
  const categoryEnd = categorySale ? normalizeSaleEnd(categorySale.sale.endsAt) : null;

  return inVariantTx(
    { actorId, actorRole },
    'PRODUCTS_SALES_UNEXPECTED',
    async (db) => {
      // what to put on: the variants of each item as they are, or each variant of the catalog of the
      // category
      let planned: PlannedSale[];
      if (categorySale) {
        await assertCategoryExists(db, categorySale.categoryId);
        const rows = await db.$queryRaw<{ id: number }[]>(
          categorySale.branch === false
            ? Prisma.sql`
                select v.id from cartlify.product_variants v
                join cartlify.products p on p.id = v."productId"
                where p."categoryId" = ${categorySale.categoryId}::int
                  and p."deletedAt" is null and v."deletedAt" is null
                order by v.id`
            : Prisma.sql`
                with recursive branch as (
                  select id from cartlify.categories where id = ${categorySale.categoryId}::int
                  union
                  select c.id from cartlify.categories c join branch b on c."parentId" = b.id
                )
                select v.id from cartlify.product_variants v
                join cartlify.products p on p.id = v."productId"
                where p."categoryId" in (select id from branch)
                  and p."deletedAt" is null and v."deletedAt" is null
                order by v.id`,
        );
        planned = rows.map((row) => ({
          variantId: row.id,
          sale: categorySale.sale,
          endsAt: categoryEnd!,
        }));
      } else {
        planned = await plannedOfItems(db, itemsIn!);
      }
      if (!planned.length) return { variants: [] };

      // a variant named twice, by itself or by its product too, has two sales to take
      const seen = new Set<number>();
      const repeated = new Set<number>();
      for (const { variantId } of planned) {
        if (seen.has(variantId)) repeated.add(variantId);
        seen.add(variantId);
      }
      if (repeated.size) {
        throw new BadRequestError('SALE_VARIANTS_REPEATED', { variantIds: [...repeated] });
      }

      // the prices the sales are counted from cannot change until every sale is written
      const ids = [...seen];
      await lockVariants(db, ids);
      const rows = await db.productVariant.findMany({
        where: { id: { in: ids } },
        select: saleRowSelect,
      });
      const byId = new Map<number, SaleRow>(rows.map((row) => [row.id, row]));

      const results = await applySales({ db, actorId, actorRole, source: 'bulk' }, planned, byId);

      return { variants: planned.map((item) => results.get(item.variantId)!) };
    },
    { timeout: 30_000 },
  );
}

const endsAhead = (endsAt: string) => {
  try {
    normalizeSaleEnd(endsAt);
    return true;
  } catch {
    return false;
  }
};

// The variants of the items. An item names one variant, or a product: all the variants of it that
// are for sale. A variant that is not for sale, and a product that is out of the catalog, are not
// found; so is a product none of whose variants is for sale (nothing to put on sale). Nothing is put
// on when one is not found
async function plannedOfItems(
  db: Prisma.TransactionClient,
  items: readonly ProductSalesItemDto[],
): Promise<PlannedSale[]> {
  const variantIds = [...new Set(items.flatMap((item) => item.variantId ?? []))];
  const productIds = [...new Set(items.flatMap((item) => item.productId ?? []))];

  const named = variantIds.length
    ? await db.productVariant.findMany({
        where: { id: { in: variantIds }, deletedAt: null, product: { deletedAt: null } },
        select: { id: true },
      })
    : [];
  const missingVariants = variantIds.filter((id) => !named.some((row) => row.id === id));
  if (missingVariants.length) {
    throw new NotFoundError('VARIANT_NOT_FOUND', { variantIds: missingVariants });
  }

  const products = productIds.length
    ? await db.product.findMany({
        where: { id: { in: productIds }, deletedAt: null },
        select: {
          id: true,
          variants: {
            where: { deletedAt: null },
            select: { id: true },
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
          },
        },
      })
    : [];
  const byProduct = new Map(products.map((product) => [product.id, product.variants]));
  const missingProducts = productIds.filter((id) => !byProduct.has(id));
  if (missingProducts.length) {
    throw new NotFoundError('PRODUCT_NOT_FOUND', { productIds: missingProducts });
  }
  const bare = productIds.filter((id) => byProduct.get(id)!.length === 0);
  if (bare.length) throw new NotFoundError('VARIANT_NOT_FOUND', { productIds: bare });

  return items.flatMap((item) => {
    const endsAt = new Date(item.sale.endsAt);
    const ids =
      item.variantId !== undefined
        ? [item.variantId]
        : byProduct.get(item.productId!)!.map((row) => row.id);

    return ids.map((variantId) => ({ variantId, sale: item.sale, endsAt }));
  });
}
