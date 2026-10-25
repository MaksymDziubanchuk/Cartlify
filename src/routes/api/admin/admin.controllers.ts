import type { ControllerRouter } from 'types/controller.js';
import type { User } from 'types/user.js';
import type { FastifyReply } from 'fastify';
import type {
  AdminAlertDismissalDto,
  AdminAlertDismissalItemDto,
  AdminAlertDismissalParamsDto,
  AdminAlertKindParamsDto,
  AdminAlertSubscriptionDto,
  AdminAlertThresholdBodyDto,
  GetAdminAlertsQueryDto,
  AdminAuditLogQueryDto,
  GetAdminAlertsResponseDto,
  GetAdminAuditLogResponseDto,
  AdminAccountingQueryDto,
  AdminReportCategoriesQueryDto,
  AdminReportProductsQueryDto,
  AdminReportScopeQueryDto,
  AdminReportTimelineQueryDto,
  AdminStatsDto,
  AdminStatsQueryDto,
  AdminStockBatchesQueryDto,
  AdminStockMovementsQueryDto,
  GetAdminAccountingResponseDto,
  GetAdminReportCategoriesResponseDto,
  GetAdminReportProductsResponseDto,
  GetAdminReportTimelineResponseDto,
  GetAdminStatsResponseDto,
  GetAdminStockBatchesResponseDto,
  GetAdminStockMovementsResponseDto,
} from 'types/dto/admin.dto.js';
import { BadRequestError, UnauthorizedError } from '@utils/errors.js';
import { isDbYear } from '@helpers/dbDate.js';
import { adminServices } from './admin.services.js';
import { parseProductIds } from './services/helpers/accountingReport.helper.js';
import { stockBatchesArgsOf } from './services/stockBatches.service.js';
import { stockMovementsArgsOf } from './services/stockMovements.service.js';
import { auditLogArgsOf } from './services/auditLog.service.js';

const ALL_TIME_FROM_MS = 0;

function parseOptionalStatsDateMs(value: string | undefined, field: 'from' | 'to'): number | null {
  if (value === undefined) return null;

  const ms = Date.parse(value);

  if (Number.isNaN(ms) || !isDbYear(new Date(ms))) {
    throw new BadRequestError('INVALID_STATS_PERIOD', {
      field,
      reason: 'INVALID_DATE',
    });
  }

  return ms;
}

function normalizeStatsQuery(query: AdminStatsQueryDto, actor: User): AdminStatsDto {
  const parsedFromMs = parseOptionalStatsDateMs(query.from, 'from');
  const parsedToMs = parseOptionalStatsDateMs(query.to, 'to');

  const fromMs = parsedFromMs ?? ALL_TIME_FROM_MS;
  const toMs = parsedToMs ?? Date.now();

  if (fromMs > toMs) {
    throw new BadRequestError('INVALID_STATS_PERIOD', {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      reason: 'FROM_AFTER_TO',
    });
  }

  return {
    from: new Date(fromMs),
    to: new Date(toMs),
    actorId: actor.id,
    actorRole: actor.role,
  };
}

const getAllStats: ControllerRouter<{}, {}, AdminStatsQueryDto, GetAdminStatsResponseDto> = async (
  req,
  reply,
) => {
  // authGuard should attach actor before role guard
  if (!req.user) {
    throw new UnauthorizedError('LOGIN_REQUIRED');
  }

  // normalize query and pass actor context into service
  const dto = normalizeStatsQuery(req.query, req.user);

  const result = await adminServices.showAllStats(dto);

  return reply.code(200).send(result);
};

// the money of a period [from, to): all time until now when no period is given, the products
// asked for or all of them
const getAccountingReport: ControllerRouter<
  {},
  {},
  AdminAccountingQueryDto,
  GetAdminAccountingResponseDto
> = async (req, reply) => {
  if (!req.user) {
    throw new UnauthorizedError('LOGIN_REQUIRED');
  }

  const period = normalizeStatsQuery(req.query, req.user);
  const productIds = parseProductIds(req.query.productIds);

  const result = await adminServices.buildAccountingReport({
    ...period,
    ...(productIds ? { productIds } : {}),
    ...scopeOf(req.query),
  });

  return reply.code(200).send(result);
};

// the products of a report: a category with its whole branch unless branch is false
const scopeOf = (query: AdminReportScopeQueryDto) => ({
  ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
  branch: query.branch !== false,
});

// a report as a file for the accountant
const sendCsv = (reply: FastifyReply, file: { fileName: string; body: string }) =>
  reply
    .code(200)
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${file.fileName}"`)
    .send(file.body);

// the money of each product, sorted and paged; the csv has every product
const getAccountingProducts: ControllerRouter<
  {},
  {},
  AdminReportProductsQueryDto,
  GetAdminReportProductsResponseDto
> = async (req, reply) => {
  if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

  const q = req.query;
  const args = {
    ...normalizeStatsQuery(q, req.user),
    ...scopeOf(q),
    sortBy: q.sortBy ?? 'revenue',
    sortOrder: q.sortOrder ?? 'desc',
    limit: q.limit ?? 20,
    cursor: q.cursor,
  };

  if (q.format === 'csv') return sendCsv(reply, await adminServices.reportProductsCsv(args));
  return reply.code(200).send(await adminServices.reportProducts(args));
};

// the money of each category, with its branch or its own products only
const getAccountingCategories: ControllerRouter<
  {},
  {},
  AdminReportCategoriesQueryDto,
  GetAdminReportCategoriesResponseDto
> = async (req, reply) => {
  if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

  const q = req.query;
  const args = {
    ...normalizeStatsQuery(q, req.user),
    ...scopeOf(q),
    sortBy: q.sortBy ?? 'revenue',
    sortOrder: q.sortOrder ?? 'desc',
  };

  if (q.format === 'csv') return sendCsv(reply, await adminServices.reportCategoriesCsv(args));
  return reply.code(200).send(await adminServices.reportCategories(args));
};

// the money of the days, weeks or months of the shop; without a start, the step of the end and
// the eleven before it
const getAccountingTimeline: ControllerRouter<
  {},
  {},
  AdminReportTimelineQueryDto,
  GetAdminReportTimelineResponseDto
> = async (req, reply) => {
  if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

  const q = req.query;
  const period = normalizeStatsQuery(q, req.user);
  const productIds = parseProductIds(q.productIds);
  const args = {
    actorId: period.actorId,
    actorRole: period.actorRole,
    to: period.to,
    from: q.from === undefined ? undefined : period.from,
    ...(productIds ? { productIds } : {}),
    ...scopeOf(q),
    step: q.step ?? 'month',
    sortBy: q.sortBy ?? 'period',
    sortOrder: q.sortOrder ?? 'asc',
  };

  if (q.format === 'csv') return sendCsv(reply, await adminServices.reportTimelineCsv(args));
  return reply.code(200).send(await adminServices.reportTimeline(args));
};

// the batches of the stock, a page at a time
const getStockBatches: ControllerRouter<
  {},
  {},
  AdminStockBatchesQueryDto,
  GetAdminStockBatchesResponseDto
> = async (req, reply) => {
  if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

  const result = await adminServices.listStockBatches(stockBatchesArgsOf(req.query, req.user));
  return reply.code(200).send(result);
};

// the steps of the stock in one journal, a page at a time
const getStockMovements: ControllerRouter<
  {},
  {},
  AdminStockMovementsQueryDto,
  GetAdminStockMovementsResponseDto
> = async (req, reply) => {
  if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

  const result = await adminServices.listStockMovements(stockMovementsArgsOf(req.query, req.user));
  return reply.code(200).send(result);
};

// the admin log with its filters; the csv has every line of them
const getAuditLog: ControllerRouter<
  {},
  {},
  AdminAuditLogQueryDto,
  GetAdminAuditLogResponseDto
> = async (req, reply) => {
  if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

  const args = auditLogArgsOf(req.query, req.user);
  if (req.query.format === 'csv') return sendCsv(reply, await adminServices.auditLogCsv(args));

  return reply.code(200).send(await adminServices.listAuditLog(args));
};

// the alerts of the actor, each kind of their zone with its count, or the ones they follow
const getAlerts: ControllerRouter<
  {},
  {},
  GetAdminAlertsQueryDto,
  GetAdminAlertsResponseDto
> = async (req, reply) => {
  if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

  const result = await adminServices.getAdminAlerts(
    { actorId: req.user.id, actorRole: req.user.role },
    { subscribed: req.query.subscribed === true },
  );
  return reply.code(200).send(result);
};

const getAlertSubscriptions: ControllerRouter<
  {},
  {},
  {},
  { items: AdminAlertSubscriptionDto[] }
> = async (req, reply) => {
  if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

  const result = await adminServices.getAlertSubscriptions({
    actorId: req.user.id,
    actorRole: req.user.role,
  });
  return reply.code(200).send(result);
};

// a kind of alerts on (PUT) or off (DELETE) for the actor
const alertSubscription =
  (
    subscribed: boolean,
  ): ControllerRouter<AdminAlertKindParamsDto, {}, {}, AdminAlertSubscriptionDto> =>
  async (req, reply) => {
    if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

    const result = await adminServices.setAlertSubscription({
      actorId: req.user.id,
      actorRole: req.user.role,
      kind: req.params.kind,
      subscribed,
    });
    return reply.code(200).send(result);
  };

// the threshold of a kind of alerts set (PUT) or given back to the server (DELETE) for the actor
const putAlertThreshold: ControllerRouter<
  AdminAlertKindParamsDto,
  AdminAlertThresholdBodyDto,
  {},
  AdminAlertSubscriptionDto
> = async (req, reply) => {
  if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

  const result = await adminServices.setAlertThreshold({
    actorId: req.user.id,
    actorRole: req.user.role,
    kind: req.params.kind,
    value: req.body.value,
  });
  return reply.code(200).send(result);
};

const deleteAlertThreshold: ControllerRouter<
  AdminAlertKindParamsDto,
  {},
  {},
  AdminAlertSubscriptionDto
> = async (req, reply) => {
  if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

  const result = await adminServices.setAlertThreshold({
    actorId: req.user.id,
    actorRole: req.user.role,
    kind: req.params.kind,
    value: null,
  });
  return reply.code(200).send(result);
};

const getAlertDismissals: ControllerRouter<
  {},
  {},
  {},
  { items: AdminAlertDismissalItemDto[] }
> = async (req, reply) => {
  if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

  const result = await adminServices.getAlertDismissals({
    actorId: req.user.id,
    actorRole: req.user.role,
  });
  return reply.code(200).send(result);
};

// a case of an alert put aside (PUT) or taken back (DELETE) for the actor
const alertDismissal =
  (
    dismissed: boolean,
  ): ControllerRouter<AdminAlertDismissalParamsDto, {}, {}, AdminAlertDismissalDto> =>
  async (req, reply) => {
    if (!req.user) throw new UnauthorizedError('LOGIN_REQUIRED');

    const result = await adminServices.setAlertDismissal({
      actorId: req.user.id,
      actorRole: req.user.role,
      kind: req.params.kind,
      id: req.params.id,
      dismissed,
    });
    return reply.code(200).send(result);
  };

export const adminController = {
  getAllStats,
  getAccountingReport,
  getAccountingProducts,
  getAccountingCategories,
  getAccountingTimeline,
  getStockBatches,
  getStockMovements,
  getAuditLog,
  getAlerts,
  getAlertSubscriptions,
  putAlertSubscription: alertSubscription(true),
  deleteAlertSubscription: alertSubscription(false),
  putAlertThreshold,
  deleteAlertThreshold,
  getAlertDismissals,
  putAlertDismissal: alertDismissal(true),
  deleteAlertDismissal: alertDismissal(false),
};
