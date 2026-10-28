import { Prisma } from '@prisma/client';

import { LOGIN_EVENTS } from '@config/journalEvents.js';
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
  AdminLoginLogItemDto,
  AdminLoginLogQueryDto,
  GetAdminLoginLogResponseDto,
} from 'types/dto/admin.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the log of logins for admin and root (GET /api/admin/login-log): who came in, how (a password or
// a provider), from which address and browser. A person reads their own logins in their sessions
// and in their export; this is the journal of the shop. An admin sees the same lines as root with
// the same filters, and not who root is: in the logins of root the account, the email, the address
// and the browser are hidden (the role stays)

export type LoginLogArgs = JournalArgs & {
  userId?: number | undefined;
  roles?: Role[] | undefined;
  // a part of the email of the login, whatever the case
  email?: string | undefined;
};

type LoginRow = {
  id: number;
  createdAt: Date;
  userId: number;
  email: string;
  role: Role;
  ipAddress: string | null;
  userAgent: string | null;
  event: string;
  userName: string | null;
  userRoleNow: Role;
  userDeleted: boolean;
};

const col = (column: string) => Prisma.raw(`l."${column}"`);

const LOGIN_SORTS = {
  id: { sql: Prisma.sql`l.id`, kind: 'number' },
  createdAt: { sql: col('createdAt'), kind: 'date' },
  userId: { sql: col('userId'), kind: 'number' },
  email: { sql: col('email'), kind: 'text' },
  role: { sql: Prisma.sql`l.role::text`, kind: 'text' },
  ipAddress: { sql: col('ipAddress'), kind: 'text' },
  userAgent: { sql: col('userAgent'), kind: 'text' },
  event: { sql: col('event'), kind: 'text' },
} as const;

type LoginItem = Partial<AdminLoginLogItemDto> & Record<string, unknown>;

const LOGIN_DEF: JournalDef<LoginRow, LoginItem> = {
  fileName: 'login-log',
  from: Prisma.sql`cartlify.login_logs AS l JOIN cartlify.users AS u ON u.id = l."userId"`,
  select: Prisma.sql`
    l.id, l."createdAt", l."userId", l.email, l.role::text AS role, l."ipAddress", l."userAgent",
    l.event, u.name AS "userName", u.role AS "userRoleNow", (u."deletedAt" IS NOT NULL) AS "userDeleted"`,
  createdAt: col('createdAt'),
  event: col('event'),
  columns: [
    'id',
    'createdAt',
    'userId',
    'user',
    'email',
    'role',
    'ipAddress',
    'userAgent',
    'event',
  ],
  sorts: LOGIN_SORTS,
  events: LOGIN_EVENTS,
  reason: 'ADMIN_LOGIN_LOG_UNEXPECTED',
  itemOf: (row, viewer) => {
    // root, whoever it is now: an admin sees the role and nothing else
    const hide = viewer !== 'ROOT' && (row.role === 'ROOT' || row.userRoleNow === 'ROOT');

    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      userId: hide ? HIDDEN_ID : (row.userId as UserId),
      user: hide
        ? { ...hiddenAccount(row.userName, row.email), deleted: row.userDeleted }
        : {
            id: row.userId as UserId,
            name: row.userName,
            // the email of a deleted account is the one it was given when it was deleted
            email: row.email,
            role: row.userRoleNow,
            deleted: row.userDeleted,
          },
      email: hide ? hiddenText(row.email) : row.email,
      role: row.role,
      ipAddress: hide ? hiddenText(row.ipAddress) : row.ipAddress,
      userAgent: hide ? hiddenText(row.userAgent) : row.userAgent,
      event: row.event,
    } as LoginItem;
  },
  csv: {
    id: [{ header: 'id', kind: 'number', value: (row) => row.id as number }],
    createdAt: [{ header: 'createdAt', kind: 'text', value: (row) => row.createdAt as string }],
    userId: [{ header: 'userId', kind: 'number', value: (row) => row.userId as number | null }],
    user: [
      {
        header: 'userName',
        kind: 'text',
        value: (row) => (row.user as { name: string | null }).name,
      },
      {
        header: 'userDeleted',
        kind: 'text',
        value: (row) => String((row.user as { deleted: boolean }).deleted),
      },
    ],
    email: [{ header: 'email', kind: 'text', value: (row) => row.email as string | null }],
    role: [{ header: 'role', kind: 'text', value: (row) => row.role as string }],
    ipAddress: [
      { header: 'ipAddress', kind: 'text', value: (row) => row.ipAddress as string | null },
    ],
    userAgent: [
      { header: 'userAgent', kind: 'text', value: (row) => row.userAgent as string | null },
    ],
    event: [{ header: 'event', kind: 'text', value: (row) => row.event as string }],
  },
};

export function loginLogArgsOf(
  query: AdminLoginLogQueryDto,
  actor: { id: UserId; role: Role },
): LoginLogArgs {
  return {
    ...journalArgsOf(LOGIN_DEF, query as JournalQuery, actor),
    userId: query.userId,
    roles: query.roles ? ([...new Set(query.roles.split(','))] as Role[]) : undefined,
    email: query.email?.trim() || undefined,
  };
}

// the text of a pattern is looked for as the text it is
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

function filtersOf(args: LoginLogArgs): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (args.userId !== undefined) parts.push(Prisma.sql`l."userId" = ${args.userId}`);
  if (args.roles) parts.push(Prisma.sql`l.role = ANY(${args.roles}::cartlify."Role"[])`);
  if (args.email !== undefined) parts.push(Prisma.sql`l.email ILIKE ${likePattern(args.email)}`);

  return parts;
}

export const listLoginLog = (args: LoginLogArgs) =>
  listJournal(LOGIN_DEF, args, filtersOf(args)) as Promise<GetAdminLoginLogResponseDto>;

export const loginLogCsv = (args: LoginLogArgs) => journalCsv(LOGIN_DEF, args, filtersOf(args));
