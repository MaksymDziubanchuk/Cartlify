import { Prisma } from '@prisma/client';

import { CONSENT_EVENTS } from '@config/journalEvents.js';
import { HIDDEN_ID, hiddenAccount, hiddenText } from '@helpers/rootHidden.js';

import {
  journalArgsOf,
  journalCsv,
  listJournal,
  type JournalArgs,
  type JournalDef,
  type JournalQuery,
} from './helpers/journal.helper.js';

import type {
  AdminConsentLogItemDto,
  AdminConsentLogQueryDto,
  GetAdminConsentLogResponseDto,
} from 'types/dto/admin.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the log of consents for admin and root (GET /api/admin/consent-log): who agreed to which version
// of the terms and of the contract, where (the registration, a login, an account made through a
// provider, the agreement a customer gives by itself, an order), from which address and browser.
// The policies let every admin read it. Only a customer agrees, but the journal holds the same
// rule as the others: what it knows of root is hidden from an admin

export type ConsentLogArgs = JournalArgs & {
  userId?: number | undefined;
  documentId?: number | undefined;
  orderId?: number | undefined;
  kind?: string | undefined;
};

type ConsentRow = {
  id: number;
  createdAt: Date;
  userId: number;
  documentId: number;
  orderId: number | null;
  ip: string | null;
  userAgent: string | null;
  event: string;
  userName: string | null;
  userEmail: string;
  userRoleNow: Role;
  userDeleted: boolean;
  kind: string;
  version: number;
  title: string;
};

const col = (column: string) => Prisma.raw(`l."${column}"`);

const CONSENT_SORTS = {
  id: { sql: Prisma.sql`l.id`, kind: 'number' },
  createdAt: { sql: col('createdAt'), kind: 'date' },
  userId: { sql: col('userId'), kind: 'number' },
  documentId: { sql: col('documentId'), kind: 'number' },
  orderId: { sql: col('orderId'), kind: 'number' },
  ip: { sql: col('ip'), kind: 'text' },
  userAgent: { sql: col('userAgent'), kind: 'text' },
  event: { sql: col('event'), kind: 'text' },
} as const;

type ConsentItem = Partial<AdminConsentLogItemDto> & Record<string, unknown>;

const CONSENT_DEF: JournalDef<ConsentRow, ConsentItem> = {
  fileName: 'consent-log',
  from: Prisma.sql`cartlify.legal_acceptances AS l
    JOIN cartlify.users AS u ON u.id = l."userId"
    JOIN cartlify.legal_documents AS d ON d.id = l."documentId"`,
  select: Prisma.sql`
    l.id, l."createdAt", l."userId", l."documentId", l."orderId", l.ip, l."userAgent", l.event,
    u.name AS "userName", u.email AS "userEmail", u.role AS "userRoleNow",
    (u."deletedAt" IS NOT NULL) AS "userDeleted", d.kind::text AS kind, d.version, d.title`,
  createdAt: col('createdAt'),
  event: col('event'),
  columns: [
    'id',
    'createdAt',
    'userId',
    'user',
    'documentId',
    'document',
    'orderId',
    'ip',
    'userAgent',
    'event',
  ],
  sorts: CONSENT_SORTS,
  events: CONSENT_EVENTS,
  reason: 'ADMIN_CONSENT_LOG_UNEXPECTED',
  itemOf: (row, viewer) => {
    const hide = viewer !== 'ROOT' && row.userRoleNow === 'ROOT';

    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      userId: hide ? HIDDEN_ID : (row.userId as UserId),
      user: hide
        ? {
            ...hiddenAccount(row.userName, row.userDeleted ? null : row.userEmail),
            deleted: row.userDeleted,
          }
        : {
            id: row.userId as UserId,
            name: row.userName,
            // a deleted account keeps its lines, not its address
            email: row.userDeleted ? null : row.userEmail,
            role: row.userRoleNow,
            deleted: row.userDeleted,
          },
      documentId: row.documentId,
      document: { kind: row.kind, version: row.version, title: row.title },
      orderId: row.orderId,
      ip: hide ? hiddenText(row.ip) : row.ip,
      userAgent: hide ? hiddenText(row.userAgent) : row.userAgent,
      event: row.event,
    } as ConsentItem;
  },
  csv: {
    id: [{ header: 'id', kind: 'number', value: (row) => row.id as number }],
    createdAt: [{ header: 'createdAt', kind: 'text', value: (row) => row.createdAt as string }],
    userId: [{ header: 'userId', kind: 'number', value: (row) => row.userId as number | null }],
    user: [
      {
        header: 'userEmail',
        kind: 'text',
        value: (row) => (row.user as { email: string | null }).email,
      },
    ],
    documentId: [
      { header: 'documentId', kind: 'number', value: (row) => row.documentId as number },
    ],
    document: [
      {
        header: 'documentKind',
        kind: 'text',
        value: (row) => (row.document as { kind: string }).kind,
      },
      {
        header: 'documentVersion',
        kind: 'number',
        value: (row) => (row.document as { version: number }).version,
      },
    ],
    orderId: [{ header: 'orderId', kind: 'number', value: (row) => row.orderId as number | null }],
    ip: [{ header: 'ip', kind: 'text', value: (row) => row.ip as string | null }],
    userAgent: [
      { header: 'userAgent', kind: 'text', value: (row) => row.userAgent as string | null },
    ],
    event: [{ header: 'event', kind: 'text', value: (row) => row.event as string }],
  },
};

export function consentLogArgsOf(
  query: AdminConsentLogQueryDto,
  actor: { id: UserId; role: Role },
): ConsentLogArgs {
  return {
    ...journalArgsOf(CONSENT_DEF, query as JournalQuery, actor),
    userId: query.userId,
    documentId: query.documentId,
    orderId: query.orderId,
    kind: query.kind,
  };
}

function filtersOf(args: ConsentLogArgs): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (args.userId !== undefined) parts.push(Prisma.sql`l."userId" = ${args.userId}`);
  if (args.documentId !== undefined) parts.push(Prisma.sql`l."documentId" = ${args.documentId}`);
  if (args.orderId !== undefined) parts.push(Prisma.sql`l."orderId" = ${args.orderId}`);
  if (args.kind !== undefined)
    parts.push(Prisma.sql`d.kind = ${args.kind}::cartlify."LegalDocumentKind"`);

  return parts;
}

export const listConsentLog = (args: ConsentLogArgs) =>
  listJournal(CONSENT_DEF, args, filtersOf(args)) as Promise<GetAdminConsentLogResponseDto>;

export const consentLogCsv = (args: ConsentLogArgs) =>
  journalCsv(CONSENT_DEF, args, filtersOf(args));
