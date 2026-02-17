import { findAll } from './services/getAllProducts.service.js';
import { findById } from './services/getProductById.service.js';
import { createProduct } from './services/createProduct.service.js';
import { updateProduct } from './services/updateProduct.service.js';
import { updateProductsBulkPrice } from './services/updateProductsBulkPrice.service.js';
import { updateProductCategory } from './services/updateCategory.service.js';
import { createReview } from './services/createReview.service.js';
import { findReviews } from './services/findReviews.service.js';
import { deleteProductReview } from './services/deleteReview.service.js';
import { deleteProductById } from './services/deleteProduct.service.js';

export const productServices = {
  findAll,
  findById,
  findReviews,
  createProduct,
  createReview,
  updateProduct,
  updateProductsBulkPrice,
  deleteProductById,
  deleteProductReview,
  updateProductCategory,
};
