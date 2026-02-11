import { makePublicId, uploadImage } from '@utils/cloudinary.util.js';
import { AppError } from '@utils/errors.js';
import { prisma } from '@db/client.js';
import type { ProductId } from 'types/ids.js';
import type { Prisma } from '@prisma/client';

export type ProductImagePart = {
  file: unknown;
  mimetype: string;
  filename?: string;
};

export type UploadedProductImage = {
  urlBase: string;
  publicId: string;
  position: number;
  alt?: string;
};

export function normalizeMultipartFiles(images: unknown): ProductImagePart[] {
  // accept multipart field as single or array
  const fileParts: any[] = Array.isArray(images) ? images : images ? [images] : [];

  // keep only parts that look like multipart files
  return fileParts
    .filter((p) => typeof p === 'object' && p !== null && typeof p.mimetype === 'string' && p.file)
    .map((p) => ({
      file: p.file,
      mimetype: p.mimetype,
      filename: typeof p.filename === 'string' ? p.filename : undefined,
    }));
}

export async function uploadProductImages(args: {
  productId: ProductId;
  imageParts: ProductImagePart[];
}): Promise<UploadedProductImage[]> {
  // upload files to cloudinary outside tx
  const uploads: UploadedProductImage[] = [];

  for (let i = 0; i < args.imageParts.length; i++) {
    const part = args.imageParts[i];

    const publicId = makePublicId({
      kind: 'product',
      productId: args.productId,
      imageKey: String(i + 1),
    });

    const uploaded = await uploadImage({
      publicId,
      file: part.file as any,
      mimetype: part.mimetype,
      ...(part.filename ? { filename: part.filename } : {}),
      tags: ['product', `product:${args.productId}`],
    });

    uploads.push({
      urlBase: uploaded.urlBase,
      publicId: uploaded.publicId,
      position: i,
      ...(part.filename ? { alt: part.filename } : {}),
    });
  }

  return uploads;
}

export async function persistProductImages(args: {
  tx: Prisma.TransactionClient;
  productId: ProductId;
  uploads: UploadedProductImage[];
}): Promise<void> {
  // persist uploaded image pointers in db
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
  productId: number,
): Promise<Array<{ url: string; position: number }>> {
  // load all image urls ordered by position
  const rows = await prisma.productImage.findMany({
    where: { productId },
    select: { url: true, position: true },
    orderBy: { position: 'asc' },
  });

  // reject invalid db state (product has no images)
  if (!rows.length) throw new AppError('PRODUCT_IMAGES_NOT_FOUND', 500);

  return rows.map((r) => ({ url: r.url, position: r.position }));
}
