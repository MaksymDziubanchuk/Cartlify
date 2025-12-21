import type { MessageResponseDto } from 'types/common.js';
import type {
  CreateProductDto,
  UpdateProductDto,
  CreateReviewDto,
  FindAllProductsDto,
  FindProductByIdDto,
  FindProductReviewsDto,
  DeleteProductByIdDto,
  DeleteProductReviewDto,
  UpdateProductCategoryDto,
  RemoveProductCategoryDto,
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
}: FindAllProductsDto): Promise<MessageResponseDto> {
  return {
    message: 'findAll not implemented',
  };
}

async function findById({ productId }: FindProductByIdDto): Promise<MessageResponseDto> {
  return {
    message: 'findById not implemented',
  };
}

async function findReviews({ productId }: FindProductReviewsDto): Promise<MessageResponseDto> {
  return {
    message: 'findReviews not implemented',
  };
}

async function createProduct({
  name,
  description,
  price,
  categoryId,
  images,
}: CreateProductDto): Promise<MessageResponseDto> {
  return {
    message: 'create not implemented',
  };
}

async function createReview({
  rating,
  comment,
  productId,
  userId,
}: CreateReviewDto): Promise<MessageResponseDto> {
  return {
    message: 'createReview not implemented',
  };
}

async function updateProduct({
  productId,
  actorId,
  name,
  description,
  price,
  categoryId,
  images,
  popularity,
}: UpdateProductDto): Promise<MessageResponseDto> {
  return {
    message: 'updateProduct not implemented',
  };
}

async function deleteProductById({ productId }: DeleteProductByIdDto): Promise<MessageResponseDto> {
  return {
    message: 'daleteProduct not implemented',
  };
}

async function deleteProductReview({
  productId,
  reviewId,
  actorId,
}: DeleteProductReviewDto): Promise<MessageResponseDto> {
  return {
    message: 'daleteProductReview not implemented',
  };
}

async function updateProductCategory({
  productId,
  categoryId,
}: UpdateProductCategoryDto): Promise<MessageResponseDto> {
  return { message: 'product category set not implemented' };
}

async function removeProductCategory({
  productId,
}: RemoveProductCategoryDto): Promise<MessageResponseDto> {
  return { message: 'product category cleared not implemented' };
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
  updateProductCategory,
  removeProductCategory,
};
