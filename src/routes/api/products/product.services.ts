import { findAll } from './services/getAllProducts.service.js';
import { findById } from './services/getProductById.service.js';
import { findSuggestions } from './services/getProductSuggestions.service.js';
import { restoreProduct } from './services/restoreProduct.service.js';
import { findPriceHistory } from './services/priceHistory.service.js';
import { createProduct } from './services/createProduct.service.js';
import { updateProduct } from './services/updateProduct.service.js';
import { updateProductsBatch } from './services/updateProductsBatch.service.js';
import { setProductSale } from './services/setProductSale.service.js';
import { setProductSales } from './services/setProductSales.service.js';
import { updateProductsBulkPrice } from './services/updateProductsBulkPrice.service.js';
import { updateProductCategory } from './services/updateCategory.service.js';
import { createReview } from './services/createReview.service.js';
import { findReviews } from './services/findReviews.service.js';
import { deleteProductReview } from './services/deleteReview.service.js';
import { deleteProductById } from './services/deleteProduct.service.js';
import { receiveStock } from './services/receiveStock.service.js';
import { writeOffStock } from './services/writeOffStock.service.js';

export const productServices = {
  findAll,
  findSuggestions,
  findById,
  restoreProduct,
  findPriceHistory,
  findReviews,
  createProduct,
  createReview,
  updateProduct,
  updateProductsBatch,
  setProductSale,
  setProductSales,
  updateProductsBulkPrice,
  deleteProductById,
  deleteProductReview,
  updateProductCategory,
  receiveStock,
  writeOffStock,
};
