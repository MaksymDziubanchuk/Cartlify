import { Prisma } from '@prisma/client';

import { getPgMessage, isRetryableTxError, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { isSaleOn } from '@helpers/productSale.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import {
  BadRequestError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';

import {
  assertCategoryExists,
  computeSalePrice,
  normalizeSaleEnd,
  putSaleOn,
} from './helpers/index.js';

import type {
  ProductSaleDto,
  ProductSalesResponseDto,
  ProductSalesResultDto,
  SetProductSalesDto,
} from 'types/dto/products.dto.js';
import type { ProductId } from 'types/ids.js';

type Planned = { productId: number; sale: ProductSaleDto; endsAt: Date };

// the codes of a sale that does not fit the price of a product, the first one found named for the
// whole request with every product it holds for
const SALE_PRICE_CODES = ['PRODUCT_SALE_AMOUNT_TOO_HIGH', 'PRODUCT_SALE_TOO_SMALL'] as const;

// sales of many products at once, all of them or none (POST /api/products/sales): a sale for each
// product, or one sale for the products of the catalog of a category and its branch. Each sale is
// the step of the sale route (putSaleOn) with every line of the logs; a product that has the same
// sale already stays as it is (unchanged). The rows are locked by id, in every request
export async function setProductSales(dto: SetProductSalesDto): Promise<ProductSalesResponseDto> {
  const { actorId, actorRole } = dto;
  assertAdminActor(actorId, actorRole);

  // the ends first: a sale starts right away and ends in the future
  const itemsIn = 'items' in dto ? dto.items : null;
  if (itemsIn) {
    const seen = new Set<number>();
    const repeated = new Set<number>();
    for (const item of itemsIn) {
      if (seen.has(item.productId)) repeated.add(item.productId);
      seen.add(item.productId);
    }
    if (repeated.size) {
      throw new BadRequestError('SALE_PRODUCTS_REPEATED', { productIds: [...repeated] });
    }
  }
  const late = (itemsIn ?? []).filter((item) => !endsAhead(item.sale.endsAt));
  if (late.length) {
    throw new BadRequestError('PRODUCT_SALE_ENDS_AT_INVALID', {
      productIds: late.map((item) => item.productId),
    });
  }
  const categorySale = 'items' in dto ? null : dto;
  const categoryEnd = categorySale ? normalizeSaleEnd(categorySale.sale.endsAt) : null;

  try {
    return await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // what to put on: the items as they are, or each product of the catalog of the category
        let planned: Planned[];
        if (categorySale) {
          await assertCategoryExists(db, categorySale.categoryId);
          const rows = await db.$queryRaw<{ id: number }[]>(
            categorySale.branch === false
              ? Prisma.sql`
                  select id from cartlify.products
                  where "categoryId" = ${categorySale.categoryId}::int and "deletedAt" is null
                  order by id`
              : Prisma.sql`
                  with recursive branch as (
                    select id from cartlify.categories where id = ${categorySale.categoryId}::int
                    union
                    select c.id from cartlify.categories c join branch b on c."parentId" = b.id
                  )
                  select p.id from cartlify.products p
                  where p."categoryId" in (select id from branch) and p."deletedAt" is null
                  order by p.id`,
          );
          planned = rows.map((row) => ({
            productId: row.id,
            sale: categorySale.sale,
            endsAt: categoryEnd!,
          }));
        } else {
          planned = itemsIn!.map((item) => ({
            productId: item.productId,
            sale: item.sale,
            endsAt: new Date(item.sale.endsAt),
          }));
        }
        if (!planned.length) return { products: [] };

        // the prices the sales are counted from cannot change until every sale is written
        const ids = [...new Set(planned.map((item) => item.productId))].sort((a, b) => a - b);
        await db.$queryRaw`
          select id from cartlify.products where id = any(${ids}::int[]) order by id for update
        `;
        const rows = await db.product.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            name: true,
            price: true,
            salePrice: true,
            saleEndsAt: true,
            salePriorPrice: true,
            deletedAt: true,
          },
        });
        const byId = new Map(rows.map((row) => [row.id, row]));

        // a product taken out of the catalog sells no more, a sale of it is no use
        const missing = ids.filter((id) => !byId.get(id) || byId.get(id)!.deletedAt);
        if (missing.length) throw new NotFoundError('PRODUCT_NOT_FOUND', { productIds: missing });

        // every sale fits its price, or none is put on: the products each refusal holds for
        assertSalesFit(planned, byId);

        const results = new Map<number, ProductSalesResultDto>();
        for (const item of [...planned].sort((a, b) => a.productId - b.productId)) {
          const before = byId.get(item.productId)!;
          const { salePrice } = computeSalePrice(before.price, item.sale);

          // the same sale that is on is done already
          const same =
            isSaleOn(before) &&
            salePrice.equals(before.salePrice!) &&
            before.saleEndsAt!.getTime() === item.endsAt.getTime();

          const after = same
            ? before
            : await putSaleOn(
                { db, actorId, actorRole, source: 'bulk' },
                before,
                item.sale,
                item.endsAt,
              );

          results.set(item.productId, {
            id: after.id as ProductId,
            name: after.name,
            price: decimalToNumber(after.price),
            salePrice: decimalToNumber(after.salePrice),
            saleEndsAt: after.saleEndsAt!.toISOString(),
            salePriorPrice:
              after.salePriorPrice == null ? null : decimalToNumber(after.salePriorPrice),
            status: same ? 'unchanged' : 'set',
          });
        }

        return { products: planned.map((item) => results.get(item.productId)!) };
      },
      {
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 30_000,
      },
    );
  } catch (err) {
    if (isAppError(err)) throw err;

    // map lock/tx contention errors to a stable 409 for clients
    if (isRetryableTxError(err)) throw new ResourceBusyError();

    // the end went by between the check and the write, by the clock of the database (db/05)
    if (String(getPgMessage(err) ?? '').includes('PRODUCT_SALE_ENDS_AT_INVALID')) {
      throw new BadRequestError('PRODUCT_SALE_ENDS_AT_INVALID');
    }

    throw new InternalError({ reason: 'PRODUCTS_SALES_UNEXPECTED' }, err);
  }
}

const endsAhead = (endsAt: string) => {
  try {
    normalizeSaleEnd(endsAt);
    return true;
  } catch {
    return false;
  }
};

// a sale that does not fit the price of its product: an amount above the price, a discount that
// rounds to nothing. The first such code names the request, with every product it holds for
function assertSalesFit(planned: Planned[], byId: Map<number, { price: Prisma.Decimal }>): void {
  const refused = new Map<string, Array<{ productId: number; price?: number }>>();

  for (const item of planned) {
    const { price } = byId.get(item.productId)!;
    try {
      computeSalePrice(price, item.sale);
    } catch (err) {
      if (!(err instanceof BadRequestError)) throw err;
      const list = refused.get(err.errorCode) ?? [];
      list.push(
        err.errorCode === 'PRODUCT_SALE_AMOUNT_TOO_HIGH'
          ? { productId: item.productId, price: decimalToNumber(price) }
          : { productId: item.productId },
      );
      refused.set(err.errorCode, list);
    }
  }

  for (const code of SALE_PRICE_CODES) {
    const products = refused.get(code);
    if (products) throw new BadRequestError(code, { products });
  }
}
