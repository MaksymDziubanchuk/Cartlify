import { Prisma } from '@prisma/client';

import { getPgCode, prisma } from '@db/client.js';
import { MAX_PRODUCT_DOCUMENTS } from '@config/limits.js';
import { BadRequestError, NotFoundError } from '@utils/errors.js';
import { MAX_ID } from '@schemas/idPathParam.js';

import type { ProductDocumentDto } from 'types/dto/products.dto.js';

// the documents a product names (instructions, certificates), parties of the directory of documents
// (src/routes/api/documents): a product names them by their ids, in the order given, and the list
// is written whole

type Tx = Prisma.TransactionClient;

// the ids of a request: a text of a form (ids with a comma between, empty for none), an array of a
// json body, null for none; undefined when the request names no list. A value that is not a whole
// number of at least 1 is 400 DOCUMENT_ID_INVALID, more than MAX_PRODUCT_DOCUMENTS is 400
// PRODUCT_DOCUMENTS_TOO_MANY, an id twice is 400 DOCUMENT_IDS_REPEATED
export function readDocumentIds(raw: unknown): number[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return [];

  const parts: unknown[] =
    typeof raw === 'string'
      ? raw.trim()
        ? raw.split(',').map((part) => part.trim())
        : []
      : Array.isArray(raw)
        ? raw
        : [raw];

  const ids = parts.map((part) => {
    const id = typeof part === 'string' && /^[1-9][0-9]*$/.test(part) ? Number(part) : part;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > MAX_ID) {
      throw new BadRequestError('DOCUMENT_ID_INVALID');
    }
    return id;
  });

  if (ids.length > MAX_PRODUCT_DOCUMENTS) {
    throw new BadRequestError('PRODUCT_DOCUMENTS_TOO_MANY', { max: MAX_PRODUCT_DOCUMENTS });
  }

  const repeated = [...new Set(ids.filter((id, at) => ids.indexOf(id) !== at))];
  if (repeated.length) throw new BadRequestError('DOCUMENT_IDS_REPEATED', { ids: repeated });

  return ids;
}

// every id is a document of the directory; the ones that are not are 404 DOCUMENTS_NOT_FOUND
export async function assertDocumentsExist(tx: Tx, ids: number[]): Promise<void> {
  if (!ids.length) return;

  const rows = await tx.document.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const found = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));

  if (missing.length) throw new NotFoundError('DOCUMENTS_NOT_FOUND', { documentIds: missing });
}

// the ids of the documents of a product, in their order
export async function readProductDocumentIds(tx: Tx, productId: number): Promise<number[]> {
  const rows = await tx.productDocument.findMany({
    where: { productId },
    orderBy: { position: 'asc' },
    select: { documentId: true },
  });

  return rows.map((row) => row.documentId);
}

// writes the list whole: the old rows go, the new ones come in their order from 1
export async function replaceProductDocuments(
  tx: Tx,
  productId: number,
  ids: number[],
): Promise<void> {
  await tx.productDocument.deleteMany({ where: { productId } });

  if (!ids.length) return;

  try {
    await tx.productDocument.createMany({
      data: ids.map((documentId, at) => ({ productId, documentId, position: at + 1 })),
    });
  } catch (err) {
    // a document another admin deleted between the check and this write: the key of the database
    // holds, and the answer is the one of a document that is not there
    const missing =
      (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') ||
      getPgCode(err) === '23503';
    if (missing) throw new NotFoundError('DOCUMENTS_NOT_FOUND', { documentIds: ids });

    throw err;
  }
}

// the documents of the products of an answer, in their order, read once for all of them; a document
// is read by everybody, so the read needs no context of its own
export async function readDocumentsOf(
  productIds: number[],
): Promise<Map<number, ProductDocumentDto[]>> {
  const byProduct = new Map<number, ProductDocumentDto[]>(productIds.map((id) => [id, []]));
  if (!productIds.length) return byProduct;

  const rows = await prisma.productDocument.findMany({
    where: { productId: { in: productIds } },
    orderBy: [{ productId: 'asc' }, { position: 'asc' }],
    select: {
      productId: true,
      document: { select: { id: true, title: true, kind: true, url: true } },
    },
  });
  for (const row of rows) byProduct.get(row.productId)!.push(row.document);

  return byProduct;
}
