import type { ControllerRouter } from 'types/controller.js';
import type { ProductId, ReviewId, CategoryId, UserId } from 'types/ids.js';
import type { User } from 'types/user.js';
import type {
  GetAllProductsQueryDto,
  FindAllProductsDto,
  GetProductByIdParamsDto,
  GetProductReviewsParamsDto,
  GetProductReviewsQueryDto,
  CreateProductBodyDto,
  CreateProductDto,
  CreateProductResponseDto,
  PostReviewParamsDto,
  CreateReviewBodyDto,
  CreateReviewDto,
  UpdateProductParamsDto,
  UpdateProductBodyDto,
  UpdateProductDto,
  UpdateProductResponseDto,
  DeleteProductByIdParamsDto,
  DeleteProductReviewParamsDto,
  UpdateProductCategoryParamsDto,
  UpdateProductCategoryBodyDto,
  UpdateProductCategoryDto,
  RemoveProductCategoryParamsDto,
  RemoveProductCategoryDto,
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
  MessageResponseDto
> = async (req, reply) => {
  const productId = Number(req.params.productId);
  const result = await productServices.findById({ productId });
  return reply.code(200).send(result);
};

const getProductReviews: ControllerRouter<
  GetProductReviewsParamsDto,
  {},
  GetProductReviewsQueryDto,
  MessageResponseDto
> = async (req, reply) => {
  const { page: qp, limit: ql } = req.query;
  const page = qp ? Number(qp) : 1;
  const limit = ql ? Number(ql) : 10;
  const productId = Number(req.params.productId);
  const result = await productServices.findReviews({ productId, page, limit });
  return reply.code(200).send(result);
};

const postProduct: ControllerRouter<
  {},
  CreateProductBodyDto,
  {},
  CreateProductResponseDto
> = async (req, reply) => {
  // pass request payload as dto, keep parsing inside service for multipart shapes
  const { name, description, price, categoryId, images } = req.body;
  // pass actor context for rls policies
  const { id: actorId, role: actorRole } = req.user as User;

  const args = pickDefined<CreateProductDto>(
    { name, price, categoryId, actorId, actorRole },
    { description, images },
  );

  const result = await productServices.createProduct(args);
  return reply.code(201).send(result);
};

const postProductReview: ControllerRouter<
  PostReviewParamsDto,
  CreateReviewBodyDto,
  {},
  unknown
> = async (req, reply) => {
  const productId = Number(req.params.productId);
  const userId = (req.user as User).id;
  const args: CreateReviewDto = {
    productId,
    userId,
    ...req.body,
  };
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
  const { name, description, price, categoryId, images, popularity } = req.body;

  const args = pickDefined<UpdateProductDto>(
    { productId, actorId, actorRole },
    { name, description, price, categoryId, images, popularity },
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
  const result = await productServices.deleteProductById({ productId, actorId, actorRole });
  return reply.code(200).send(result);
};

const deleteProductReview: ControllerRouter<
  DeleteProductReviewParamsDto,
  {},
  {},
  MessageResponseDto
> = async (req, reply) => {
  const productId = Number(req.params.productId);
  const reviewId = Number(req.params.reviewId);
  const { id: actorId, role: actorRole } = req.user as User;
  const result = await productServices.deleteProductReview({
    productId,
    reviewId,
    actorId,
    actorRole,
  });
  return reply.code(200).send(result);
};

export const patchProductCategory: ControllerRouter<
  UpdateProductCategoryParamsDto,
  UpdateProductCategoryBodyDto,
  {},
  MessageResponseDto
> = async (req, reply) => {
  const { productId } = req.params;
  const { categoryId } = req.body;

  const args = pickDefined<UpdateProductCategoryDto>({ productId, categoryId }, {});
  const result = await productServices.updateProductCategory(args);
  return reply.code(200).send(result);
};

export const deleteProductCategory: ControllerRouter<
  RemoveProductCategoryParamsDto,
  {},
  {},
  MessageResponseDto
> = async (req, reply) => {
  const { productId } = req.params;

  const args = pickDefined<RemoveProductCategoryDto>({ productId }, {});
  const result = await productServices.removeProductCategory(args);
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
  deleteProductCategory,
};
