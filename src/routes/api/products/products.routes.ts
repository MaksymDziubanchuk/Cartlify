import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { productController } from './product.controllers.js';
import { productSchemas } from './product.schemas.js';

export default async function productsRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'GUEST', 'ROOT', 'USER'])],
      schema: productSchemas.getAllProductsSchema,
    },
    productController.getAllProducts,
  );

  app.get(
    '/:productId',
    {
      preHandler: [
        authGuard,
        requireRole(['ADMIN', 'GUEST', 'ROOT', 'USER']),
        validateId('productId'),
      ],
      schema: productSchemas.getProductByIdSchema,
    },
    productController.getProductById,
  );

  app.get(
    '/:productId/reviews',
    {
      preHandler: [
        authGuard,
        requireRole(['ADMIN', 'GUEST', 'ROOT', 'USER']),
        validateId('productId'),
      ],
      schema: productSchemas.getProductReviewsSchema,
    },
    productController.getProductReviews,
  );

  app.post(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN'])],
      schema: productSchemas.postProductSchema,
    },
    productController.postProduct,
  );

  app.post(
    '/:productId/reviews',
    {
      preHandler: [authGuard, requireRole(['USER']), validateId('productId')],
      schema: productSchemas.postProductReviewSchema,
    },
    productController.postProductReview,
  );

  app.patch(
    '/:productId',
    {
      preHandler: [authGuard, requireRole(['ADMIN']), validateId('productId')],
      schema: productSchemas.updateProductByIdSchema,
    },
    productController.updateProductById,
  );

  app.delete(
    '/:productId',
    {
      preHandler: [authGuard, requireRole(['ADMIN']), validateId('productId')],
      schema: productSchemas.deleteProductByIdSchema,
    },
    productController.deleteProductById,
  );

  app.delete(
    '/:productId/reviews/:reviewId',
    {
      preHandler: [
        authGuard,
        requireRole(['USER', 'ADMIN', 'ROOT']),
        validateId('productId'),
        validateId('reviewId'),
      ],
      schema: productSchemas.deleteProductReviewSchema,
    },
    productController.deleteProductReview,
  );
}
