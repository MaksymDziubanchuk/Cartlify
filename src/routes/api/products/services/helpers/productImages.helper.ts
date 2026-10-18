import { prisma } from '@db/client.js';
import { makePublicId, moveImage, type UploadImageResult } from '@utils/cloudinary.util.js';
import { InternalError } from '@utils/errors.js';

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
// each takes its place at <env>/products/<id>/<position from 1> and its row gets the url of the file
// there. It runs last in the transaction, so a refused request never touches the files of the
// product. A retried transaction finds the files it moved already in `moved`.
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
    publicId: makePublicId({ kind: 'product', productId, imageKey: upload.position + 1 }),
  }));

  await persistProductImages({
    tx,
    productId,
    uploads: placed.map(({ upload, publicId }) => ({ ...upload, publicId })),
  });

  for (const { upload, publicId } of placed) {
    const file = args.moved.get(upload.publicId) ?? (await moveImage(upload.publicId, publicId));
    args.moved.set(upload.publicId, file);

    await tx.productImage.updateMany({
      where: { productId, position: upload.position },
      data: { url: file.urlBase },
    });
  }

  return placed.map(({ publicId }) => publicId);
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

  // reject invalid db state when product has no images
  if (!rows.length) throw new InternalError({ reason: 'PRODUCT_IMAGES_NOT_FOUND' });

  return rows.map((r) => ({ url: r.url, position: r.position }));
}
