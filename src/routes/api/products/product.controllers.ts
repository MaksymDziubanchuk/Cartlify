import { ControllerRouter } from 'types/controller.js';
import { productServices } from './product.services.js';
import {
  CreateProductDto,
  UpdateProductDto,
  CreateReviewDto,
  FindAllProductsParamsDto,
  GetAllProductsQueryDto,
} from 'types/dto/products.dto.js';

const getAllProducts: ControllerRouter<{}, {}, GetAllProductsQueryDto, unknown> = async (
  req,
  reply,
) => {
  const { page: qp, limit: ql, sort: qs, categoryId: qc } = req.query;
  const page = qp ? Number(qp) : 1;
  const limit = ql ? Number(ql) : 10;
  const categoryId = qc ? Number(qc) : undefined;

  const allowedSort: Array<'price_asc' | 'price_desc' | 'popular'> = [
    'price_asc',
    'price_desc',
    'popular',
  ];
  const sort = allowedSort.includes(qs as any) ? (qs as (typeof allowedSort)[number]) : undefined;

  const args: FindAllProductsParamsDto = {
    page,
    limit,
    ...(sort !== undefined ? { sort } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
  };
  const result = await productServices.findAll(args);
  return result;
};

const getProductById: ControllerRouter<{ productId: string }> = async (req, reply) => {
  const id = Number(req.params.productId);
  const result = await productServices.findById(id);
  return result;
};

const getProductReviews: ControllerRouter<{ productId: string }, {}, {}, unknown> = async (
  req,
  reply,
) => {
  const id = Number(req.params.productId);
  const result = await productServices.findReviews(id);
  return result;
};

const postProduct: ControllerRouter<{}, CreateProductDto, {}, unknown> = async (req, reply) => {
  const result = await productServices.createProduct(req.body);
  return result;
};

const postProductReview: ControllerRouter<
  { productId: string },
  CreateReviewDto,
  {},
  unknown
> = async (req, reply) => {
  const id = Number(req.params.productId);
  const result = await productServices.createReview(id, req.body);
  return result;
};

const updateProductById: ControllerRouter<
  { productId: string },
  UpdateProductDto,
  {},
  unknown
> = async (req, reply) => {
  const id = Number(req.params.productId);
  const result = await productServices.updateProduct(id, req.body);
  return result;
};

const deleteProductById: ControllerRouter<{ productId: string }, {}, {}, unknown> = async (
  req,
  reply,
) => {
  const id = Number(req.params.productId);
  const result = await productServices.deleteProductById(id);
  return result;
};

const deleteProductReview: ControllerRouter<
  { productId: string; reviewId: string },
  {},
  {},
  unknown
> = async (req, reply) => {
  const prodId = Number(req.params.productId);
  const revId = Number(req.params.reviewId);
  const result = await productServices.deleteProductReview(prodId, revId);
  return result;
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
};
