import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { productController } from './product.controllers.js';
import { productSchemas } from './product.schemas.js';

export default async function productsRouter(app: FastifyInstance) {
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
      // a form only, with no json body to check: the controller reads and checks its parts
      schema: productSchemas.postProductRouterSchema,
      config: { formBodySchema: 'productCreateFormSchema' },
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
      // a form leaves the body empty for the json schema, the controller reads its parts
      preValidation: async (req) => {
        if (req.isMultipart()) (req as any).body = {};
      },
      schema: productSchemas.updateProductByIdRouterSchema,
      // the swagger lists the form with the images next to the json body
      config: { formBodySchema: 'productUpdateFormSchema' },
    },
    productController.updateProductById,
  );

  app.patch(
    '/:productId/category',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('productId')],
      schema: productSchemas.patchProductCategorySchema,
    },
    productController.patchProductCategory,
  );

  app.patch(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: productSchemas.patchProductsBulkPriceRouterSchema,
    },
    productController.updateProductsBulkPrice,
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
}
