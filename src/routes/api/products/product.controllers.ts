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
  // pass request payload as dto, keep parsing inside service for multipart shapes
  const { name, description, price, categoryId, images, stock } = req.body;
  // pass actor context for rls policies
  const { id: actorId, role: actorRole } = req.user as User;

  const args = pickDefined<CreateProductDto>(
    { name, price, categoryId, actorId, actorRole, images, stock },
    { description },
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

  // pass optional fields as-is, service validates multipart and values
  const {
    name,
    description,
    price,
    stock,
    categoryId,
    images,
    popularityOverride,
    popularityOverrideUntil,
  } = req.body;

  const args = pickDefined<UpdateProductDto>(
    { productId, actorId, actorRole },
    {
      name,
      description,
      price,
      stock,
      categoryId,
      images,
      popularityOverride,
      popularityOverrideUntil,
    },
  );

  const result = await productServices.updateProduct(args);
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

export const patchProductCategory: ControllerRouter<
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
  deleteProductById,
  deleteProductReview,
  patchProductCategory,
};
