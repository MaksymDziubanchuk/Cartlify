import { prisma } from '@db/client.js';
import { AppError } from '@utils/errors.js';

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
  if (!rows.length) throw new AppError('PRODUCT_IMAGES_NOT_FOUND', 500);

  return rows.map((r) => ({ url: r.url, position: r.position }));
}
