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
  GetProductByIdQueryDto,
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
  SetProductSaleParamsDto,
  SetProductSaleBodyDto,
  SetProductSaleDto,
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
  CatalogFiltersQueryDto,
  CatalogFiltersResponseDto,
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
import { partyFromFormFields } from '@helpers/party.js';
import {
  reserveNextProductId,
  beginProductImageUpload,
} from './services/uploadProductImages.service.js';

const bool = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

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
  // the flags and the ids of an admin that find the gaps of the catalog (the schema types them)
  const gaps = {
    missingRequired: bool(q.missingRequired),
    withoutWeight: bool(q.withoutWeight),
    withoutDimensions: bool(q.withoutDimensions),
    withoutBarcode: bool(q.withoutBarcode),
    withoutImages: bool(q.withoutImages),
    hiddenFromBuyers: bool(q.hiddenFromBuyers),
    hasDeletedVariants: bool(q.hasDeletedVariants),
    manufacturerId: typeof q.manufacturerId === 'number' ? q.manufacturerId : undefined,
    euResponsibleId: typeof q.euResponsibleId === 'number' ? q.euResponsibleId : undefined,
    documentId: typeof q.documentId === 'number' ? q.documentId : undefined,
  };
  // the period of the sort by sales, as dates; a text that is no date stays an invalid date
  const salesFrom = typeof q.salesFrom === 'string' ? new Date(q.salesFrom) : undefined;
  const salesTo = typeof q.salesTo === 'string' ? new Date(q.salesTo) : undefined;
  const popularityOverridden =
    typeof q.popularityOverridden === 'boolean' ? q.popularityOverridden : undefined;
  const group = typeof q.group === 'boolean' ? q.group : undefined;

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
      ...gaps,
      salesFrom,
      salesTo,
      onSale,
      popularityOverridden,
      // the filter by characteristics is read by the service, which names what is wrong with it
      f: q.f,
      group,
    },
  );

  const result = await productServices.findAll(args);
  return reply.code(200).send(result);
};

// the filter of a category: what its variants are told apart by
const getCatalogFilters: ControllerRouter<
  {},
  {},
  CatalogFiltersQueryDto,
  CatalogFiltersResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await productServices.findCatalogFilters({
    categoryId: Number(req.query.categoryId) as CategoryId,
    branch: req.query.branch !== false,
    actorId,
    actorRole,
  });
  return reply.code(200).send(result);
};

const getProductById: ControllerRouter<
  GetProductByIdParamsDto,
  {},
  GetProductByIdQueryDto,
  FullProductResponseDto
> = async (req, reply) => {
  const productId = Number(req.params.productId);
  const { id: actorId, role: actorRole } = req.user as User;
  const args = pickDefined<FindProductByIdDto>(
    { productId, actorId, actorRole },
    { variantId: req.query.variantId },
  );
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

// the fields of a party a new product brings: only these four of each party are taken
const PARTY_FORM_FIELD = /^(manufacturer|euResponsible)\.(name|address|email|country)$/;

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
  let categoryIdRaw: string | undefined;
  // the variants: the text of a JSON list, the service reads and checks it
  let variantsRaw: string | undefined;
  // never taken: a stock sent is refused by the service
  let stockRaw: string | undefined;
  // the manufacturer and the person responsible in the EU: a party of the directory by its id, or
  // a new one by its values as text fields (manufacturer.name and so on); the warnings
  let manufacturerIdRaw: string | undefined;
  let euResponsibleIdRaw: string | undefined;
  let warnings: string | undefined;
  // the ids of the documents of the directory the product names, with a comma between
  let documentIdsRaw: string | undefined;
  const partyFields = new Map<string, string>();

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
      else if (part.fieldname === 'categoryId') categoryIdRaw = v;
      else if (part.fieldname === 'variants') variantsRaw = v;
      else if (part.fieldname === 'stock') stockRaw = v;
      else if (part.fieldname === 'manufacturerId' && v.trim()) manufacturerIdRaw = v;
      else if (part.fieldname === 'euResponsibleId' && v.trim()) euResponsibleIdRaw = v;
      else if (part.fieldname === 'warnings') warnings = v;
      else if (part.fieldname === 'documentIds') documentIdsRaw = v;
      else if (PARTY_FORM_FIELD.test(part.fieldname) && v !== '') {
        partyFields.set(part.fieldname, v);
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
    const categoryIdReq = categoryIdRaw?.trim();
    const descriptionReq = description?.trim();
    if (!productIdReq || !nameReq || !categoryIdReq || !uploads.length) {
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
        categoryId: Number(categoryIdReq) as CategoryId,
        images: uploads,
        log: req.log,
      },
      {
        description: descriptionReq,
        manufacturerId: manufacturerIdRaw,
        manufacturer: partyFromFormFields(partyFields, 'manufacturer'),
        euResponsibleId: euResponsibleIdRaw,
        euResponsible: partyFromFormFields(partyFields, 'euResponsible'),
        warnings,
        documentIds: documentIdsRaw,
        variants: variantsRaw,
        stock: stockRaw,
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
  // the manufacturer and the person responsible in the EU by their ids in the directory (an empty
  // person takes it away), the warnings (empty takes them away)
  let manufacturerId: unknown;
  let euResponsibleId: unknown;
  let warnings: string | null | undefined;
  // the documents by their ids: a form gives them as text, a json body as an array or null
  let documentIds: unknown;

  // never taken: a stock sent is refused, it changes only with a delivery or a write-off
  let stock: unknown;
  let categoryId: number | undefined;

  let popularityOverride: number | null | undefined;
  let popularityOverrideUntil: string | null | undefined;

  if (req.isMultipart()) {
    // parse multipart parts manually; a form carries the text fields of the json body
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        // the pictures of a product are its gallery: POST /api/products/:productId/images
        part.file.resume();
        throw new BadRequestError('PRODUCT_IMAGES_NOT_ALLOWED');
      }

      // multipart field values are typed loosely, normalize to string
      const v = typeof part.value === 'string' ? part.value : String(part.value ?? '');
      if (v.includes('\u0000')) throw new BadRequestError('TEXT_NUL_FORBIDDEN');
      const t = v.trim();

      // map allowed fields only
      if (part.fieldname === 'name') name = v;
      else if (part.fieldname === 'description') description = v;
      else if (part.fieldname === 'manufacturerId') manufacturerId = t;
      else if (part.fieldname === 'euResponsibleId') euResponsibleId = t || null;
      else if (part.fieldname === 'warnings') warnings = v;
      else if (part.fieldname === 'documentIds') documentIds = v;
      else if (part.fieldname === 'stock') stock = v;
      else if (part.fieldname === 'categoryId') categoryId = t ? Number(t) : undefined;
      else if (part.fieldname === 'popularityOverride') {
        if (!t || t === 'null') popularityOverride = null;
        else popularityOverride = Number(t);
      } else if (part.fieldname === 'popularityOverrideUntil') {
        if (!t || t === 'null') popularityOverrideUntil = null;
        else popularityOverrideUntil = t;
      }
    }
  } else {
    // a json body changes the fields; the pictures are the business of the gallery routes
    const b = req.body ?? {};
    name = b.name;
    description = b.description;
    manufacturerId = b.manufacturerId;
    euResponsibleId = b.euResponsibleId;
    warnings = b.warnings;
    documentIds = b.documentIds;
    stock = b.stock;
    categoryId = b.categoryId;
    popularityOverride = b.popularityOverride;
    popularityOverrideUntil = b.popularityOverrideUntil;
  }

  // build service dto with only provided fields
  const args = pickDefined<UpdateProductDto>(
    { productId, actorId, actorRole },
    {
      name,
      description,
      manufacturerId: manufacturerId as UpdateProductDto['manufacturerId'],
      euResponsibleId: euResponsibleId as UpdateProductDto['euResponsibleId'],
      warnings,
      documentIds: documentIds as UpdateProductDto['documentIds'],
      stock,
      categoryId,
      popularityOverride,
      popularityOverrideUntil,
    },
  );

  const result = await productServices.updateProduct(args);
  return reply.code(200).send(result);
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
  const result = await productServices.setProductSale(
    pickDefined<SetProductSaleDto>(
      { productId, actorId, actorRole, sale: req.body.sale },
      { variantIds: req.body.variantIds },
    ),
  );
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

// sales of many variants at once: a sale for each variant or product, or one for a category
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

// the history of the price of the variants of a product, for admin and root
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
      { variantId: req.query.variantId, limit: req.query.limit, cursor: req.query.cursor },
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
  getCatalogFilters,
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
