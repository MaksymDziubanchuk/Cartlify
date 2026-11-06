import type { FastifyInstance } from 'fastify';

import { shopSettingsController } from './shopSettings.controllers.js';
import { shopSettingsSchemas } from './shopSettings.schemas.js';

// the data of the shop a guest or a buyer is shown; the admin, root and the write routes are
// cross-registered into admin.routes.ts and root.routes.ts, as legal.routes.ts does for root
export default async function shopSettingsRouter(app: FastifyInstance) {
  app.get(
    '/',
    { schema: shopSettingsSchemas.getPublicShopSettingsSchema },
    shopSettingsController.getPublic,
  );
}
