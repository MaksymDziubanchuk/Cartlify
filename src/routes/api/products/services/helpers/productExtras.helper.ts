import { readDocumentsOf } from './productDocuments.helper.js';
import { readProductParties, type ProductParties } from './productParties.helper.js';

import type { ProductDocumentDto } from 'types/dto/products.dto.js';

// what the card of a product has besides its own row: its parties (the manufacturer and the person
// responsible in the EU) and its documents, read apart (a product row is read with no more than two
// relations beside it)
export type ProductExtras = ProductParties & { documents: ProductDocumentDto[] };

// the extras of the products of an answer, read once for all of them
export async function readProductExtras(
  products: Array<{ id: number; manufacturerId: number; euResponsibleId: number | null }>,
): Promise<
  (row: { id: number; manufacturerId: number; euResponsibleId: number | null }) => ProductExtras
> {
  const partiesOf = await readProductParties(products);
  const documents = await readDocumentsOf(products.map((product) => product.id));

  return (row) => ({ ...partiesOf(row), documents: documents.get(row.id) ?? [] });
}
