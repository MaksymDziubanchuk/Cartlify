import type { FastifyBaseLogger } from 'fastify';

import { prisma } from '@db/client.js';
import {
  deleteImage,
  isOwnFile,
  makePublicId,
  moveImage,
  type UploadImageResult,
} from '@utils/cloudinary.util.js';

import type { Prisma } from '@prisma/client';
import type { ProductId } from 'types/ids.js';
import type { UploadedProductImage } from 'types/dto/products.dto.js';

export async function persistProductImages(args: {
  tx: Prisma.TransactionClient;
  productId: ProductId;
  uploads: UploadedProductImage[];
}): Promise<void> {
  // persist cloudinary pointers for product images
  if (!args.uploads.length) return;

  await args.tx.productImage.createMany({
    data: args.uploads.map((u) => ({
      productId: args.productId,
      url: u.urlBase,
      publicId: u.publicId,
      alt: u.alt ?? null,
      position: u.position,
      isPrimary: u.position === 0,
    })),
  });
}

// the uploads of a request wait under ids of their own until the product rows are written; then
// each takes its place at <env>/products/<id>/<the key of its upload> and its row gets the url of
// the file there. The key is new for every upload: a move never lands on a file the product shows,
// so a move that fails in the middle leaves every image of the product as it was, and the files
// the product no longer has go after the commit. It runs last in the transaction. A retried
// transaction finds the files it moved already in `moved`.
// Gives the public ids the images have now
export async function placeProductImages(args: {
  tx: Prisma.TransactionClient;
  productId: ProductId;
  uploads: UploadedProductImage[];
  moved: Map<string, UploadImageResult>;
}): Promise<string[]> {
  const { tx, productId } = args;
  const placed = args.uploads.map((upload) => ({
    upload,
    publicId: makePublicId({
      kind: 'product',
      productId,
      imageKey: upload.publicId.split('/').pop()!,
    }),
  }));

  await persistProductImages({
    tx,
    productId,
    uploads: placed.map(({ upload, publicId }) => ({ ...upload, publicId })),
  });

  // a new path never had a file, so nothing of it is cached to drop
  for (const { upload, publicId } of placed) {
    const file =
      args.moved.get(upload.publicId) ??
      (await moveImage(upload.publicId, publicId, { invalidate: false }));
    args.moved.set(upload.publicId, file);

    await tx.productImage.updateMany({
      where: { productId, position: upload.position },
      data: { url: file.urlBase },
    });
  }

  return placed.map(({ publicId }) => publicId);
}

// a request that failed after some uploads moved to the paths of the product: no row points at
// them, they go; a file that stays only takes space, so a failure goes to the log
export async function discardMovedImages(
  moved: Map<string, UploadImageResult>,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<void> {
  await Promise.all(
    [...moved.values()]
      .map((file) => file.publicId)
      .filter((publicId) => isOwnFile(publicId))
      .map(async (publicId) => {
        try {
          await deleteImage(publicId);
        } catch (err) {
          log.warn({ err, publicId }, 'moved product image was not removed');
        }
      }),
  );
}

export async function readProductImageUrls(
  productId: ProductId,
): Promise<Array<{ url: string; position: number }>> {
  // read images ordered by position for stable dto mapping
  const rows = await prisma.productImage.findMany({
    where: { productId },
    select: { url: true, position: true },
    orderBy: { position: 'asc' },
  });

  // a product without an image has none in its card, the way the card of its page has none
  return rows.map((r) => ({ url: r.url, position: r.position }));
}
