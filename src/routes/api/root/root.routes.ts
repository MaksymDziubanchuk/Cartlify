import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { rootAdminsSchemas } from './root.schemas.js';
import { rootAdminsController } from './root.controllers.js';
import { legalController } from '../legal/legal.controllers.js';
import { rootLegalSchemas } from '../legal/legal.schemas.js';
import { shopSettingsController } from '../shopSettings/shopSettings.controllers.js';
import { rootShopSettingsSchemas } from '../shopSettings/shopSettings.schemas.js';

export default async function rootRouter(app: FastifyInstance) {
  app.get(
    '/admins',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootAdminsSchemas.getRootAdminsSchema,
    },
    rootAdminsController.getAdmins,
  );
  app.post(
    '/admins',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootAdminsSchemas.postRootAdminSchema,
    },
    rootAdminsController.postAdmin,
  );
  app.delete(
    '/admins/:adminId',
    {
      preHandler: [authGuard, requireRole(['ROOT']), validateId('adminId')],
      schema: rootAdminsSchemas.deleteRootAdminSchema,
    },
    rootAdminsController.deleteAdmin,
  );

  // the versions of the terms and of the contract
  app.post(
    '/legal-documents',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootLegalSchemas.postRootLegalDocumentSchema,
    },
    legalController.postDocument,
  );
  app.get(
    '/legal-documents',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootLegalSchemas.getRootLegalDocumentsSchema,
    },
    legalController.getDocuments,
  );

  // the data of the shop: root writes a new version and reads the history (the current fields
  // and one by its key are at GET /api/admin/shop-settings, shared with admin)
  app.put(
    '/shop-settings',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootShopSettingsSchemas.putShopSettingsSchema,
    },
    shopSettingsController.putValues,
  );
  app.get(
    '/shop-settings/history',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootShopSettingsSchemas.getShopSettingsHistorySchema,
    },
    shopSettingsController.getHistory,
  );
  app.post(
    '/shop-settings/logo',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      // a form only, with no json body to check: the controller reads and checks its part
      schema: rootShopSettingsSchemas.postShopLogoSchema,
      config: { formBodySchema: 'shopLogoFormSchema' },
    },
    shopSettingsController.postLogo,
  );
  app.delete(
    '/shop-settings/logo',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootShopSettingsSchemas.deleteShopLogoSchema,
    },
    shopSettingsController.deleteLogo,
  );
}
