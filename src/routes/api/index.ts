import { FastifyInstance } from 'fastify';
import { app } from '../../app.js';
import {
  getHealthRouter,
  getProjectInfoRouter,
  getReadyStatusRouter,
} from '@routes/api/system/index.js';
import { authRouter } from '@routes/api/auth/index.js';
import { usersRouter } from '@routes/api/users/index.js';
import { productRouter } from '@routes/api/products/index.js';
import { categoriesRouter } from '@routes/api/categories/index.js';
import { ordersRouter } from '@routes/api/orders/index.js';
import { favoritesRouter } from '@routes/api/favorites/index.js';
import { reviewsRouter } from '@routes/api/reviews/index.js';
import { adminRouter } from '@routes/api/admin/index.js';
import { rootRouter } from '@routes/api/root/index.js';
import { chatRouter } from '@routes/api/chat/index.js';

import { paramsSchemas } from '@schemas/index.js';
import { authSchemas } from '@schemas/dto/auth.dtoSchemas.js';
import { productDtoSchemas } from '@schemas/dto/products.dtoSchemas.js';

export async function registerRoutes(app: FastifyInstance) {
  app.register(getHealthRouter, { prefix: '/health' });
  app.register(getReadyStatusRouter, { prefix: '/ready' });
  app.register(getProjectInfoRouter, { prefix: '/info' });
  app.register(authRouter, { prefix: '/auth' });
  app.register(usersRouter, { prefix: '/users' });
  app.register(productRouter, { prefix: '/products' });
  app.register(categoriesRouter, { prefix: '/categories' });
  app.register(ordersRouter, { prefix: '/orders' });
  app.register(favoritesRouter, { prefix: '/favorites' });
  app.register(reviewsRouter, { prefix: '/reviews' });
  app.register(adminRouter, { prefix: '/admin' });
  app.register(rootRouter, { prefix: '/root' });
  app.register(chatRouter, { prefix: '/chat' });
}

Object.values(paramsSchemas).forEach((schema) => {
  app.addSchema(schema);
});

Object.values(authSchemas).forEach((schema) => {
  app.addSchema(schema);
});

Object.values(productDtoSchemas).forEach((schema) => {
  app.addSchema(schema);
});
