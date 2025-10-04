import type { ProductId, ReviewId } from 'types/ids.js';
import type {
  CreateProductDto,
  UpdateProductDto,
  CreateReviewDto,
  FindAllProductsDto,
  FindProductByIdDto,
  FindProductReviewsDto,
  DeleteProductByIdDto,
  DeleteProductReviewDto,
} from 'types/dto/products.dto.js';

async function findAll({
  page,
  limit,
  search,
  categoryIds,
  minPrice,
  maxPrice,
  sortBy,
  order,
}: FindAllProductsDto) {
  return {
    message: 'findAll not implemented',
  };
}

async function findById({ productId }: FindProductByIdDto) {
  return {
    message: 'findById not implemented',
  };
}

async function findReviews({ productId }: FindProductReviewsDto) {
  return {
    message: 'findReviews not implemented',
  };
}

async function createProduct({ name, description, price, categoryId, imageUrl }: CreateProductDto) {
  return {
    message: 'create not implemented',
  };
}

async function createReview({ rating, comment, productId, userId }: CreateReviewDto) {
  return {
    message: 'createReview not implemented',
  };
}

async function updateProduct({
  productId,
  name,
  description,
  price,
  categoryId,
  imageUrl,
  popularity,
}: UpdateProductDto) {
  return {
    message: 'updateProduct not implemented',
  };
}

async function deleteProductById({ productId }: DeleteProductByIdDto) {
  return {
    message: 'daleteProduct not implemented',
  };
}

async function deleteProductReview({ productId, reviewId, actorId }: DeleteProductReviewDto) {
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
