// export type UserId = string | number;
// export type ProductId = number;
// export type OrderId = number;
// export type ReviewId = number;
// export type CategoryId = number;

// import fastify from 'fastify';
// import { LoggerOptions, TransportSingleOptions } from 'pino';
// import cors from '@fastify/cors';
// import helmet from '@fastify/helmet';
// import cookie from '@fastify/cookie';
// import rateLimit from '@fastify/rate-limit';
// import staticPlagin from '@fastify/static';
// import multipart from '@fastify/multipart';
// import formbody from '@fastify/formbody';
// import { fileURLToPath } from 'url';
// import path from 'path';
// import env from '@config/env.js';
// import { registerRoutes } from '@routes/api/index.js';
// import { commonSchemas } from '@schemas/index.js';
// import requestResponseLogger from '@middlewares/requestResponseLogger.js';
// import errorNormalizer from '@middlewares/errorNormalizer.js';
// import notFoundHandler from '@middlewares/notFoundHandler.js';

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// type LoggerOptionsWithTransport = LoggerOptions & {
//   transport?: TransportSingleOptions;
// };

// const loggerOptions: LoggerOptionsWithTransport = {
//   level: 'info',
//   redact: ['req.headers.authorization', 'request.headers.cookie', "res.headers['set-cookie']"],
// };

// if (env.NODE_ENV === 'development') {
//   loggerOptions.transport = {
//     target: 'pino-pretty',
//     options: { translateTime: true },
//   };
// }

// export const app = fastify({ logger: loggerOptions });

// app.register(requestResponseLogger);
// app.register(cors, { origin: true, credentials: true });
// app.register(helmet);
// app.register(cookie, { secret: env.COOKIE_SECRET });
// app.register(multipart, {
//   limits: {
//     fileSize: 10_000_000,
//   },
//   attachFieldsToBody: true,
// });
// app.register(formbody, { bodyLimit: 1048576 });
// app.register(staticPlagin, { root: path.join(__dirname, 'static'), prefix: '/static/' });
// app.register(rateLimit, {
//   max: 100,
//   timeWindow: '1 minute',
// });

// Object.values(commonSchemas).forEach((schema) => {
//   app.addSchema(schema);
// });

// await registerRoutes(app);

// app.register(notFoundHandler);
// app.register(errorNormalizer);

// import { FastifyInstance } from 'fastify';
// import { app } from '../../app.js';
// import {
//   getHealthRouter,
//   getProjectInfoRouter,
//   getReadyStatusRouter,
// } from '@routes/api/system/index.js';
// import { authRouter } from '@routes/api/auth/index.js';
// import { usersRouter } from '@routes/api/users/index.js';
// import { productRouter } from '@routes/api/products/index.js';
// import { categoriesRouter } from '@routes/api/categories/index.js';
// import { ordersRouter } from '@routes/api/orders/index.js';
// import { favoritesRouter } from '@routes/api/favorites/index.js';
// import { reviewsRouter } from '@routes/api/reviews/index.js';
// import { adminRouter } from '@routes/api/admin/index.js';
// import { rootRouter } from '@routes/api/root/index.js';
// import { chatRouter } from '@routes/api/chat/index.js';

// import { paramsSchemas } from '@schemas/index.js';
// import { authSchemas } from '@schemas/dto/auth.dtoSchemas.js';
// import { productDtoSchemas } from '@schemas/dto/products.dtoSchemas.js';

// export async function registerRoutes(app: FastifyInstance) {
//   app.register(getHealthRouter, { prefix: '/health' });
//   app.register(getReadyStatusRouter, { prefix: '/ready' });
//   app.register(getProjectInfoRouter, { prefix: '/info' });
//   app.register(authRouter, { prefix: '/auth' });
//   app.register(usersRouter, { prefix: '/users' });
//   app.register(productRouter, { prefix: '/products' });
//   app.register(categoriesRouter, { prefix: '/categories' });
//   app.register(ordersRouter, { prefix: '/orders' });
//   app.register(favoritesRouter, { prefix: '/favorites' });
//   app.register(reviewsRouter, { prefix: '/reviews' });
//   app.register(adminRouter, { prefix: '/admin' });
//   app.register(rootRouter, { prefix: '/root' });
//   app.register(chatRouter, { prefix: '/chat' });
// }

// Object.values(paramsSchemas).forEach((schema) => {
//   app.addSchema(schema);
// });

// Object.values(authSchemas).forEach((schema) => {
//   app.addSchema(schema);
// });

// Object.values(productDtoSchemas).forEach((schema) => {
//   app.addSchema(schema);
// });
// import { CategoryId, ProductId, ReviewId, UserId } from '../ids.js';

// export interface GetAllProductsQuery {
//   page?: number;
//   limit?: number;
//   sort?: 'price_asc' | 'price_desc' | 'popular';
//   categoryId?: CategoryId;
// }

// export interface FindAllProductsParams {
//   page: number;
//   limit: number;
//   sort?: 'price_asc' | 'price_desc' | 'popular';
//   categoryId?: CategoryId;
// }

// export interface CreateProductDto {
//   name: string;
//   description?: string;
//   price: number;
//   categoryId: CategoryId;
//   imageUrl?: string;
// }

// export interface UpdateProductDto {
//   name?: string;
//   description?: string;
//   price?: number;
//   categoryId?: CategoryId;
//   imageUrl?: string;
// }

// export interface CreateReviewDto {
//   rating: number;
//   comment?: string;
// }

// export interface ProductResponseDto {
//   id: ProductId;
//   name: string;
//   description?: string;
//   price: number;
//   categoryId: CategoryId;
//   imageUrl?: string;
// }

// export interface ReviewResponseDto {
//   id: ReviewId;
//   productId: ProductId;
//   rating: number;
//   comment?: string;
//   userId: UserId;
// }

// export interface ProductsListQueryDto {
//   page?: number;
//   limit?: number;
//   search?: string;
//   categoryId?: CategoryId;
//   minPrice?: number;
//   maxPrice?: number;
//   sortBy?: 'price' | 'name' | 'createdAt';
//   order?: 'asc' | 'desc';
// }
// export const getAllProductsSchema = {
//   $id: 'getAllProductsSchema',
//   type: 'object',
//   properties: {
//     page: { type: 'integer', minimum: 1 },
//     limit: { type: 'integer', minimum: 1, maximum: 100 },
//     sort: { type: 'string', enum: ['price_asc', 'price_desc', 'popular'] },
//     categoryId: { type: 'integer', minimum: 1 },
//   },
//   additionalProperties: false,
// } as const;

// export const createProductSchema = {
//   $id: 'createProductSchema',
//   type: 'object',
//   properties: {
//     name: { type: 'string', minLength: 1 },
//     description: { type: 'string' },
//     price: { type: 'number', minimum: 0 },
//     categoryId: { type: 'integer', minimum: 1 },
//     imageUrl: { type: 'string', format: 'uri' },
//   },
//   required: ['name', 'price', 'categoryId'],
//   additionalProperties: false,
// } as const;

// export const updateProductSchema = {
//   $id: 'updateProductSchema',
//   type: 'object',
//   properties: {
//     name: { type: 'string', minLength: 1 },
//     description: { type: 'string' },
//     price: { type: 'number', minimum: 0 },
//     categoryId: { type: 'integer', minimum: 1 },
//     imageUrl: { type: 'string', format: 'uri' },
//   },
//   additionalProperties: false,
// } as const;

// export const createReviewSchema = {
//   $id: 'createReviewSchema',
//   type: 'object',
//   properties: {
//     rating: { type: 'integer', minimum: 1, maximum: 5 },
//     comment: { type: 'string' },
//   },
//   required: ['rating'],
//   additionalProperties: false,
// } as const;

// export const updateReviewSchema = {
//   $id: 'updateReviewSchema',
//   type: 'object',
//   properties: {
//     rating: { type: 'integer', minimum: 1, maximum: 5 },
//     comment: { type: 'string' },
//   },
//   additionalProperties: false,
// } as const;

// export const productsListQuerySchema = {
//   $id: 'productsListQuerySchema',
//   type: 'object',
//   properties: {
//     page: { type: 'integer', minimum: 1 },
//     limit: { type: 'integer', minimum: 1, maximum: 100 },
//     search: { type: 'string' },
//     categoryId: { type: 'integer', minimum: 1 },
//     minPrice: { type: 'number', minimum: 0 },
//     maxPrice: { type: 'number', minimum: 0 },
//     sortBy: { type: 'string', enum: ['price', 'name', 'createdAt'] },
//     order: { type: 'string', enum: ['asc', 'desc'] },
//   },
//   additionalProperties: false,
// } as const;

// const productResponseSchema = {
//   $id: 'productResponseSchema',
//   type: 'object',
//   properties: {
//     id: { type: 'integer' },
//     name: { type: 'string' },
//     description: { type: 'string' },
//     price: { type: 'number' },
//     categoryId: { type: 'integer' },
//     imageUrl: { type: 'string', format: 'uri' },
//   },
//   required: ['id', 'name', 'price', 'categoryId'],
//   additionalProperties: false,
// } as const;

// const reviewResponseSchema = {
//   $id: 'reviewResponseSchema',
//   type: 'object',
//   properties: {
//     id: { type: 'integer' },
//     productId: { type: 'integer' },
//     rating: { type: 'integer', minimum: 1, maximum: 5 },
//     comment: { type: 'string' },
//     userId: { type: 'string' },
//   },
//   required: ['id', 'productId', 'rating', 'userId'],
//   additionalProperties: false,
// } as const;

// const productsListResponseSchema = {
//   $id: 'productsListResponseSchema',
//   type: 'object',
//   properties: {
//     items: {
//       type: 'array',
//       items: { $ref: 'products.item#' },
//     },
//     total: { type: 'integer', minimum: 0 },
//     page: { type: 'integer', minimum: 1 },
//     limit: { type: 'integer', minimum: 1 },
//   },
//   required: ['items', 'total', 'page', 'limit'],
//   additionalProperties: false,
// } as const;

// export const productDtoSchemas = {
//   createProductSchema,
//   updateProductSchema,
//   createReviewSchema,
//   updateReviewSchema,
//   productsListQuerySchema,
//   productResponseSchema,
//   reviewResponseSchema,
//   productsListResponseSchema,
// import { FastifyInstance } from 'fastify';
// import authGuard from '@middlewares/auth.js';
// import requireRole from '@middlewares/requireRole.js';
// import validateId from '@middlewares/validateId.js';
// import { productController } from './product.controllers.js';
// import { productSchemas } from './product.schemas.js';

// export default async function productsRouter(app: FastifyInstance, opt: unknown) {
//   app.get(
//     '/',
//     {
//       preHandler: [authGuard, requireRole(['ADMIN', 'GUEST', 'ROOT', 'USER'])],
//       schema: productSchemas.getAllProductsSchema,
//     },
//     productController.getAllProducts,
//   );

//   app.get(
//     '/:productId',
//     {
//       preHandler: [
//         authGuard,
//         requireRole(['ADMIN', 'GUEST', 'ROOT', 'USER']),
//         validateId('productId'),
//       ],
//       schema: productSchemas.getProductByIdSchema,
//     },
//     productController.getProductById,
//   );

//   app.get(
//     '/:productId/reviews',
//     {
//       preHandler: [
//         authGuard,
//         requireRole(['ADMIN', 'GUEST', 'ROOT', 'USER']),
//         validateId('productId'),
//       ],
//       schema: productSchemas.getProductReviewsSchema,
//     },
//     productController.getProductReviews,
//   );

//   app.post(
//     '/',
//     {
//       preHandler: [authGuard, requireRole(['ADMIN'])],
//       schema: productSchemas.postProductSchema,
//     },
//     productController.postProduct,
//   );

//   app.post(
//     '/:productId/reviews',
//     {
//       preHandler: [authGuard, requireRole(['USER']), validateId('productId')],
//       schema: productSchemas.postProductReviewSchema,
//     },
//     productController.postProductReview,
//   );

//   app.patch(
//     '/:productId',
//     {
//       preHandler: [authGuard, requireRole(['ADMIN']), validateId('productId')],
//       schema: productSchemas.updateProductByIdSchema,
//     },
//     productController.updateProductById,
//   );

//   app.delete(
//     '/:productId',
//     {
//       preHandler: [authGuard, requireRole(['ADMIN']), validateId('productId')],
//       schema: productSchemas.deleteProductByIdSchema,
//     },
//     productController.deleteProductById,
//   );

//   app.delete(
//     '/:productId/reviews/:reviewId',
//     {
//       preHandler: [
//         authGuard,
//         requireRole(['USER', 'ADMIN', 'ROOT']),
//         validateId('productId'),
//         validateId('reviewId'),
//       ],
//       schema: productSchemas.deleteProductReviewSchema,
//     },
//     productController.deleteProductReview,
//   );
// }const getAllProductsSchema = {
//   querystring: { $ref: 'getAllProductsSchema#' },
//   response: {
//     200: { $ref: 'paginatedList#' },
//   },
// } as const;

// const getProductByIdSchema = {
//   params: { $ref: 'productIdParamSchema#' },
//   response: {
//     200: { $ref: 'messageResponseSchema#' },
//   },
// };

// const getProductReviewsSchema = {
//   params: { $ref: 'productIdParamSchema#' },
//   response: {
//     200: { $ref: 'messageResponseSchema#' },
//   },
// };

// const postProductSchema = {
//   body: { $ref: 'createProductSchema#' },
//   response: {
//     200: { $ref: 'messageResponseSchema#' },
//   },
// };

// const postProductReviewSchema = {
//   params: { $ref: 'productIdParamSchema#' },
//   body: { $ref: 'createProductSchema#' },
//   response: {
//     200: { $ref: 'messageResponseSchema#' },
//   },
// };

// const updateProductByIdSchema = {
//   params: { $ref: 'productIdParamSchema#' },
//   body: { $ref: 'updateProductSchema#' },
//   response: {
//     200: { $ref: 'messageResponseSchema#' },
//   },
// };

// const deleteProductByIdSchema = {
//   params: { $ref: 'productIdParamSchema#' },
//   response: {
//     200: { $ref: 'messageResponseSchema#' },
//   },
// };

// const deleteProductReviewSchema = {
//   params: { $ref: 'productReviewIdsParamSchema#' },
//   response: {
//     200: { $ref: 'messageResponseSchema#' },
//   },
// };

// export const productSchemas = {
//   getAllProductsSchema,
//   getProductByIdSchema,
//   getProductReviewsSchema,
//   postProductSchema,
//   postProductReviewSchema,
//   updateProductByIdSchema,
//   deleteProductByIdSchema,
//   deleteProductReviewSchema,
// };
// import { ControllerRouter } from 'types/controller.js';
// import { productServices } from './product.services.js';
// import {
//   CreateProductDto,
//   UpdateProductDto,
//   CreateReviewDto,
//   FindAllProductsParams,
//   GetAllProductsQuery,
// } from 'types/dto/products.dto.js';

// const getAllProducts: ControllerRouter<{}, {}, GetAllProductsQuery, unknown> = async (
//   req,
//   reply,
// ) => {
//   const { page: qp, limit: ql, sort: qs, categoryId: qc } = req.query;
//   const page = qp ? Number(qp) : 1;
//   const limit = ql ? Number(ql) : 10;
//   const categoryId = qc ? Number(qc) : undefined;

//   const allowedSort: Array<'price_asc' | 'price_desc' | 'popular'> = [
//     'price_asc',
//     'price_desc',
//     'popular',
//   ];
//   const sort = allowedSort.includes(qs as any) ? (qs as (typeof allowedSort)[number]) : undefined;

//   const args: FindAllProductsParams = {
//     page,
//     limit,
//     ...(sort !== undefined ? { sort } : {}),
//     ...(categoryId !== undefined ? { categoryId } : {}),
//   };
//   const result = await productServices.findAll(args);
//   return result;
// };

// const getProductById: ControllerRouter<{ productId: string }> = async (req, reply) => {
//   const id = Number(req.params.productId);
//   const result = await productServices.findById(id);
//   return result;
// };

// const getProductReviews: ControllerRouter<{ productId: string }, {}, {}, unknown> = async (
//   req,
//   reply,
// ) => {
//   const id = Number(req.params.productId);
//   const result = await productServices.findReviews(id);
//   return result;
// };

// const postProduct: ControllerRouter<{}, CreateProductDto, {}, unknown> = async (req, reply) => {
//   const result = await productServices.createProduct(req.body);
//   return result;
// };

// const postProductReview: ControllerRouter<
//   { productId: string },
//   CreateReviewDto,
//   {},
//   unknown
// > = async (req, reply) => {
//   const id = Number(req.params.productId);
//   const result = await productServices.createReview(id, req.body);
//   return result;
// };

// const updateProductById: ControllerRouter<
//   { productId: string },
//   UpdateProductDto,
//   {},
//   unknown
// > = async (req, reply) => {
//   const id = Number(req.params.productId);
//   const result = await productServices.updateProduct(id, req.body);
//   return result;
// };

// const deleteProductById: ControllerRouter<{ productId: string }, {}, {}, unknown> = async (
//   req,
//   reply,
// ) => {
//   const id = Number(req.params.productId);
//   const result = await productServices.deleteProductById(id);
//   return result;
// };

// const deleteProductReview: ControllerRouter<
//   { productId: string; reviewId: string },
//   {},
//   {},
//   unknown
// > = async (req, reply) => {
//   const prodId = Number(req.params.productId);
//   const revId = Number(req.params.reviewId);
//   const result = await productServices.deleteProductReview(prodId, revId);
//   return result;
// };

// export const productController = {
//   getAllProducts,
//   getProductById,
//   getProductReviews,
//   postProduct,
//   postProductReview,
//   updateProductById,
//   deleteProductById,
//   deleteProductReview,
// };import { ProductId, ReviewId } from 'types/ids.js';
// import {
//   CreateProductDto,
//   UpdateProductDto,
//   CreateReviewDto,
//   FindAllProductsParams,
// } from 'types/dto/products.dto.js';

// async function findAll({ page, limit, sort, categoryId }: FindAllProductsParams) {
//   return {
//     message: 'findAll not implemented',
//   };
// }

// async function findById(productId: ProductId) {
//   return {
//     message: 'findById not implemented',
//   };
// }

// async function findReviews(productId: ProductId) {
//   return {
//     message: 'findReviews not implemented',
//   };
// }

// async function createProduct(data: CreateProductDto) {
//   return {
//     message: 'create not implemented',
//   };
// }

// async function createReview(productId: ProductId, data: CreateReviewDto) {
//   return {
//     message: 'createReview not implemented',
//   };
// }

// async function updateProduct(productId: ProductId, data: UpdateProductDto) {
//   return {
//     message: 'updateProduct not implemented',
//   };
// }

// async function deleteProductById(productId: ProductId) {
//   return {
//     message: 'daleteProduct not implemented',
//   };
// }

// async function deleteProductReview(productId: ProductId, reviewId: ReviewId) {
//   return {
//     message: 'daleteProductReview not implemented',
//   };
// }

// export const productServices = {
//   findAll,
//   findById,
//   findReviews,
//   createProduct,
//   createReview,
//   updateProduct,
//   deleteProductById,
//   deleteProductReview,
// };
