import { FastifyRequest, FastifyReply } from 'fastify';
import { productServices } from './product.services.js';
import { ProductId, ReviewId } from 'types/ids.js';

async function getAllProducts(req: FastifyRequest, reply: FastifyReply) {
  const result = await productServices.findAll();
  return result;
}

async function getProductById(req: FastifyRequest, reply: FastifyReply) {
  const { productId } = req.params as { productId: ProductId };
  const id = Number(productId);
  const result = await productServices.findById(id);
  return result;
}

async function getProductReviews(req: FastifyRequest, reply: FastifyReply) {
  const { productId } = req.params as { productId: ProductId };
  const id = Number(productId);
  const result = await productServices.findReviews(id);
  return result;
}

async function postProduct(req: FastifyRequest, reply: FastifyReply) {
  const data = req.body;
  const result = await productServices.createProduct(data);
  return result;
}

async function postProductReview(req: FastifyRequest, reply: FastifyReply) {
  const { productId } = req.params as { productId: ProductId };
  const id = Number(productId);
  const data = req.body;
  const result = await productServices.createReview(id, data);
  return result;
}

async function updateProductById(req: FastifyRequest, reply: FastifyReply) {
  const { productId } = req.params as { productId: ProductId };
  const id = Number(productId);
  const data = req.body;
  const result = await productServices.updateProduct(id, data);
  return result;
}

async function deleteProductById(req: FastifyRequest, reply: FastifyReply) {
  const { productId } = req.params as { productId: ProductId };
  const id = Number(productId);
  const result = await productServices.deleteProductById(id);
  return result;
}

async function deleteProductReview(req: FastifyRequest, reply: FastifyReply) {
  const { productId, reviewId } = req.params as { productId: ProductId; reviewId: ReviewId };
  const prodId = Number(productId);
  const revId = Number(reviewId);
  const result = await productServices.deleteProductReview(prodId, revId);
  return result;
}

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
