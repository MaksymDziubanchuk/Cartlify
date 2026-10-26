import { prisma } from '@db/client.js';
import { setShopDayContext, setUserContext } from '@db/dbContext.service.js';
import { expiredUnitsOf } from '@db/expiredStock.helper.js';
import { lastUnitCostsOf } from '@db/lastUnitCost.helper.js';

import {
  mapProductListRowToResponse,
  normalizeFindAllProductsInput,
  makeNextCursor,
  buildProductIdsQuery,
  productListSelect,
  type ProductKeyRow,
} from './helpers/index.js';
import { InternalError, isAppError } from '@utils/errors.js';

import type { FindAllProductsDto, ProductsResponseDto } from 'types/dto/products.dto.js';

// the catalog list of a buyer or of an admin. The price a product sells at and its sale depend on
// the time (cartlify.product_current_price), so one raw query finds the ids of the page and the
// values of their sort; Prisma reads the rows of those ids. The free units leave out the units of
// batches that are over by the day of the shop, which the transaction carries
export async function findAll(dto: FindAllProductsDto): Promise<ProductsResponseDto> {
  const q = normalizeFindAllProductsInput(dto);

  try {
    return await prisma.$transaction(async (tx) => {
      // an admin reads the cost of the latest delivery of each product: admins alone read batches
      if (q.view === 'admin') {
        await setUserContext(tx, { userId: dto.actorId!, role: dto.actorRole });
      } else {
        await setShopDayContext(tx);
      }

      const keyRows = await tx.$queryRaw<ProductKeyRow[]>(buildProductIdsQuery(q));

      // detect next page
      const hasNext = keyRows.length > q.limit;
      const pageRows = hasNext ? keyRows.slice(0, q.limit) : keyRows;

      // empty page
      if (!pageRows.length) return { items: [], limit: q.limit };

      // preserve raw sql order after findMany by ids
      const ids = pageRows.map((row) => row.id);
      const position = new Map(ids.map((id, index) => [id, index]));

      const rows = await tx.product.findMany({
        where: { id: { in: ids } },
        select: productListSelect,
      });
      rows.sort((a, b) => position.get(a.id)! - position.get(b.id)!);
      const expired = await expiredUnitsOf(tx, ids);
      const costs = q.view === 'admin' ? await lastUnitCostsOf(tx, ids) : new Map();

      return {
        items: rows.map((row) =>
          mapProductListRowToResponse(
            {
              ...row,
              expiredStock: expired.get(row.id) ?? 0,
              lastUnitCost: costs.get(row.id) ?? null,
            },
            q.view,
          ),
        ),
        limit: q.limit,
        ...(hasNext ? { nextCursor: makeNextCursor(q, pageRows[pageRows.length - 1]!) } : {}),
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_FIND_ALL_UNEXPECTED' }, err);
  }
}
