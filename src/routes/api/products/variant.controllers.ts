import type { ControllerRouter } from 'types/controller.js';
import type { User } from 'types/user.js';
import type { UploadedProductImage } from 'types/dto/products.dto.js';
import type {
  CreateVariantsBodyDto,
  CreateVariantsParamsDto,
  CreateVariantsResponseDto,
  DeleteGalleryImageResponseDto,
  DeleteVariantResponseDto,
  GalleryImageParamsDto,
  GalleryParamsDto,
  GetVariantResponseDto,
  RestoreVariantResponseDto,
  UpdateVariantBodyDto,
  UpdateVariantDto,
  UpdateVariantResponseDto,
  UpdateVariantsBatchBodyDto,
  UpdateVariantsBatchResponseDto,
  UpdateVariantsBodyDto,
  UpdateVariantsDto,
  UpdateVariantsParamsDto,
  UpdateVariantsResponseDto,
  UploadGalleryResponseDto,
  VariantParamsDto,
} from 'types/dto/variants.dto.js';

import { MAX_PRODUCT_IMAGES } from '@config/limits.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { BadRequestError } from '@utils/errors.js';
import { discardUploads } from '@utils/cloudinary.util.js';

import { productServices } from './product.services.js';
import { beginProductImageUpload } from './services/uploadProductImages.service.js';

// the controllers of the variants of a product and of its gallery (admin and root, except the read
// of one variant, which every role has)

const getVariant: ControllerRouter<VariantParamsDto, {}, {}, GetVariantResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.findVariant({
    productId: Number(req.params.productId),
    variantId: Number(req.params.variantId),
    actorId,
    actorRole,
  });
  return reply.code(200).send(result);
};

const postVariants: ControllerRouter<
  CreateVariantsParamsDto,
  CreateVariantsBodyDto,
  {},
  CreateVariantsResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.createVariants({
    productId: Number(req.params.productId),
    variants: req.body.variants,
    actorId,
    actorRole,
  });
  return reply.code(201).send(result);
};

const patchVariant: ControllerRouter<
  VariantParamsDto,
  UpdateVariantBodyDto,
  {},
  UpdateVariantResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const body = req.body ?? {};

  const args = pickDefined<UpdateVariantDto>(
    {
      productId: Number(req.params.productId),
      variantId: Number(req.params.variantId),
      actorId,
      actorRole,
    },
    {
      sku: body.sku,
      barcode: body.barcode,
      price: body.price,
      sale: body.sale,
      weightGrams: body.weightGrams,
      lengthMm: body.lengthMm,
      widthMm: body.widthMm,
      heightMm: body.heightMm,
      withoutShippingData: body.withoutShippingData,
      position: body.position,
      images: body.images,
      attributes: body.attributes,
      stock: body.stock,
    },
  );

  const result = await productServices.updateVariant(args);
  return reply.code(200).send(result);
};

// the same change for several variants of a product
const patchVariants: ControllerRouter<
  UpdateVariantsParamsDto,
  UpdateVariantsBodyDto,
  {},
  UpdateVariantsResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const body = req.body ?? {};

  const args = pickDefined<UpdateVariantsDto>(
    { productId: Number(req.params.productId), actorId, actorRole },
    {
      variantIds: body.variantIds,
      price: body.price,
      sale: body.sale,
      weightGrams: body.weightGrams,
      lengthMm: body.lengthMm,
      widthMm: body.widthMm,
      heightMm: body.heightMm,
      withoutShippingData: body.withoutShippingData,
      images: body.images,
      attributes: body.attributes,
      stock: body.stock,
    },
  );

  const result = await productServices.updateVariants(args);
  return reply.code(200).send(result);
};

// many variants of any products, each with the fields of its own, all of them or none
const patchVariantsBatch: ControllerRouter<
  {},
  UpdateVariantsBatchBodyDto,
  {},
  UpdateVariantsBatchResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.updateVariantsBatch({
    items: req.body.items,
    actorId,
    actorRole,
  });
  return reply.code(200).send(result);
};

const deleteVariant: ControllerRouter<VariantParamsDto, {}, {}, DeleteVariantResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.deleteVariant({
    productId: Number(req.params.productId),
    variantId: Number(req.params.variantId),
    actorId,
    actorRole,
  });
  return reply.code(200).send(result);
};

const restoreVariant: ControllerRouter<
  VariantParamsDto,
  {},
  {},
  RestoreVariantResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.restoreVariant({
    productId: Number(req.params.productId),
    variantId: Number(req.params.variantId),
    actorId,
    actorRole,
  });
  return reply.code(200).send(result);
};

// more pictures for the gallery: the files of a form, `images`; the other parts are left
const postGalleryImages: ControllerRouter<
  GalleryParamsDto,
  {},
  {},
  UploadGalleryResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const productId = Number(req.params.productId);

  if (!req.isMultipart()) throw new BadRequestError('MULTIPART_REQUIRED');

  // A product that is not there and a gallery that is full are refused before a file is read or
  // uploaded; the pictures it has set how many more the request may bring. The transaction of the
  // upload counts again under the lock of the product (two uploads may meet)
  const { have } = await productServices.readGalleryRoom({ productId, actorId, actorRole });

  // start image uploads as soon as we see file parts
  const imageUploads: Array<Promise<UploadedProductImage>> = [];

  try {
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;

      // accept only images field, drain everything else
      if (part.fieldname !== 'images' && part.fieldname !== 'images[]') {
        part.file.resume();
        continue;
      }

      // the gallery takes so many pictures more: the part is read to its end, the uploads begun go
      if (have + imageUploads.length >= MAX_PRODUCT_IMAGES) {
        part.file.resume();
        throw new BadRequestError('PRODUCT_IMAGES_TOO_MANY', { max: MAX_PRODUCT_IMAGES, have });
      }

      // start consuming the stream immediately, the upload waits under an id of its own
      const upload = beginProductImageUpload({
        productId,
        position: imageUploads.length,
        image: { file: part.file, mimetype: part.mimetype, filename: part.filename },
      });
      // awaited after the loop; a failure before that must not stop the process
      upload.catch(() => undefined);
      imageUploads.push(upload);
    }

    if (!imageUploads.length) throw new BadRequestError('PRODUCT_IMAGES_REQUIRED');

    const result = await productServices.uploadGallery({
      productId,
      images: await Promise.all(imageUploads),
      actorId,
      actorRole,
      log: req.log,
    });
    return reply.code(201).send(result);
  } catch (err) {
    // a refused request leaves no files: its uploads are deleted
    await discardUploads(imageUploads, req.log);
    throw err;
  }
};

const deleteGalleryImage: ControllerRouter<
  GalleryImageParamsDto,
  {},
  {},
  DeleteGalleryImageResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.deleteGalleryImage({
    productId: Number(req.params.productId),
    imageId: Number(req.params.imageId),
    actorId,
    actorRole,
    log: req.log,
  });
  return reply.code(200).send(result);
};

export const variantController = {
  getVariant,
  postVariants,
  patchVariant,
  patchVariants,
  patchVariantsBatch,
  deleteVariant,
  restoreVariant,
  postGalleryImages,
  deleteGalleryImage,
};
