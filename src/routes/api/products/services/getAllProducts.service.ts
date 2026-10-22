import { prisma } from '@db/client.js';

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
// values of their sort; Prisma reads the rows of those ids
export async function findAll(dto: FindAllProductsDto): Promise<ProductsResponseDto> {
  const q = normalizeFindAllProductsInput(dto);

  try {
    const keyRows = await prisma.$queryRaw<ProductKeyRow[]>(buildProductIdsQuery(q));

    // detect next page
    const hasNext = keyRows.length > q.limit;
    const pageRows = hasNext ? keyRows.slice(0, q.limit) : keyRows;

    // empty page
    if (!pageRows.length) return { items: [], limit: q.limit };

    // preserve raw sql order after findMany by ids
    const position = new Map(pageRows.map((row, index) => [row.id, index]));

    const rows = await prisma.product.findMany({
      where: { id: { in: pageRows.map((row) => row.id) } },
      select: productListSelect,
    });
    rows.sort((a, b) => position.get(a.id)! - position.get(b.id)!);

    return {
      items: rows.map((row) => mapProductListRowToResponse(row, q.view)),
      limit: q.limit,
      ...(hasNext ? { nextCursor: makeNextCursor(q, pageRows[pageRows.length - 1]!) } : {}),
    };
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_FIND_ALL_UNEXPECTED' }, err);
  }
}
