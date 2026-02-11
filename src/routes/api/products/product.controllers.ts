import type { ControllerRouter } from 'types/controller.js';
import type { ProductId, ReviewId, CategoryId, UserId } from 'types/ids.js';
import type { User } from 'types/user.js';
import type {
  GetAllProductsQueryDto,
  FindAllProductsDto,
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

const getAllProducts: ControllerRouter<{}, {}, GetAllProductsQueryDto, MessageResponseDto> = async (
  req,
  reply,
) => {
  const {
    page: qp,
    limit: ql,
    search: qs,
    categoryIds: qcats,
    minPrice: qmin,
    maxPrice: qmax,
    sortBy: qsort,
    order: qorder,
  } = req.query;

  const page = qp ? Number(qp) : 1;
  const limit = ql ? Number(ql) : 10;

  const categoryIds = Array.isArray(qcats)
    ? (qcats as typeof qcats)
    : typeof qcats === 'string'
      ? ((qcats as any as string).split(',').map((s) => Number(s.trim())) as CategoryId[])
      : undefined;

  const minPrice = qmin != null ? Number(qmin) : undefined;
  const maxPrice = qmax != null ? Number(qmax) : undefined;

  const allowedSortBy: Array<'price' | 'createdAt' | 'popular' | 'name'> = [
    'price',
    'createdAt',
    'popular',
    'name',
  ];
  const sortBy = allowedSortBy.includes(qsort as any)
    ? (qsort as (typeof allowedSortBy)[number])
    : 'createdAt';

  const allowedOrder: Array<'asc' | 'desc'> = ['asc', 'desc'];
  const order = allowedOrder.includes(qorder as any)
    ? (qorder as (typeof allowedOrder)[number])
    : 'desc';

  const search = typeof qs === 'string' && qs.trim() ? qs.trim() : undefined;

  const args = pickDefined<FindAllProductsDto>(
    { page, limit, sortBy, order },
    { search, categoryIds, minPrice, maxPrice },
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
