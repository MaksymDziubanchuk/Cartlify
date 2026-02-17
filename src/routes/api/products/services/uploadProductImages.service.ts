import { prisma } from '@db/client.js';
import { Prisma } from '@prisma/client';

import { AppError, BadRequestError } from '@utils/errors.js';
import { makePublicId, overwriteImage, requireNonEmptyStream } from '@utils/cloudinary.util.js';

import type { ProductImagePart, UploadedProductImage } from 'types/dto/products.dto.js';
import type { ProductId } from 'types/ids.js';

export async function reserveNextProductId(): Promise<ProductId> {
  // reserve next id from products id sequence
  // nextval returns bigint in pg, cast to int for prisma typing
  const rows = await prisma.$queryRaw<Array<{ id: number }>>(
    Prisma.sql`SELECT nextval(pg_get_serial_sequence('products', 'id'))::int AS id;`,
  );

  const id = rows[0]?.id;

  // validate reserved id to keep public ids stable
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('PRODUCT_ID_NEXTVAL_INVALID', 500);
  }

  return id as ProductId;
}

export async function beginProductImageUpload(args: {
  productId: ProductId;
  position: number; // 0..N-1
  image: ProductImagePart;
}): Promise<UploadedProductImage> {
  const { productId, position, image } = args;

  // validate product id and position
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new AppError('PRODUCT_ID_INVALID', 500);
  }
  if (!Number.isInteger(position) || position < 0) {
    throw new AppError('PRODUCT_IMAGE_POSITION_INVALID', 500);
  }

  // fast fail when stream is already dead
  const s: any = image?.file;
  if (!s || s.destroyed || s.readableEnded) {
    throw new BadRequestError('PRODUCT_IMAGE_EMPTY');
  }

  // guard against empty stream and start consuming immediately
  const safeStream = await requireNonEmptyStream(image.file, 'PRODUCT_IMAGE_STREAM_ERROR');

  // stable public id to support overwrite for create and update
  const publicId = makePublicId({
    kind: 'product',
    productId,
    imageKey: String(position + 1),
  });

  const uploaded = await overwriteImage({
    publicId,
    file: safeStream,
    mimetype: image.mimetype,
    ...(image.filename ? { filename: image.filename } : {}),
    tags: ['product', `product:${productId}`, `pos:${position + 1}`],
  });

  const alt = typeof image.filename === 'string' ? image.filename.trim() : '';

  return {
    publicId: uploaded.publicId,
    urlBase: uploaded.urlBase,
    position,
    ...(alt ? { alt } : {}),
  };
}
