import type { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { adminSchema } from './admin.schemas.js';
import { adminController } from './admin.controllers.js';

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
}
