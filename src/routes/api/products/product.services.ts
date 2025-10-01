import type { ProductId, ReviewId } from 'types/ids.js';
import type {
  CreateProductDto,
  UpdateProductDto,
  CreateReviewDto,
  FindAllProductsParamsDto,
} from 'types/dto/products.dto.js';

async function findAll({ page, limit, sort, categoryId }: FindAllProductsParamsDto) {
  return {
    message: 'findAll not implemented',
  };
}

async function findById(productId: ProductId) {
  return {
    message: 'findById not implemented',
  };
}

async function findReviews(productId: ProductId) {
  return {
    message: 'findReviews not implemented',
  };
}

async function createProduct(data: CreateProductDto) {
  return {
    message: 'create not implemented',
  };
}

async function createReview(productId: ProductId, data: CreateReviewDto) {
  return {
    message: 'createReview not implemented',
  };
}

async function updateProduct(productId: ProductId, data: UpdateProductDto) {
  return {
    message: 'updateProduct not implemented',
  };
}

async function deleteProductById(productId: ProductId) {
  return {
    message: 'daleteProduct not implemented',
  };
}

async function deleteProductReview(productId: ProductId, reviewId: ReviewId) {
  return {
    message: 'daleteProductReview not implemented',
  };
}

export const productServices = {
  findAll,
  findById,
  findReviews,
  createProduct,
  createReview,
  updateProduct,
  deleteProductById,
  deleteProductReview,
};
