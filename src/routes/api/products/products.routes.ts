import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { requestLimits } from '../../../plugins/requestLimits.js';
import { productController } from './product.controllers.js';
import { productSchemas } from './product.schemas.js';
import { variantController } from './variant.controllers.js';
import { variantSchemas } from './variant.schemas.js';

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
    '/suggestions',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'GUEST', 'ROOT', 'USER'])],
      schema: productSchemas.getProductSuggestionsRouterSchema,
    },
    productController.getProductSuggestions,
  );

  // the filter of a category; a path of its own wins over :productId
  app.get(
    '/filters',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'GUEST', 'ROOT', 'USER'])],
      schema: productSchemas.getCatalogFiltersRouterSchema,
    },
    productController.getCatalogFilters,
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
    '/:productId/price-history',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('productId')],
      schema: productSchemas.getPriceHistoryRouterSchema,
    },
    productController.getPriceHistory,
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
      preHandler: [
        authGuard,
        requireRole(['USER']),
        validateId('productId'),
        ...requestLimits.review,
      ],
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
      // the swagger lists the form with the text fields next to the json body
      config: { formBodySchema: 'productUpdateFormSchema' },
    },
    productController.updateProductById,
  );

  // many products at once, each with fields of its own; a path of its own wins over :productId
  app.patch(
    '/batch',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: productSchemas.patchProductsBatchRouterSchema,
    },
    productController.updateProductsBatch,
  );

  app.patch(
    '/:productId/sale',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('productId')],
      schema: productSchemas.patchProductSaleRouterSchema,
    },
    productController.patchProductSale,
  );

  app.post(
    '/sales',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: productSchemas.postProductSalesRouterSchema,
    },
    productController.postProductSales,
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

  app.post(
    '/stock/deliveries',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: productSchemas.postStockDeliveryRouterSchema,
    },
    productController.postStockDelivery,
  );

  app.post(
    '/stock/write-offs',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: productSchemas.postStockWriteOffRouterSchema,
    },
    productController.postStockWriteOff,
  );

  app.post(
    '/:productId/restore',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('productId')],
      schema: productSchemas.restoreProductRouterSchema,
    },
    productController.restoreProduct,
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

  // the variants of a product: one variant on its own (every role), the writes (admin and root)
  app.get(
    '/:productId/variants/:variantId',
    {
      preHandler: [
        authGuard,
        requireRole(['ADMIN', 'GUEST', 'ROOT', 'USER']),
        validateId('productId'),
        validateId('variantId'),
      ],
      schema: variantSchemas.getVariantRouterSchema,
    },
    variantController.getVariant,
  );

  app.post(
    '/:productId/variants',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('productId')],
      schema: variantSchemas.postVariantsRouterSchema,
    },
    variantController.postVariants,
  );

  app.patch(
    '/:productId/variants/:variantId',
    {
      preHandler: [
        authGuard,
        requireRole(['ADMIN', 'ROOT']),
        validateId('productId'),
        validateId('variantId'),
      ],
      schema: variantSchemas.patchVariantRouterSchema,
    },
    variantController.patchVariant,
  );

  // the same change for several variants of a product
  app.patch(
    '/:productId/variants',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('productId')],
      schema: variantSchemas.patchVariantsRouterSchema,
    },
    variantController.patchVariants,
  );

  // many variants of any products, each with the fields of its own; a path of its own wins over
  // :productId
  app.patch(
    '/variants/batch',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: variantSchemas.patchVariantsBatchRouterSchema,
    },
    variantController.patchVariantsBatch,
  );

  app.delete(
    '/:productId/variants/:variantId',
    {
      preHandler: [
        authGuard,
        requireRole(['ADMIN', 'ROOT']),
        validateId('productId'),
        validateId('variantId'),
      ],
      schema: variantSchemas.deleteVariantRouterSchema,
    },
    variantController.deleteVariant,
  );

  app.post(
    '/:productId/variants/:variantId/restore',
    {
      preHandler: [
        authGuard,
        requireRole(['ADMIN', 'ROOT']),
        validateId('productId'),
        validateId('variantId'),
      ],
      schema: variantSchemas.restoreVariantRouterSchema,
    },
    variantController.restoreVariant,
  );

  // the gallery of a product: more pictures (a form of files), a picture out
  app.post(
    '/:productId/images',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('productId')],
      schema: variantSchemas.postGalleryImagesRouterSchema,
      config: { formBodySchema: 'galleryUploadFormSchema' },
    },
    variantController.postGalleryImages,
  );

  app.delete(
    '/:productId/images/:imageId',
    {
      preHandler: [
        authGuard,
        requireRole(['ADMIN', 'ROOT']),
        validateId('productId'),
        validateId('imageId'),
      ],
      schema: variantSchemas.deleteGalleryImageRouterSchema,
    },
    variantController.deleteGalleryImage,
  );
}
