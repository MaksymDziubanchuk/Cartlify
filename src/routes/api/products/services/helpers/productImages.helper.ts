import { makePublicId, uploadImage } from '@utils/cloudinary.util.js';

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
  productId: number;
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
  productId: number;
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
