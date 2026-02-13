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
      schema: productSchemas.getAllProductsRouterSchema,
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
      schema: productSchemas.getProductByIdRouterSchema,
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
      schema: productSchemas.getProductReviewsRouterSchema,
    },
    productController.getProductReviews,
  );

  app.post(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      preValidation: async (req) => {
        if (req.isMultipart()) (req as any).body = {};
      },
      schema: productSchemas.postProductRouterSchema,
    },
    productController.postProduct,
  );

  app.post(
    '/:productId/reviews',
    {
      preHandler: [authGuard, requireRole(['USER']), validateId('productId')],
      schema: productSchemas.postProductReviewRouterSchema,
    },
    productController.postProductReview,
  );

  app.patch(
    '/:productId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('productId')],
      preValidation: async (req) => {
        if (req.isMultipart()) (req as any).body = {};
      },
      schema: productSchemas.updateProductByIdRouterSchema,
    },
    productController.updateProductById,
  );

  app.delete(
    '/:productId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('productId')],
      schema: productSchemas.deleteProductByIdRouterSchema,
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
      schema: productSchemas.deleteProductReviewRouterSchema,
    },
    productController.deleteProductReview,
  );
  app.patch(
    '/:productId/category',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('productId')],
      schema: productSchemas.patchProductCategorySchema,
    },
    productController.patchProductCategory,
  );
}
