import { prisma } from '@db/client.js';
import { Prisma } from '@prisma/client';

import { BadRequestError, InternalError } from '@utils/errors.js';
import { makeUploadPublicId, requireImageStream, uploadImage } from '@utils/cloudinary.util.js';

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
    throw new InternalError({ reason: 'PRODUCT_ID_NEXTVAL_INVALID' });
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
    throw new InternalError({ reason: 'PRODUCT_ID_INVALID' });
  }
  if (!Number.isInteger(position) || position < 0) {
    throw new InternalError({ reason: 'PRODUCT_IMAGE_POSITION_INVALID' });
  }

  // fast fail when stream is already dead
  const s: any = image?.file;
  if (!s || s.destroyed || s.readableEnded) {
    throw new BadRequestError('PRODUCT_IMAGE_EMPTY');
  }

  // an empty file and one that is not a jpeg, png or webp by its bytes never reach cloudinary;
  // the stream is consumed at once
  const safeStream = await requireImageStream(image.file, {
    mimetype: image.mimetype,
    emptyCode: 'PRODUCT_IMAGE_STREAM_ERROR',
  });

  // the image waits under an id of its own: placeProductImages moves it to its place once the
  // product is written, a refused request deletes it (the controller)
  const uploaded = await uploadImage({
    publicId: makeUploadPublicId(),
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
