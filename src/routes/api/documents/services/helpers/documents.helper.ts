import { Prisma } from '@prisma/client';
import { getPgCode } from '@db/client.js';
import { deleteDocument, requirePdfStream, uploadDocument } from '@utils/cloudinary.util.js';
import { BadRequestError } from '@utils/errors.js';

import type { FastifyBaseLogger } from 'fastify';
import type { DocumentDto, UploadedDocumentFile } from 'types/dto/documents.dto.js';

// how many product ids a refusal names, the rest is counted in details.total
export const NAMED_PRODUCTS_MAX = 20;

export const documentSelect = {
  id: true,
  title: true,
  kind: true,
  url: true,
  sizeBytes: true,
  createdAt: true,
  updatedAt: true,
} as const;

// the file stays out of the answers: its public id is the business of the server, the url is what
// a buyer opens
type DocumentRow = {
  id: number;
  title: string;
  kind: DocumentDto['kind'];
  url: string;
  sizeBytes: number;
  createdAt: Date;
  updatedAt: Date;
};

export const mapDocumentRow = (row: DocumentRow): DocumentDto => ({
  id: row.id,
  title: row.title,
  kind: row.kind,
  url: row.url,
  sizeBytes: row.sizeBytes,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

// how many products name each document
export async function usageOf(
  tx: Prisma.TransactionClient,
  documentIds: number[],
): Promise<Map<number, { products: number }>> {
  const usage = new Map(documentIds.map((id) => [id, { products: 0 }]));
  if (!documentIds.length) return usage;

  const rows = await tx.productDocument.groupBy({
    by: ['documentId'],
    where: { documentId: { in: documentIds } },
    _count: { _all: true },
  });
  for (const row of rows) usage.get(row.documentId)!.products = row._count._all;

  return usage;
}

// the ids of some of the products that name a document, and how many name it
export async function productsNaming(
  tx: Prisma.TransactionClient,
  documentId: number,
): Promise<{ productIds: number[]; total: number }> {
  const rows = await tx.productDocument.findMany({
    where: { documentId },
    select: { productId: true },
    orderBy: { productId: 'asc' },
    take: NAMED_PRODUCTS_MAX,
  });
  const total = await tx.productDocument.count({ where: { documentId } });

  return { productIds: rows.map((row) => row.productId), total };
}

export const isForeignKeyViolation = (err: unknown) =>
  (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') ||
  getPgCode(err) === '23503';

// reads the file of a form into Cloudinary at once: it must be a PDF by its first bytes, an empty
// file and any other file never reach Cloudinary. The row of the document is written after, and a
// refused request deletes the file (discardDocumentUploads)
export async function beginDocumentUpload(file: {
  file: NodeJS.ReadableStream;
  mimetype: string;
}): Promise<UploadedDocumentFile> {
  const stream = file.file as NodeJS.ReadableStream & {
    destroyed?: boolean;
    readableEnded?: boolean;
  };
  if (!stream || stream.destroyed || stream.readableEnded) {
    throw new BadRequestError('DOCUMENT_STREAM_ERROR');
  }

  const safe = await requirePdfStream(file.file, {
    mimetype: file.mimetype,
    emptyCode: 'DOCUMENT_STREAM_ERROR',
  });

  return uploadDocument({ file: safe });
}

// deletes the files of a request that was refused, once each has finished uploading; it never
// throws, a file it cannot delete goes to the log
export async function discardDocumentUploads(
  uploads: ReadonlyArray<Promise<{ publicId: string }>>,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<void> {
  const results = await Promise.allSettled(uploads);

  await Promise.all(
    results.map(async (result) => {
      if (result.status !== 'fulfilled') return;

      try {
        await deleteDocument(result.value.publicId);
      } catch (err) {
        log.warn(
          { err, publicId: result.value.publicId },
          'file of a refused document was not deleted',
        );
      }
    }),
  );
}
