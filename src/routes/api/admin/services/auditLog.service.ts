import { Prisma } from '@prisma/client';

import { AUDIT_EVENTS } from '@config/journalEvents.js';
import { HIDDEN_ID, hiddenAccount, hiddenChanges, hiddenText } from '@helpers/rootHidden.js';

import {
  journalArgsOf,
  journalCsv,
  listJournal,
  type JournalArgs,
  type JournalDef,
  type JournalQuery,
} from './helpers/journal.helper.js';

import type {
  AdminAuditLogItemDto,
  AdminAuditLogQueryDto,
  GetAdminAuditLogResponseDto,
} from 'types/dto/admin.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the admin log for admin and root (GET /api/admin/audit-log): who did what to what, from which
// address and browser, with the event that made the line. The journal engine gives it its sorts,
// its period, its events and columns (journal.helper.ts); the filters are the account and its
// role, a thing, the actions and a field among the changes. The policies let every admin read it
// (aal_select). An admin sees the same lines as root with the same filters, and not who root is:
// in the lines root wrote the account, the address and the browser are hidden, in the lines about
// the account of root the id of it and the values of the changes (the fields are named)

export type AuditLogArgs = JournalArgs & {
  filterActorId?: number | undefined;
  filterActorRole?: Role | undefined;
  entityType?: string | undefined;
  entityId?: number | undefined;
  actions?: string[] | undefined;
  // the lines with a change of this field
  field?: string | undefined;
};

type AuditRow = {
  id: number;
  createdAt: Date;
  actorId: number;
  actorRole: Role;
  action: string;
  event: string;
  entityType: string;
  entityId: number | null;
  ip: string | null;
  userAgent: string | null;
  meta: unknown;
  actorName: string | null;
  actorEmail: string;
  actorRoleNow: Role;
  actorDeleted: boolean;
};

const l = (column: string) => Prisma.raw(`l."${column}"`);

const AUDIT_SORTS = {
  id: { sql: Prisma.sql`l.id`, kind: 'number' },
  createdAt: { sql: l('createdAt'), kind: 'date' },
  actorId: { sql: l('actorId'), kind: 'number' },
  actorRole: { sql: Prisma.sql`l."actorRole"::text`, kind: 'text' },
  action: { sql: Prisma.sql`l.action::text`, kind: 'text' },
  event: { sql: l('event'), kind: 'text' },
  entityType: { sql: Prisma.sql`l."entityType"::text`, kind: 'text' },
  entityId: { sql: l('entityId'), kind: 'number' },
  ip: { sql: l('ip'), kind: 'text' },
  userAgent: { sql: l('userAgent'), kind: 'text' },
} as const;

type AuditItem = Partial<AdminAuditLogItemDto> & Record<string, unknown>;

const AUDIT_DEF: JournalDef<AuditRow, AuditItem> = {
  fileName: 'admin-log',
  from: Prisma.sql`cartlify.admin_audit_log AS l
    JOIN cartlify.users AS a ON a.id = l."actorId"
    LEFT JOIN cartlify.users AS t ON l."entityType" = 'user'::cartlify."AdminAuditEntityType" AND t.id = l."entityId"`,
  select: Prisma.sql`
    l.id, l."createdAt", l."actorId", l."actorRole", l.action::text AS action, l.event,
    l."entityType"::text AS "entityType", l."entityId", l.ip, l."userAgent", l.meta,
    a.name AS "actorName", a.email AS "actorEmail", a.role AS "actorRoleNow",
    (a."deletedAt" IS NOT NULL) AS "actorDeleted", (t.role = 'ROOT'::cartlify."Role") AS "aboutRoot"`,
  createdAt: l('createdAt'),
  event: l('event'),
  columns: [
    'id',
    'createdAt',
    'actorId',
    'actor',
    'actorRole',
    'action',
    'event',
    'entityType',
    'entityId',
    'ip',
    'userAgent',
    'changes',
  ],
  sorts: AUDIT_SORTS,
  events: AUDIT_EVENTS,
  reason: 'ADMIN_AUDIT_LOG_UNEXPECTED',
  itemOf: (row, viewer) => {
    const about = (row as AuditRow & { aboutRoot: boolean | null }).aboutRoot === true;
    // root, whoever it is now: an admin sees the role of it and nothing else
    const isRoot = row.actorRole === 'ROOT' || row.actorRoleNow === 'ROOT';
    const hideActor = viewer !== 'ROOT' && isRoot;
    const hideAbout = viewer !== 'ROOT' && about;

    // a deleted account keeps its lines, not its address
    const email = row.actorDeleted ? null : row.actorEmail;
    const changes = Array.isArray(row.meta) ? (row.meta as unknown[]) : [];

    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      actorId: hideActor ? HIDDEN_ID : (row.actorId as UserId),
      actor: hideActor
        ? hiddenAccount(row.actorName, email)
        : {
            id: row.actorId as UserId,
            name: row.actorName,
            email,
            role: row.actorRoleNow,
          },
      actorRole: row.actorRole,
      action: row.action,
      event: row.event,
      entityType: row.entityType,
      entityId: hideAbout ? HIDDEN_ID : row.entityId,
      ip: hideActor ? hiddenText(row.ip) : row.ip,
      userAgent: hideActor ? hiddenText(row.userAgent) : row.userAgent,
      changes: (hideAbout ? hiddenChanges(changes) : changes) as never[],
    };
  },
  csv: {
    id: [{ header: 'id', kind: 'number', value: (row) => row.id as number }],
    createdAt: [{ header: 'createdAt', kind: 'text', value: (row) => row.createdAt as string }],
    actorId: [{ header: 'actorId', kind: 'number', value: (row) => row.actorId as number | null }],
    actor: [
      {
        header: 'actorName',
        kind: 'text',
        value: (row) => (row.actor as AdminAuditLogItemDto['actor']).name,
      },
      {
        header: 'actorEmail',
        kind: 'text',
        value: (row) => (row.actor as AdminAuditLogItemDto['actor']).email,
      },
    ],
    actorRole: [{ header: 'actorRole', kind: 'text', value: (row) => row.actorRole as string }],
    action: [{ header: 'action', kind: 'text', value: (row) => row.action as string }],
    event: [{ header: 'event', kind: 'text', value: (row) => row.event as string }],
    entityType: [{ header: 'entityType', kind: 'text', value: (row) => row.entityType as string }],
    entityId: [
      { header: 'entityId', kind: 'number', value: (row) => row.entityId as number | null },
    ],
    ip: [{ header: 'ip', kind: 'text', value: (row) => row.ip as string | null }],
    userAgent: [
      { header: 'userAgent', kind: 'text', value: (row) => row.userAgent as string | null },
    ],
    changes: [{ header: 'changes', kind: 'text', value: (row) => JSON.stringify(row.changes) }],
  },
};

export function auditLogArgsOf(
  query: AdminAuditLogQueryDto,
  actor: { id: UserId; role: Role },
): AuditLogArgs {
  return {
    ...journalArgsOf(AUDIT_DEF, query as JournalQuery, actor),
    filterActorId: query.actorId,
    filterActorRole: query.actorRole,
    entityType: query.entityType,
    entityId: query.entityId,
    actions: query.actions ? [...new Set(query.actions.split(','))] : undefined,
    field: query.field,
  };
}

function filtersOf(args: AuditLogArgs): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (args.filterActorId !== undefined) parts.push(Prisma.sql`l."actorId" = ${args.filterActorId}`);
  if (args.filterActorRole !== undefined) {
    parts.push(Prisma.sql`l."actorRole" = ${args.filterActorRole}::cartlify."Role"`);
  }
  if (args.entityType !== undefined) {
    parts.push(Prisma.sql`l."entityType" = ${args.entityType}::cartlify."AdminAuditEntityType"`);
  }
  if (args.entityId !== undefined) parts.push(Prisma.sql`l."entityId" = ${args.entityId}`);
  if (args.actions) {
    parts.push(Prisma.sql`l.action = ANY(${args.actions}::cartlify."AdminAuditAction"[])`);
  }
  // the changes of a line are a list of { field, old, new }
  if (args.field !== undefined) {
    parts.push(Prisma.sql`l.meta @> ${JSON.stringify([{ field: args.field }])}::jsonb`);
  }

  return parts;
}

export const listAuditLog = (args: AuditLogArgs) =>
  listJournal(AUDIT_DEF, args, filtersOf(args)) as Promise<GetAdminAuditLogResponseDto>;

export const auditLogCsv = (args: AuditLogArgs) => journalCsv(AUDIT_DEF, args, filtersOf(args));
