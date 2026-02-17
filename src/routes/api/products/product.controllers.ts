import type { ControllerRouter } from 'types/controller.js';
import type { ProductId, ReviewId, CategoryId, UserId } from 'types/ids.js';
import type { User } from 'types/user.js';
import type {
  GetAllProductsQueryDto,
  ProductsSortField,
  SortOrder,
  FindAllProductsDto,
  ProductsResponseDto,
  GetProductByIdParamsDto,
  FindProductByIdDto,
  FullProductResponseDto,
  GetProductReviewsParamsDto,
  GetProductReviewsQueryDto,
  FindProductReviewsDto,
  ReviewsResponseDto,
  CreateProductBodyDto,
  UploadedProductImage,
  CreateProductDto,
  CreateProductResponseDto,
  PostReviewParamsDto,
  CreateReviewBodyDto,
  CreateReviewDto,
  CreateReviewResponseDto,
  UpdateProductParamsDto,
  UpdateProductBodyDto,
  UpdateProductDto,
  UpdateProductResponseDto,
  BulkUpdateProductsPriceBodyDto,
  BulkUpdateProductsPriceResponseDto,
  BulkUpdateProductsPriceDto,
  DeleteProductByIdParamsDto,
  DeleteProductByIdDto,
  DeleteProductReviewParamsDto,
  DeleteProductReviewDto,
  DeleteProductReviewResponseDto,
  UpdateProductCategoryParamsDto,
  UpdateProductCategoryBodyDto,
  UpdateProductCategoryDto,
  UpdateProductCategoryResponseDto,
} from 'types/dto/products.dto.js';
import type { MessageResponseDto } from 'types/common.js';
import { productServices } from './product.services.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { BadRequestError } from '@utils/errors.js';
import {
  reserveNextProductId,
  beginProductImageUpload,
} from './services/uploadProductImages.service.js';

const getAllProducts: ControllerRouter<
  {},
  {},
  GetAllProductsQueryDto,
  ProductsResponseDto
> = async (req, reply) => {
  const q = req.query;

  const limitRaw = q.limit != null ? Number(q.limit) : 20;
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 20;

  const cursor = typeof q.cursor === 'string' && q.cursor.trim() ? q.cursor.trim() : undefined;

  const search = typeof q.search === 'string' && q.search.trim() ? q.search.trim() : undefined;

  const minPrice = q.minPrice != null ? Number(q.minPrice) : undefined;
  const maxPrice = q.maxPrice != null ? Number(q.maxPrice) : undefined;

  const deleted = typeof q.deleted === 'boolean' ? q.deleted : undefined;
  const inStock = typeof q.inStock === 'boolean' ? q.inStock : undefined;

  const sort: ProductsSortField = (q.sort as ProductsSortField) ?? 'popularity';
  const order: SortOrder = (q.order as SortOrder) ?? 'desc';

  const categoryIds = Array.isArray(q.categoryIds)
    ? (q.categoryIds
        .flatMap((v) => String(v).split(','))
        .map((s) => Number(String(s).trim()))
        .filter((n) => Number.isInteger(n) && n > 0) as CategoryId[])
    : typeof q.categoryIds === 'string' && q.categoryIds.trim()
      ? (q.categoryIds
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0) as CategoryId[])
      : undefined;

  const args = pickDefined<FindAllProductsDto>(
    { limit, sort, order },
    { cursor, search, categoryIds, minPrice, maxPrice, deleted, inStock },
  );

  const result = await productServices.findAll(args);
  return reply.code(200).send(result);
};

const getProductById: ControllerRouter<
  GetProductByIdParamsDto,
  {},
  {},
  FullProductResponseDto
> = async (req, reply) => {
  const productId = Number(req.params.productId);
  const { id: actorId, role: actorRole } = req.user as User;
  const args = pickDefined<FindProductByIdDto>({ productId, actorId, actorRole }, {});
  const result = await productServices.findById(args);
  return reply.code(200).send(result);
};

const getProductReviews: ControllerRouter<
  GetProductReviewsParamsDto,
  {},
  GetProductReviewsQueryDto,
  ReviewsResponseDto
> = async (req, reply) => {
  // normalize cursor pagination inputs
  const { cursorId: qc, limit: ql } = req.query;

  const productId = Number(req.params.productId);
  const cursorId = qc != null ? Number(qc) : undefined;
  const limit = ql != null ? Number(ql) : 10;

  const args = pickDefined<FindProductReviewsDto>({ productId, limit }, { cursorId });

  const result = await productServices.findReviews(args);
  return reply.code(200).send(result);
};

const postProduct: ControllerRouter<
  {},
  CreateProductBodyDto,
  {},
  CreateProductResponseDto
> = async (req, reply) => {
  // actor identity comes from authGuard
  const { id: actorId, role: actorRole } = req.user as User;

  // multipart only because images are required
  if (!req.isMultipart()) {
    throw new BadRequestError('MULTIPART_REQUIRED');
  }

  // collect scalar fields from multipart
  let name: string | undefined;
  let description: string | undefined;
  let priceRaw: string | undefined;
  let stockRaw: string | undefined;
  let categoryIdRaw: string | undefined;

  // reserve product id lazily when we see the first image
  let productId: ProductId | null = null;

  // start image uploads as soon as we see file parts
  const imageUploads: Array<Promise<UploadedProductImage>> = [];

  // parse multipart parts manually because file streams must be consumed during parsing
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      // accept only images field, drain everything else
      if (part.fieldname !== 'images' && part.fieldname !== 'images[]') {
        part.file.resume();
        continue;
      }

      // allocate id once, before the first upload starts
      if (!productId) {
        productId = await reserveNextProductId();
      }

      // start consuming the stream immediately via cloudinary overwrite
      const position = imageUploads.length;

      imageUploads.push(
        beginProductImageUpload({
          productId,
          position,
          image: { file: part.file, mimetype: part.mimetype, filename: part.filename },
        }),
      );

      continue;
    }

    // multipart field values are typed loosely, normalize to string
    const v = typeof part.value === 'string' ? part.value : String(part.value ?? '');

    // map allowed fields only
    if (part.fieldname === 'name') name = v;
    else if (part.fieldname === 'description') description = v;
    else if (part.fieldname === 'price') priceRaw = v;
    else if (part.fieldname === 'stock') stockRaw = v;
    else if (part.fieldname === 'categoryId') categoryIdRaw = v;
  }

  // enforce required images
  if (!imageUploads.length || !productId) {
    throw new BadRequestError('PRODUCT_IMAGES_REQUIRED');
  }

  // wait for all uploads to finish
  const uploads = await Promise.all(imageUploads);

  // required fields (and TS narrowing)
  const productIdReq = productId;
  const nameReq = name?.trim();
  const priceReq = priceRaw?.trim();
  const stockReq = stockRaw?.trim();
  const categoryIdReq = categoryIdRaw?.trim();
  const descriptionReq = description?.trim();
  if (!productIdReq || !nameReq || !priceReq || !stockReq || !categoryIdReq || !uploads.length) {
    throw new BadRequestError('BODY_NOT_FULL');
  }

  // build dto, service normalizes and validates values
  const args = pickDefined<CreateProductDto>(
    {
      actorId,
      actorRole,
      productId: productIdReq,
      name: nameReq,
      price: Number(priceReq),
      stock: Number(stockReq),
      categoryId: Number(categoryIdReq) as CategoryId,
      images: uploads,
    },
    { description: descriptionReq },
  );

  const result = await productServices.createProduct(args);
  return reply.code(201).send(result);
};

const postProductReview: ControllerRouter<
  PostReviewParamsDto,
  CreateReviewBodyDto,
  {},
  CreateReviewResponseDto
> = async (req, reply) => {
  // normalize ids and bind actor
  const productId = Number(req.params.productId);
  const { id: userId, role: actorRole } = req.user as User;

  const { rating, comment } = req.body;

  const args = pickDefined<CreateReviewDto>({ productId, userId, actorRole }, { rating, comment });

  const result = await productServices.createReview(args);
  return reply.code(201).send(result);
};

const updateProductById: ControllerRouter<
  UpdateProductParamsDto,
  UpdateProductBodyDto,
  {},
  UpdateProductResponseDto
> = async (req, reply) => {
  // normalize params and actor context for service and rls
  const productId = Number(req.params.productId);
  const { id: actorId, role: actorRole } = req.user as User;

  // collect optional fields from multipart or json
  let name: string | undefined;
  let description: string | undefined;

  let price: number | undefined;
  let stock: number | undefined;
  let categoryId: number | undefined;

  let popularityOverride: number | null | undefined;
  let popularityOverrideUntil: string | null | undefined;

  let uploads: UploadedProductImage[] | undefined;

  if (req.isMultipart()) {
    // start image uploads as soon as we see file parts
    const imageUploads: Array<Promise<UploadedProductImage>> = [];

    // parse multipart parts manually
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        // accept only images field, drain everything else
        if (part.fieldname !== 'images' && part.fieldname !== 'images[]') {
          part.file.resume();
          continue;
        }

        // start consuming the stream immediately via cloudinary overwrite
        const position = imageUploads.length;

        imageUploads.push(
          beginProductImageUpload({
            productId,
            position,
            image: { file: part.file, mimetype: part.mimetype, filename: part.filename },
          }),
        );

        continue;
      }

      // multipart field values are typed loosely, normalize to string
      const v = typeof part.value === 'string' ? part.value : String(part.value ?? '');
      const t = v.trim();

      // map allowed fields only
      if (part.fieldname === 'name') name = v;
      else if (part.fieldname === 'description') description = v;
      else if (part.fieldname === 'price') price = t ? Number(t) : undefined;
      else if (part.fieldname === 'stock') stock = t ? Number(t) : undefined;
      else if (part.fieldname === 'categoryId') categoryId = t ? Number(t) : undefined;
      else if (part.fieldname === 'popularityOverride') {
        if (!t || t === 'null') popularityOverride = null;
        else popularityOverride = Number(t);
      } else if (part.fieldname === 'popularityOverrideUntil') {
        if (!t || t === 'null') popularityOverrideUntil = null;
        else popularityOverrideUntil = t;
      }
    }

    // wait for uploads only when images were provided
    if (imageUploads.length) uploads = await Promise.all(imageUploads);
  } else {
    // allow json updates when client sends no files
    const b = req.body ?? {};
    name = b.name;
    description = b.description;
    price = b.price;
    stock = b.stock;
    categoryId = b.categoryId;
    popularityOverride = b.popularityOverride;
    popularityOverrideUntil = b.popularityOverrideUntil;
    uploads = b.images;
  }

  // build service dto with only provided fields
  const args = pickDefined<UpdateProductDto>(
    { productId, actorId, actorRole },
    {
      name,
      description,
      price,
      stock,
      categoryId,
      images: uploads,
      popularityOverride,
      popularityOverrideUntil,
    },
  );

  const result = await productServices.updateProduct(args);
  return reply.code(200).send(result);
};

const updateProductsBulkPrice: ControllerRouter<
  {},
  BulkUpdateProductsPriceBodyDto,
  {},
  BulkUpdateProductsPriceResponseDto
> = async (req, reply) => {
  // bind actor
  const { id: actorId, role: actorRole } = req.user as User;

  const { mode, value, scope, dryRun, reason } = req.body;

  const args = pickDefined<BulkUpdateProductsPriceDto>(
    { actorId, actorRole, mode, value },
    { scope, dryRun, reason },
  );

  const result = await productServices.updateProductsBulkPrice(args);
  return reply.code(200).send(result);
};

const deleteProductById: ControllerRouter<
  DeleteProductByIdParamsDto,
  {},
  {},
  MessageResponseDto
> = async (req, reply) => {
  const productId = Number(req.params.productId);
  const { id: actorId, role: actorRole } = req.user as User;
  const args = pickDefined<DeleteProductByIdDto>({ productId, actorId, actorRole }, {});
  const result = await productServices.deleteProductById(args);
  return reply.code(200).send(result);
};

const deleteProductReview: ControllerRouter<
  DeleteProductReviewParamsDto,
  {},
  {},
  DeleteProductReviewResponseDto
> = async (req, reply) => {
  const { productId: pp, reviewId: pr } = req.params;
  const { id: actorId, role: actorRole } = req.user as User;

  const productId = Number(pp);
  const reviewId = Number(pr);

  const args = pickDefined<DeleteProductReviewDto>({ productId, reviewId, actorId, actorRole }, {});

  const result = await productServices.deleteProductReview(args);
  return reply.code(200).send(result);
};

const patchProductCategory: ControllerRouter<
  UpdateProductCategoryParamsDto,
  UpdateProductCategoryBodyDto,
  {},
  UpdateProductCategoryResponseDto
> = async (req, reply) => {
  const { productId } = req.params;
  const { categoryId } = req.body;
  const { id: actorId, role: actorRole } = req.user as User;

  const args = pickDefined<UpdateProductCategoryDto>(
    { productId, categoryId, actorId, actorRole },
    {},
  );
  const result = await productServices.updateProductCategory(args);
  return reply.code(200).send(result);
};

export const productController = {
  getAllProducts,
  getProductById,
  getProductReviews,
  postProduct,
  postProductReview,
  updateProductById,
  updateProductsBulkPrice,
  deleteProductById,
  deleteProductReview,
  patchProductCategory,
};
