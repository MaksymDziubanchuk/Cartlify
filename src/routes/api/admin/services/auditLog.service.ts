import { Prisma, type AdminAuditEntityType } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { toCsv, type CsvColumn } from '@helpers/csv.js';
import { BadRequestError, InternalError, isAppError } from '@utils/errors.js';

import { periodOf } from './stockMovements.service.js';

import type {
  AdminAuditLogItemDto,
  AdminAuditLogQueryDto,
  GetAdminAuditLogResponseDto,
} from 'types/dto/admin.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the admin log for admin and root (GET /api/admin/audit-log): who did what to what, from which
// address and browser, the newest first, with the filters of an actor, a thing, the actions and a
// period; the policies let every admin read it (aal_select)

export type AuditLogArgs = {
  actorId: UserId;
  actorRole: Role;
  filterActorId?: number | undefined;
  entityType?: string | undefined;
  entityId?: number | undefined;
  actions?: string[] | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit: number;
  cursor?: string | undefined;
};

export function auditLogArgsOf(
  query: AdminAuditLogQueryDto,
  actor: { id: UserId; role: Role },
): AuditLogArgs {
  return {
    actorId: actor.id,
    actorRole: actor.role,
    filterActorId: query.actorId,
    entityType: query.entityType,
    entityId: query.entityId,
    actions: query.actions ? [...new Set(query.actions.split(','))] : undefined,
    ...periodOf(query),
    limit: query.limit ?? 20,
    cursor: query.cursor,
  };
}

const SORT_KEY = 'createdAt:desc';

type Cursor = { id: number; v: string; s: string };

function readCursor(text: string): Cursor {
  const cursor = decodeCursor(text) as unknown as Partial<Cursor>;
  if (cursor.s !== SORT_KEY || typeof cursor.v !== 'string' || Number.isNaN(Date.parse(cursor.v))) {
    throw new BadRequestError('CURSOR_INVALID');
  }
  return cursor as Cursor;
}

function whereOf(args: AuditLogArgs): Prisma.AdminAuditLogWhereInput {
  return {
    ...(args.filterActorId !== undefined ? { actorId: args.filterActorId } : {}),
    ...(args.entityType !== undefined
      ? { entityType: args.entityType as AdminAuditEntityType }
      : {}),
    ...(args.entityId !== undefined ? { entityId: args.entityId } : {}),
    ...(args.actions ? { action: { in: args.actions as never } } : {}),
    ...(args.from || args.to
      ? {
          createdAt: {
            ...(args.from ? { gte: args.from } : {}),
            ...(args.to ? { lt: args.to } : {}),
          },
        }
      : {}),
  };
}

const lineSelect = {
  id: true,
  actorRole: true,
  entityType: true,
  entityId: true,
  action: true,
  meta: true,
  ip: true,
  userAgent: true,
  createdAt: true,
  actor: { select: { id: true, name: true, email: true, role: true, deletedAt: true } },
} as const;

type LineRow = Prisma.AdminAuditLogGetPayload<{ select: typeof lineSelect }>;

const itemOf = (row: LineRow): AdminAuditLogItemDto => ({
  id: row.id,
  actor: {
    id: row.actor.id as UserId,
    name: row.actor.name,
    // a deleted account keeps its lines, not its address
    email: row.actor.deletedAt ? null : row.actor.email,
    role: row.actor.role,
  },
  actorRole: row.actorRole,
  entityType: row.entityType,
  entityId: row.entityId,
  action: row.action,
  changes: Array.isArray(row.meta) ? (row.meta as AdminAuditLogItemDto['changes']) : [],
  ip: row.ip,
  userAgent: row.userAgent,
  createdAt: row.createdAt.toISOString(),
});

export async function listAuditLog(args: AuditLogArgs): Promise<GetAdminAuditLogResponseDto> {
  const where = whereOf(args);
  const cursor = args.cursor ? readCursor(args.cursor) : null;
  const after: Prisma.AdminAuditLogWhereInput | null = cursor
    ? {
        OR: [
          { createdAt: { lt: new Date(cursor.v) } },
          { createdAt: new Date(cursor.v), id: { lt: cursor.id } },
        ],
      }
    : null;

  try {
    const { rows, total } = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: args.actorId, role: args.actorRole });

      const rows = await tx.adminAuditLog.findMany({
        where: after ? { AND: [where, after] } : where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: args.limit + 1,
        select: lineSelect,
      });
      return { rows, total: await tx.adminAuditLog.count({ where }) };
    });

    const page = rows.slice(0, args.limit);
    const last = page[page.length - 1];

    return {
      items: page.map(itemOf),
      limit: args.limit,
      total,
      nextCursor:
        rows.length > args.limit && last
          ? encodeCursor({ id: last.id, v: last.createdAt.toISOString(), s: SORT_KEY } as never)
          : null,
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'ADMIN_AUDIT_LOG_UNEXPECTED' }, err);
  }
}

const CSV_COLUMNS: CsvColumn<AdminAuditLogItemDto>[] = [
  { header: 'id', kind: 'number', value: (row) => row.id },
  { header: 'createdAt', kind: 'text', value: (row) => row.createdAt },
  { header: 'actorId', kind: 'number', value: (row) => row.actor.id },
  { header: 'actorRole', kind: 'text', value: (row) => row.actorRole },
  { header: 'action', kind: 'text', value: (row) => row.action },
  { header: 'entityType', kind: 'text', value: (row) => row.entityType },
  { header: 'entityId', kind: 'number', value: (row) => row.entityId },
  { header: 'ip', kind: 'text', value: (row) => row.ip },
  { header: 'userAgent', kind: 'text', value: (row) => row.userAgent },
  { header: 'changes', kind: 'text', value: (row) => JSON.stringify(row.changes) },
];

// every line of the filters as a csv file, without pages
export async function auditLogCsv(args: AuditLogArgs): Promise<{ fileName: string; body: string }> {
  try {
    const rows = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: args.actorId, role: args.actorRole });
      return tx.adminAuditLog.findMany({
        where: whereOf(args),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: lineSelect,
      });
    });

    return {
      fileName: `cartlify-admin-log-${new Date().toISOString().slice(0, 10)}.csv`,
      body: toCsv(CSV_COLUMNS, rows.map(itemOf)),
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'ADMIN_AUDIT_LOG_CSV_UNEXPECTED' }, err);
  }
}
