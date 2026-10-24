import { prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import { InternalError, isAppError } from '@utils/errors.js';

import { buildSuggestionsQuery } from './helpers/index.js';
import { productViewOf } from './helpers/productMapper.helper.js';

import type {
  ProductSuggestionsDto,
  ProductSuggestionsResponseDto,
} from 'types/dto/products.dto.js';
import type { ProductId } from 'types/ids.js';

// up to 8 names of the catalog for what a person types, forgiving a typo, the best match first;
// a product taken out of the catalog is not among them, nor one without an image for a buyer
export async function findSuggestions(
  dto: ProductSuggestionsDto,
): Promise<ProductSuggestionsResponseDto> {
  const text = dto.text.trim();
  if (!text) return { items: [] };

  try {
    const rows = await prisma.$transaction(async (tx) => {
      await setActorContext(tx, { actorId: dto.actorId, role: dto.actorRole });
      return tx.$queryRaw<{ id: number; name: string }[]>(
        buildSuggestionsQuery(text, productViewOf(dto.actorRole)),
      );
    });

    return { items: rows.map((row) => ({ id: row.id as ProductId, name: row.name })) };
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_SUGGESTIONS_UNEXPECTED' }, err);
  }
}
