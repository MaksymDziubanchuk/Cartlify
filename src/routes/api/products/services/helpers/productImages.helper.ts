import type { FastifyBaseLogger } from 'fastify';

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

// The gallery of a product: the pictures it is shown with, each with a place in it (from 0, in the
// order they were added). A variant shows some of them (variant_images). The uploads of a request
// wait under ids of their own until the rows are written; then each takes its place at
// <env>/products/<id>/<the key of its upload> and its row gets the url of the file there. The key
// is new for every upload: a move never lands on a file the product shows, so a move that fails
// in the middle leaves every image of the product as it was, and the files the product no longer
// has go after the commit.

// The time the transaction of a product or a gallery may take. It moves the files of its uploads at
// Cloudinary one after the other before it ends (moveStagedImages), so the time it needs grows with
// the files: the base (the rows, the wait for the row of the product) is what the transaction was
// given whatever its files, each file adds the time of a move (a few hundred milliseconds when
// Cloudinary answers; a move it does not answer is cut off after 8 s and the transaction goes back)
export const IMAGES_TX_BASE_MS = 20_000;
export const IMAGES_TX_PER_FILE_MS = 2_000;

export const imagesTxTimeout = (files: number): number =>
  IMAGES_TX_BASE_MS + IMAGES_TX_PER_FILE_MS * files;

// an upload that has its row in the gallery
export type StagedImage = {
  id: number;
  position: number;
  // where the file will be, once it has moved
  publicId: string;
  upload: UploadedProductImage;
};

// the places of the new pictures: after the last one the gallery has, in the order of the uploads
export async function nextGalleryPosition(
  tx: Prisma.TransactionClient,
  productId: ProductId,
): Promise<number> {
  const last = await tx.productImage.aggregate({ where: { productId }, _max: { position: true } });

  return last._max.position === null ? 0 : last._max.position + 1;
}

// writes the rows of the uploads into the gallery, at the places from firstPosition on. The row
// keeps the final public id and, until the file moves, the url of the waiting upload
export async function stageProductImages(args: {
  tx: Prisma.TransactionClient;
  productId: ProductId;
  uploads: UploadedProductImage[];
  firstPosition?: number;
}): Promise<StagedImage[]> {
  const { tx, productId, uploads } = args;
  const firstPosition = args.firstPosition ?? 0;
  if (!uploads.length) return [];

  const planned = uploads.map((upload, index) => ({
    upload,
    position: firstPosition + index,
    publicId: makePublicId({
      kind: 'product',
      productId,
      imageKey: upload.publicId.split('/').pop()!,
    }),
  }));

  const rows = await tx.productImage.createManyAndReturn({
    data: planned.map(({ upload, position, publicId }) => ({
      productId,
      url: upload.urlBase,
      publicId,
      alt: upload.alt ?? null,
      position,
    })),
    select: { id: true, position: true },
  });
  const idAt = new Map(rows.map((row) => [row.position, row.id]));

  return planned.map(({ upload, position, publicId }) => ({
    id: idAt.get(position)!,
    position,
    publicId,
    upload,
  }));
}

// moves the files of the staged images to their places and gives the rows the urls there. It runs
// last in the transaction, once every other row is written. A retried transaction finds the files
// it moved already in `moved`
export async function moveStagedImages(args: {
  tx: Prisma.TransactionClient;
  staged: StagedImage[];
  moved: Map<string, UploadImageResult>;
}): Promise<void> {
  const { tx, staged, moved } = args;

  // a new path never had a file, so nothing of it is cached to drop
  for (const image of staged) {
    const file =
      moved.get(image.upload.publicId) ??
      (await moveImage(image.upload.publicId, image.publicId, { invalidate: false }));
    moved.set(image.upload.publicId, file);

    await tx.productImage.update({ where: { id: image.id }, data: { url: file.urlBase } });
  }
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

// the files a product no longer has, after the commit that took their rows; a file that stays only
// takes space, so a failure goes to the log
export async function deleteStaleImages(
  publicIds: ReadonlyArray<string | null>,
  log: Pick<FastifyBaseLogger, 'warn'>,
  productId: ProductId,
): Promise<void> {
  await Promise.all(
    publicIds
      .filter((publicId): publicId is string => isOwnFile(publicId))
      .map(async (publicId) => {
        try {
          await deleteImage(publicId);
        } catch (err) {
          log.warn({ err, productId, publicId }, 'old product image was not removed');
        }
      }),
  );
}
