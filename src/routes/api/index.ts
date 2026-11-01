import { FastifyInstance } from 'fastify';
import {
  getHealthRouter,
  getProjectInfoRouter,
  getReadyStatusRouter,
} from '@routes/api/system/index.js';
import { authRouter } from '@routes/api/auth/index.js';
import { usersRouter } from '@routes/api/users/index.js';
import { productRouter } from '@routes/api/products/index.js';
import { categoriesRouter } from '@routes/api/categories/index.js';
import { partiesRouter } from '@routes/api/parties/index.js';
import { documentsRouter } from '@routes/api/documents/index.js';
import { attributesRouter, categoryAttributesRouter } from '@routes/api/attributes/index.js';
import { ordersRouter } from '@routes/api/orders/index.js';
import { paymentsRouter } from '@routes/api/payments/index.js';
import { favoritesRouter } from '@routes/api/favorites/index.js';
import { reviewsRouter } from '@routes/api/reviews/index.js';
import { adminRouter } from '@routes/api/admin/index.js';
import { rootRouter } from '@routes/api/root/index.js';
import { chatRouter } from '@routes/api/chat/index.js';
import { legalRouter } from '@routes/api/legal/index.js';
import { deliveryRouter } from '@routes/api/delivery/index.js';

export async function registerRoutes(app: FastifyInstance) {
  app.register(getHealthRouter, { prefix: '/health' });
  app.register(getReadyStatusRouter, { prefix: '/ready' });
  app.register(getProjectInfoRouter, { prefix: '/info' });
  app.register(authRouter, { prefix: 'api/auth' });
  app.register(usersRouter, { prefix: 'api/users' });
  app.register(productRouter, { prefix: 'api/products' });
  app.register(categoriesRouter, { prefix: 'api/categories' });
  app.register(ordersRouter, { prefix: 'api/orders' });
  app.register(paymentsRouter, { prefix: 'api/payments' });
  app.register(favoritesRouter, { prefix: 'api/favorites' });
  app.register(reviewsRouter, { prefix: 'api/reviews' });
  app.register(adminRouter, { prefix: 'api/admin' });
  app.register(partiesRouter, { prefix: 'api/admin/parties' });
  app.register(documentsRouter, { prefix: 'api/admin/documents' });
  app.register(attributesRouter, { prefix: 'api/admin' });
  app.register(categoryAttributesRouter, { prefix: 'api/categories' });
  app.register(rootRouter, { prefix: 'api/root' });
  app.register(chatRouter, { prefix: 'api/chat' });
  app.register(legalRouter, { prefix: 'api/legal' });
  app.register(deliveryRouter, { prefix: 'api/delivery' });
}
