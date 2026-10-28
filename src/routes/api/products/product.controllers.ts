import type { ControllerRouter } from 'types/controller.js';
import type { ProductId, CategoryId } from 'types/ids.js';
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
  ProductSaleWord,
  SetProductSaleParamsDto,
  SetProductSaleBodyDto,
  SetProductSaleResponseDto,
  BulkUpdateProductsPriceBodyDto,
  BulkUpdateProductsPriceResponseDto,
  BulkUpdateProductsPriceDto,
  UpdateProductsBatchBodyDto,
  UpdateProductsBatchResponseDto,
  DeleteProductByIdParamsDto,
  DeleteProductByIdDto,
  DeleteProductReviewParamsDto,
  DeleteProductReviewDto,
  DeleteProductReviewResponseDto,
  UpdateProductCategoryParamsDto,
  UpdateProductCategoryBodyDto,
  UpdateProductCategoryDto,
  UpdateProductCategoryResponseDto,
  ReceiveStockDto,
  ReceiveStockResponseDto,
  WriteOffStockDto,
  WriteOffStockResponseDto,
  ProductSuggestionsQueryDto,
  ProductSuggestionsResponseDto,
  ProductSalesBodyDto,
  ProductSalesResponseDto,
  RestoreProductParamsDto,
  PriceHistoryDto,
  PriceHistoryParamsDto,
  PriceHistoryQueryDto,
  PriceHistoryResponseDto,
} from 'types/dto/products.dto.js';
import type { MessageResponseDto } from 'types/common.js';
import { productServices } from './product.services.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { discardUploads } from '@utils/cloudinary.util.js';
import { MAX_PRODUCT_IMAGES } from '@config/limits.js';
import { BadRequestError } from '@utils/errors.js';
import { safetyFromFormFields } from '@helpers/productDescription.js';
import {
  reserveNextProductId,
  beginProductImageUpload,
} from './services/uploadProductImages.service.js';

// the fields of a product that tell its weight and its packed sizes, and the word that they come
// later; a form gives them as text, the service checks them
const SHIPPING_FORM_FIELDS = {
  weightGrams: true,
  lengthMm: true,
  widthMm: true,
  heightMm: true,
  withoutShippingData: true,
} as const;

const getAllProducts: ControllerRouter<
  {},
  {},
  GetAllProductsQueryDto,
  ProductsResponseDto
> = async (req, reply) => {
  const q = req.query;
  const { id: actorId, role: actorRole } = req.user as User;

  const limitRaw = q.limit != null ? Number(q.limit) : 20;
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 20;

  const cursor = typeof q.cursor === 'string' && q.cursor.trim() ? q.cursor.trim() : undefined;

  const search = typeof q.search === 'string' && q.search.trim() ? q.search.trim() : undefined;

  const minPrice = q.minPrice != null ? Number(q.minPrice) : undefined;
  const maxPrice = q.maxPrice != null ? Number(q.maxPrice) : undefined;

  const deleted = typeof q.deleted === 'boolean' ? q.deleted : undefined;
  const inStock = typeof q.inStock === 'boolean' ? q.inStock : undefined;
  const maxStock = typeof q.maxStock === 'number' ? q.maxStock : undefined;
  const withoutShippingData =
    typeof q.withoutShippingData === 'boolean' ? q.withoutShippingData : undefined;
  const onSale = typeof q.onSale === 'boolean' ? q.onSale : undefined;
  // the period of the sort by sales, as dates; a text that is no date stays an invalid date
  const salesFrom = typeof q.salesFrom === 'string' ? new Date(q.salesFrom) : undefined;
  const salesTo = typeof q.salesTo === 'string' ? new Date(q.salesTo) : undefined;
  const popularityOverridden =
    typeof q.popularityOverridden === 'boolean' ? q.popularityOverridden : undefined;

  // without a sort the service takes the best match of a search, or the popularity
  const sort = q.sort as ProductsSortField | undefined;
  const order: SortOrder = (q.order as SortOrder) ?? 'desc';
  const branch = typeof q.branch === 'boolean' ? q.branch : undefined;

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
    { actorRole, limit, order },
    {
      actorId,
      sort,
      cursor,
      search,
      categoryIds,
      branch,
      minPrice,
      maxPrice,
      deleted,
      inStock,
      maxStock,
      withoutShippingData,
      salesFrom,
      salesTo,
      onSale,
      popularityOverridden,
    },
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
  // actor identity comes from authGuard
  const { id: actorId, role: actorRole } = req.user as User;
  // normalize cursor pagination inputs
  const ql = req.query.limit;
  const qc = req.query?.cursor;

  const productId = Number(req.params.productId);

  const cursor = typeof qc === 'string' ? qc : undefined;
  const limit = ql != null ? Number(ql) : 10;

  const args = pickDefined<FindProductReviewsDto>(
    { productId, limit, actorId, actorRole },
    { cursor, sort: req.query.sort },
  );

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
  let sku: string | undefined;
  let priceRaw: string | undefined;
  let stockRaw: string | undefined;
  let categoryIdRaw: string | undefined;
  // the weight, the sizes and the word that they come later, as text; the service checks them
  const shippingFields: Partial<Record<keyof typeof SHIPPING_FORM_FIELDS, string>> = {};
  // the safety data as text fields: safety.manufacturer.name and so on
  const safetyFields = new Map<string, string>();

  // reserve product id lazily when we see the first image
  let productId: ProductId | null = null;

  // start image uploads as soon as we see file parts
  const imageUploads: Array<Promise<UploadedProductImage>> = [];

  try {
    // parse multipart parts manually because file streams must be consumed during parsing
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        // accept only images field, drain everything else
        if (part.fieldname !== 'images' && part.fieldname !== 'images[]') {
          part.file.resume();
          continue;
        }

        // a product has at most so many images: the part is read to its end, the uploads begun go
        if (imageUploads.length >= MAX_PRODUCT_IMAGES) {
          part.file.resume();
          throw new BadRequestError('PRODUCT_IMAGES_TOO_MANY', { max: MAX_PRODUCT_IMAGES });
        }

        // allocate id once, before the first upload starts
        if (!productId) {
          productId = await reserveNextProductId();
        }

        // start consuming the stream immediately, the upload waits under an id of its own
        const position = imageUploads.length;
        const upload = beginProductImageUpload({
          productId,
          position,
          image: { file: part.file, mimetype: part.mimetype, filename: part.filename },
        });
        // awaited after the loop; a failure before that must not stop the process
        upload.catch(() => undefined);
        imageUploads.push(upload);

        continue;
      }

      // multipart field values are typed loosely, normalize to string
      const v = typeof part.value === 'string' ? part.value : String(part.value ?? '');

      // a NUL sign is no text postgres keeps, the same refusal as for a json body
      if (v.includes('\u0000')) throw new BadRequestError('TEXT_NUL_FORBIDDEN');

      // map allowed fields only
      if (part.fieldname === 'name') name = v;
      else if (part.fieldname === 'description') description = v;
      else if (part.fieldname === 'sku') sku = v;
      else if (part.fieldname === 'price') priceRaw = v;
      else if (part.fieldname === 'stock') stockRaw = v;
      else if (part.fieldname === 'categoryId') categoryIdRaw = v;
      else if (part.fieldname.startsWith('safety.')) safetyFields.set(part.fieldname, v);
      // an empty input of a form is no value
      else if (part.fieldname in SHIPPING_FORM_FIELDS && v !== '') {
        shippingFields[part.fieldname as keyof typeof SHIPPING_FORM_FIELDS] = v;
      }
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
    const categoryIdReq = categoryIdRaw?.trim();
    const descriptionReq = description?.trim();
    if (!productIdReq || !nameReq || !priceReq || !categoryIdReq || !uploads.length) {
      throw new BadRequestError('BODY_NOT_FULL');
    }

    // build dto, service normalizes and validates values; a stock is refused there, a new product
    // gets its stock with a delivery
    const args = pickDefined<CreateProductDto>(
      {
        actorId,
        actorRole,
        productId: productIdReq,
        name: nameReq,
        price: Number(priceReq),
        categoryId: Number(categoryIdReq) as CategoryId,
        images: uploads,
        log: req.log,
      },
      {
        description: descriptionReq,
        sku,
        safety: safetyFromFormFields(safetyFields),
        stock: stockRaw,
        weightGrams: shippingFields.weightGrams,
        lengthMm: shippingFields.lengthMm,
        widthMm: shippingFields.widthMm,
        heightMm: shippingFields.heightMm,
        withoutShippingData: shippingFields.withoutShippingData,
      },
    );

    const result = await productServices.createProduct(args);
    return reply.code(201).send(result);
  } catch (err) {
    // a refused product leaves no files: its uploads are deleted
    await discardUploads(imageUploads, req.log);
    throw err;
  }
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

  const args = pickDefined<CreateReviewDto>(
    { productId, userId, actorRole, log: req.log },
    { rating, comment },
  );

  // a new review answers 201, a review that got its missing part answers 200
  const { review, created } = await productServices.createReview(args);
  return reply.code(created ? 201 : 200).send(review);
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
  // an empty one takes the article number away
  let sku: string | null | undefined;
  // the safety data, whole; a form gives them as text fields
  let safety: unknown;
  const safetyFields = new Map<string, string>();

  let price: number | undefined;
  // never taken: a stock sent is refused, it changes only with a delivery or a write-off
  let stock: unknown;
  let categoryId: number | undefined;

  // the weight and the sizes: numbers of a json body, text of a form; null clears them
  const shippingFields: Pick<
    UpdateProductDto,
    'weightGrams' | 'lengthMm' | 'widthMm' | 'heightMm' | 'withoutShippingData'
  > = {};

  let popularityOverride: number | null | undefined;
  let popularityOverrideUntil: string | null | undefined;

  // what happens to the sale that is on with a new price; a form names keep or remove only
  let sale: ProductSaleWord | undefined;
  let saleWordInvalid = false;

  let uploads: UploadedProductImage[] | undefined;

  // start image uploads as soon as we see file parts
  const imageUploads: Array<Promise<UploadedProductImage>> = [];

  try {
    if (req.isMultipart()) {
      // parse multipart parts manually
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          // accept only images field, drain everything else
          if (part.fieldname !== 'images' && part.fieldname !== 'images[]') {
            part.file.resume();
            continue;
          }

          // a product has at most so many images: the part is read to its end, the uploads begun go
          if (imageUploads.length >= MAX_PRODUCT_IMAGES) {
            part.file.resume();
            throw new BadRequestError('PRODUCT_IMAGES_TOO_MANY', { max: MAX_PRODUCT_IMAGES });
          }

          // start consuming the stream immediately, the upload waits under an id of its own
          const position = imageUploads.length;
          const upload = beginProductImageUpload({
            productId,
            position,
            image: { file: part.file, mimetype: part.mimetype, filename: part.filename },
          });
          // awaited after the loop; a failure before that must not stop the process
          upload.catch(() => undefined);
          imageUploads.push(upload);

          continue;
        }

        // multipart field values are typed loosely, normalize to string
        const v = typeof part.value === 'string' ? part.value : String(part.value ?? '');
        if (v.includes('\u0000')) throw new BadRequestError('TEXT_NUL_FORBIDDEN');
        const t = v.trim();

        // map allowed fields only
        if (part.fieldname === 'name') name = v;
        else if (part.fieldname === 'description') description = v;
        else if (part.fieldname === 'sku') sku = v;
        else if (part.fieldname.startsWith('safety.')) safetyFields.set(part.fieldname, v);
        else if (part.fieldname === 'price') price = t ? Number(t) : undefined;
        else if (part.fieldname === 'stock') stock = v;
        else if (part.fieldname === 'categoryId') categoryId = t ? Number(t) : undefined;
        else if (part.fieldname in SHIPPING_FORM_FIELDS && v !== '') {
          Object.assign(shippingFields, { [part.fieldname]: v });
        } else if (part.fieldname === 'popularityOverride') {
          if (!t || t === 'null') popularityOverride = null;
          else popularityOverride = Number(t);
        } else if (part.fieldname === 'popularityOverrideUntil') {
          if (!t || t === 'null') popularityOverrideUntil = null;
          else popularityOverrideUntil = t;
        } else if (part.fieldname === 'sale') {
          if (t === 'keep') sale = 'keep';
          else if (t === 'remove') sale = null;
          else saleWordInvalid = true;
        }
      }

      // a new sale needs its fields: it comes as json or through the sale route
      if (saleWordInvalid) throw new BadRequestError('PRODUCT_SALE_ACTION_INVALID');
      safety = safetyFromFormFields(safetyFields);

      // wait for uploads only when images were provided
      if (imageUploads.length) uploads = await Promise.all(imageUploads);
    } else {
      // a json body changes the fields; images come only as files of a form
      const b = req.body ?? {};
      name = b.name;
      description = b.description;
      sku = b.sku;
      safety = b.safety;
      price = b.price;
      stock = b.stock;
      categoryId = b.categoryId;
      for (const field of Object.keys(
        SHIPPING_FORM_FIELDS,
      ) as (keyof typeof SHIPPING_FORM_FIELDS)[]) {
        if (b[field] !== undefined) Object.assign(shippingFields, { [field]: b[field] });
      }
      popularityOverride = b.popularityOverride;
      popularityOverrideUntil = b.popularityOverrideUntil;
      sale = b.sale;
    }

    // build service dto with only provided fields
    const args = pickDefined<UpdateProductDto>(
      { productId, actorId, actorRole, log: req.log },
      {
        name,
        description,
        sku,
        safety: safety as UpdateProductDto['safety'],
        price,
        stock,
        categoryId,
        images: uploads,
        popularityOverride,
        popularityOverrideUntil,
        sale,
        weightGrams: shippingFields.weightGrams,
        lengthMm: shippingFields.lengthMm,
        widthMm: shippingFields.widthMm,
        heightMm: shippingFields.heightMm,
        withoutShippingData: shippingFields.withoutShippingData,
      },
    );

    const result = await productServices.updateProduct(args);
    return reply.code(200).send(result);
  } catch (err) {
    // a refused update leaves the images of the product as they were: its uploads are deleted
    await discardUploads(imageUploads, req.log);
    throw err;
  }
};

// many products at once, each with fields of its own, all of them or none
const updateProductsBatch: ControllerRouter<
  {},
  UpdateProductsBatchBodyDto,
  {},
  UpdateProductsBatchResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.updateProductsBatch({
    items: req.body.items,
    actorId,
    actorRole,
  });
  return reply.code(200).send(result);
};

const patchProductSale: ControllerRouter<
  SetProductSaleParamsDto,
  SetProductSaleBodyDto,
  {},
  SetProductSaleResponseDto
> = async (req, reply) => {
  const productId = Number(req.params.productId);
  const { id: actorId, role: actorRole } = req.user as User;

  // null takes the sale off, the schema lets through a percent or an amount with its end
  const result = await productServices.setProductSale({
    productId,
    actorId,
    actorRole,
    sale: req.body.sale,
  });
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

  const { mode, value, scope, dryRun, reason, sale } = req.body;

  const args = pickDefined<BulkUpdateProductsPriceDto>(
    { actorId, actorRole, mode, value },
    { scope, dryRun, reason, sale },
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

  const args = pickDefined<DeleteProductReviewDto>(
    { productId, reviewId, actorId, actorRole, log: req.log },
    {},
  );

  const result = await productServices.deleteProductReview(args);
  return reply.code(200).send(result);
};

const patchProductCategory: ControllerRouter<
  UpdateProductCategoryParamsDto,
  UpdateProductCategoryBodyDto,
  {},
  UpdateProductCategoryResponseDto
> = async (req, reply) => {
  const productId = Number(req.params.productId);
  const { categoryId } = req.body;
  const { id: actorId, role: actorRole } = req.user as User;

  const args = pickDefined<UpdateProductCategoryDto>(
    { productId, categoryId, actorId, actorRole },
    {},
  );
  const result = await productServices.updateProductCategory(args);
  return reply.code(200).send(result);
};

// sales of many products at once: a sale for each product, or one for a category
const postProductSales: ControllerRouter<
  {},
  ProductSalesBodyDto,
  {},
  ProductSalesResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.setProductSales({ ...req.body, actorId, actorRole });
  return reply.code(200).send(result);
};

// a few names of the catalog for what a person types, the best match first
const getProductSuggestions: ControllerRouter<
  {},
  {},
  ProductSuggestionsQueryDto,
  ProductSuggestionsResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.findSuggestions({ text: req.query.q, actorId, actorRole });
  return reply.code(200).send(result);
};

// the history of the price of a product, for admin and root
const getPriceHistory: ControllerRouter<
  PriceHistoryParamsDto,
  {},
  PriceHistoryQueryDto,
  PriceHistoryResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.findPriceHistory(
    pickDefined<PriceHistoryDto>(
      { productId: Number(req.params.productId), actorId, actorRole },
      { limit: req.query.limit, cursor: req.query.cursor },
    ),
  );
  return reply.code(200).send(result);
};

// puts a product taken out of the catalog back, the admin log keeps the change
const restoreProduct: ControllerRouter<
  RestoreProductParamsDto,
  {},
  {},
  FullProductResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.restoreProduct({
    productId: Number(req.params.productId),
    actorId,
    actorRole,
  });
  return reply.code(200).send(result);
};

// takes in a delivery: a batch of each item; the admin log keeps a line for each
const postStockDelivery: ControllerRouter<
  {},
  Omit<ReceiveStockDto, 'actorId' | 'actorRole'>,
  {},
  ReceiveStockResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.receiveStock({ ...req.body, actorId, actorRole });
  return reply.code(201).send(result);
};

// writes off free units of the items; the admin log keeps a line for each
const postStockWriteOff: ControllerRouter<
  {},
  Omit<WriteOffStockDto, 'actorId' | 'actorRole'>,
  {},
  WriteOffStockResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.writeOffStock({ ...req.body, actorId, actorRole });
  return reply.code(201).send(result);
};

export const productController = {
  getAllProducts,
  getProductSuggestions,
  getProductById,
  restoreProduct,
  getPriceHistory,
  getProductReviews,
  postProduct,
  postProductReview,
  updateProductById,
  updateProductsBatch,
  patchProductSale,
  postProductSales,
  updateProductsBulkPrice,
  deleteProductById,
  deleteProductReview,
  patchProductCategory,
  postStockDelivery,
  postStockWriteOff,
};
