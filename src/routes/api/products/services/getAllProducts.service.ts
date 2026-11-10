import { prisma } from '@db/client.js';
import { setShopDayContext, setUserContext } from '@db/dbContext.service.js';
import { resolveCharacteristicFilter } from '@helpers/characteristicFilter.js';

import {
  normalizeFindAllProductsInput,
  makeNextCursor,
  buildProductIdsQuery,
  buildTotalQuery,
  assertListTargets,
  readListRows,
  type ProductKeyRow,
} from './helpers/index.js';
import { InternalError, isAppError } from '@utils/errors.js';

import type { ProductsResponseDto, ReadProductsDto } from 'types/dto/products.dto.js';

// the catalog list of a buyer or of an admin. A row is a product, or a group of variants (the ones
// of a product with the same main characteristics) when the query asks something of a variant (see
// ListMode). The price a variant sells at and its sale depend on the
// time (cartlify.product_current_price), so one raw query finds the ids of the page (variants or
// products) and the values of their sort; Prisma reads the rows of those ids. The free units leave
// out the units of batches that are over by the day of the shop, which the transaction carries
export async function findAll(dto: ReadProductsDto): Promise<ProductsResponseDto> {
  const q = normalizeFindAllProductsInput(dto);

  try {
    return await prisma.$transaction(async (tx) => {
      // an admin reads the cost of the latest delivery of each variant: admins alone read batches
      if (q.view === 'admin') {
        await setUserContext(tx, { userId: dto.actorId!, role: dto.actorRole });
      } else {
        await setShopDayContext(tx);
      }

      // the filter by characteristics: the characteristics are there, fit the entries and have the
      // values asked (one query, only when there is a filter)
      await resolveCharacteristicFilter(tx, q.characteristics ?? []);

      // the party and the document an admin filters by are there (404 when one is not)
      await assertListTargets(tx, q);

      const keyRows = await tx.$queryRaw<ProductKeyRow[]>(buildProductIdsQuery(q));
      const [counted] = await tx.$queryRaw<{ total: number }[]>(buildTotalQuery(q));
      const total = counted?.total ?? 0;

      // detect next page
      const hasNext = keyRows.length > q.limit;
      const pageRows = hasNext ? keyRows.slice(0, q.limit) : keyRows;

      // empty page
      if (!pageRows.length) return { items: [], limit: q.limit, total };

      return {
        items: await readListRows(tx, q, pageRows),
        limit: q.limit,
        total,
        ...(hasNext ? { nextCursor: makeNextCursor(q, pageRows[pageRows.length - 1]!) } : {}),
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_FIND_ALL_UNEXPECTED' }, err);
  }
}
