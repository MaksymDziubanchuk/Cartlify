import type { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { adminSchema } from './admin.schemas.js';
import { adminController } from './admin.controllers.js';
import { shopSettingsController } from '../shopSettings/shopSettings.controllers.js';
import { adminShopSettingsSchemas } from '../shopSettings/shopSettings.schemas.js';

export default async function adminRouter(app: FastifyInstance) {
  app.get(
    '/stats',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getStatsSchema,
    },
    adminController.getAllStats,
  );

  app.get(
    '/reports/accounting',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getAccountingReportSchema,
    },
    adminController.getAccountingReport,
  );

  app.get(
    '/reports/accounting/products',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getAccountingProductsSchema,
    },
    adminController.getAccountingProducts,
  );

  app.get(
    '/reports/accounting/variants',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getAccountingVariantsSchema,
    },
    adminController.getAccountingVariants,
  );

  app.get(
    '/reports/accounting/categories',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getAccountingCategoriesSchema,
    },
    adminController.getAccountingCategories,
  );

  app.get(
    '/reports/accounting/timeline',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getAccountingTimelineSchema,
    },
    adminController.getAccountingTimeline,
  );

  app.get(
    '/stock/batches',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getStockBatchesSchema,
    },
    adminController.getStockBatches,
  );

  app.get(
    '/stock/movements',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getStockMovementsSchema,
    },
    adminController.getStockMovements,
  );

  app.get(
    '/audit-log',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getAuditLogSchema,
    },
    adminController.getAuditLog,
  );

  app.get(
    '/stock-log',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getStockLogSchema,
    },
    adminController.getStockLog,
  );

  app.get(
    '/price-log',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getPriceLogSchema,
    },
    adminController.getPriceLog,
  );

  app.get(
    '/login-log',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getLoginLogSchema,
    },
    adminController.getLoginLog,
  );

  app.get(
    '/consent-log',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getConsentLogSchema,
    },
    adminController.getConsentLog,
  );

  app.get(
    '/log-events',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getLogEventsSchema,
    },
    adminController.getLogEvents,
  );

  app.get(
    '/alerts',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getAlertsSchema,
    },
    adminController.getAlerts,
  );

  app.get(
    '/alerts/subscriptions',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getAlertSubscriptionsSchema,
    },
    adminController.getAlertSubscriptions,
  );

  app.put(
    '/alerts/subscriptions/:kind',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.putAlertSubscriptionSchema,
    },
    adminController.putAlertSubscription,
  );

  app.delete(
    '/alerts/subscriptions/:kind',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.deleteAlertSubscriptionSchema,
    },
    adminController.deleteAlertSubscription,
  );

  app.put(
    '/alerts/subscriptions/:kind/threshold',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.putAlertThresholdSchema,
    },
    adminController.putAlertThreshold,
  );

  app.delete(
    '/alerts/subscriptions/:kind/threshold',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.deleteAlertThresholdSchema,
    },
    adminController.deleteAlertThreshold,
  );

  app.get(
    '/alerts/dismissals',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getAlertDismissalsSchema,
    },
    adminController.getAlertDismissals,
  );

  app.put(
    '/alerts/dismissals/:kind/:id',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.putAlertDismissalSchema,
    },
    adminController.putAlertDismissal,
  );

  app.delete(
    '/alerts/dismissals/:kind/:id',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.deleteAlertDismissalSchema,
    },
    adminController.deleteAlertDismissal,
  );

  // the data of the shop: every current field, the ones root has not set yet, one by its key
  app.get(
    '/shop-settings',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminShopSettingsSchemas.getShopSettingsValuesSchema,
    },
    shopSettingsController.getValues,
  );
  app.get(
    '/shop-settings/missing',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminShopSettingsSchemas.getShopSettingsMissingFieldsSchema,
    },
    shopSettingsController.getMissing,
  );
  app.get(
    '/shop-settings/:key',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminShopSettingsSchemas.getShopSettingsFieldSchema,
    },
    shopSettingsController.getField,
  );
}
