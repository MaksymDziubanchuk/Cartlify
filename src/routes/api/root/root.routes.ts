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
import { taxesController } from '../taxes/taxes.controllers.js';
import { rootTaxesSchemas } from '../taxes/taxes.schemas.js';

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
  // root gives an admin the right to run the newsletters, or takes it away
  app.patch(
    '/admins/:adminId',
    {
      preHandler: [authGuard, requireRole(['ROOT']), validateId('adminId')],
      schema: rootAdminsSchemas.patchRootAdminSchema,
    },
    rootAdminsController.patchAdmin,
  );
  app.delete(
    '/admins/:adminId',
    {
      preHandler: [authGuard, requireRole(['ROOT']), validateId('adminId')],
      schema: rootAdminsSchemas.deleteRootAdminSchema,
    },
    rootAdminsController.deleteAdmin,
  );
  // root resets the second step of the login of an admin who lost the phone and the codes
  app.delete(
    '/admins/:adminId/two-factor',
    {
      preHandler: [authGuard, requireRole(['ROOT']), validateId('adminId')],
      schema: rootAdminsSchemas.deleteRootAdminTwoFactorSchema,
    },
    rootAdminsController.deleteAdminTwoFactor,
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

  // the data of the shop: root sets every setting or one, and reads the history (the current
  // values are at GET /api/admin/shop-settings, shared with admin)
  app.put(
    '/shop-settings',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootShopSettingsSchemas.putShopSettingsSchema,
    },
    shopSettingsController.putValues,
  );
  app.put(
    '/shop-settings/:key',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootShopSettingsSchemas.putShopSettingSchema,
    },
    shopSettingsController.putValue,
  );
  app.get(
    '/shop-settings/history',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootShopSettingsSchemas.getShopSettingsHistorySchema,
    },
    shopSettingsController.getHistory,
  );
  // how many people have each language, for the warning before one is turned off
  app.get(
    '/shop-settings/locale-counts',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootShopSettingsSchemas.getShopLocaleCountsSchema,
    },
    shopSettingsController.getLocaleCounts,
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

  // the countries the shop sells to with the rule of their tax, and the tax groups of the products
  // (docs/taxes.md)
  const root = { preHandler: [authGuard, requireRole(['ROOT'])] };
  app.get(
    '/countries',
    { ...root, schema: rootTaxesSchemas.getShopCountriesSchema },
    taxesController.getCountries,
  );
  app.get(
    '/countries/:country',
    { ...root, schema: rootTaxesSchemas.getShopCountrySchema },
    taxesController.getCountry,
  );
  app.put(
    '/countries/:country',
    { ...root, schema: rootTaxesSchemas.putShopCountrySchema },
    taxesController.putCountry,
  );
  app.delete(
    '/countries/:country',
    { ...root, schema: rootTaxesSchemas.deleteShopCountrySchema },
    taxesController.deleteCountry,
  );
  app.post(
    '/countries/:country/copy-exceptions',
    { ...root, schema: rootTaxesSchemas.postCopyExceptionsSchema },
    taxesController.postCopyExceptions,
  );
  app.get(
    '/tax-groups',
    { ...root, schema: rootTaxesSchemas.getTaxGroupsSchema },
    taxesController.getGroups,
  );
  app.post(
    '/tax-groups',
    { ...root, schema: rootTaxesSchemas.postTaxGroupSchema },
    taxesController.postGroup,
  );
  app.patch(
    '/tax-groups/:groupId',
    {
      preHandler: [authGuard, requireRole(['ROOT']), validateId('groupId')],
      schema: rootTaxesSchemas.patchTaxGroupSchema,
    },
    taxesController.patchGroup,
  );
  app.delete(
    '/tax-groups/:groupId',
    {
      preHandler: [authGuard, requireRole(['ROOT']), validateId('groupId')],
      schema: rootTaxesSchemas.deleteTaxGroupSchema,
    },
    taxesController.deleteGroup,
  );
}
