import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  isAppError,
} from '@utils/errors.js';

import { toNumberSafe, toStringSafe } from '@helpers/safeNormalizer.js';
import {
  normalizeMultipartFiles,
  uploadProductImages,
  persistProductImages,
  mapProductRowToResponse,
  buildProductUpdateAuditChanges,
  writeAdminAuditLog,
  writeProductPriceChangeLog,
  computeFixedDelta,
} from './services/helpers/index.js';

import type { MessageResponseDto } from 'types/common.js';
import type {
  CreateReviewDto,
  FindAllProductsDto,
  FindProductByIdDto,
  FindProductReviewsDto,
  DeleteProductByIdDto,
  DeleteProductReviewDto,
  UpdateProductCategoryDto,
} from 'types/dto/products.dto.js';

import { createProduct } from './services/createProduct.service.js';
import { updateProduct } from './services/updateProduct.service.js';
import { updateProductCategory } from './services/updateCategory.service.js';
import { createReview } from './services/createReview.service.js';
import { findReviews } from './services/findReviews.service.js';
import { deleteProductReview } from './services/reviewDelete.service.js';

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

async function deleteProductById({ productId }: DeleteProductByIdDto): Promise<MessageResponseDto> {
  return {
    message: 'daleteProduct not implemented',
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
  updateProductCategory,
};
