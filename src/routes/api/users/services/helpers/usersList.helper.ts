import { Prisma } from '@prisma/client';

import { assertLimit } from '@helpers/assertLimit.js';
import { cursorDate, decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { BadRequestError } from '@utils/errors.js';

import type { FindUsersDto, UsersListSortBy, UsersListSortOrder } from 'types/dto/users.dto.js';

// the admin table of users: GET /api/users. The rows of the filters, ordered by the sign-up time
// or the last login; equal values go by id, accounts that never logged in come last in either order

export const USERS_LIST_DEFAULT_LIMIT = 20;
export const USERS_LIST_ROLES = ['USER', 'ADMIN', 'ROOT'] as const;
export const USERS_LIST_PROVIDERS = ['LOCAL', 'GOOGLE', 'GITHUB', 'LINKEDIN'] as const;
export const USERS_LIST_SORT_FIELDS = ['createdAt', 'lastLoginAt'] as const;
export const USERS_LIST_SORT_ORDERS = ['desc', 'asc'] as const;

// the place after the last row of a page; null is the value of an account that never logged in
type UsersListCursor = { id: number; v: Date | null };

export type UsersListQuery = {
  limit: number;
  email: string | null;
  roles: string[] | null;
  providers: string[] | null;
  isVerified: boolean | null;
  deleted: boolean;
  sortBy: UsersListSortBy;
  sortOrder: UsersListSortOrder;
  cursor: UsersListCursor | null;
};

export type UsersListRow = {
  id: number;
  email: string;
  name: string | null;
  role: 'USER' | 'ADMIN' | 'ROOT';
  authProvider: 'LOCAL' | 'GOOGLE' | 'GITHUB' | 'LINKEDIN';
  isVerified: boolean;
  locale: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  deletedAt: Date | null;
};

// a cursor holds the order it was given for: a page of another order would start at a wrong place
const orderKey = (sortBy: UsersListSortBy, sortOrder: UsersListSortOrder) =>
  `${sortBy}:${sortOrder}`;

const namesOf = (value: string | undefined) =>
  value ? [...new Set(value.split(',').map((name) => name.trim()))] : null;

function readCursor(
  cursor: string,
  sortBy: UsersListSortBy,
  sortOrder: UsersListSortOrder,
): UsersListCursor {
  const payload = decodeCursor(cursor) as ReturnType<typeof decodeCursor> & { s?: unknown };
  if (payload.s !== orderKey(sortBy, sortOrder)) throw new BadRequestError('CURSOR_INVALID');

  // only the last login has no value for some rows
  if (payload.v === null && sortBy === 'lastLoginAt') return { id: payload.id, v: null };
  return { id: payload.id, v: cursorDate(payload.v) };
}

export function normalizeUsersListQuery(dto: FindUsersDto): UsersListQuery {
  const sortBy = dto.sortBy ?? 'createdAt';
  const sortOrder = dto.sortOrder ?? 'desc';
  const email = dto.email?.trim();

  return {
    limit: assertLimit(dto.limit ?? USERS_LIST_DEFAULT_LIMIT),
    email: email ? email : null,
    roles: namesOf(dto.role),
    providers: namesOf(dto.authProvider),
    isVerified: dto.isVerified ?? null,
    deleted: dto.deleted === true,
    sortBy,
    sortOrder,
    cursor: dto.cursor ? readCursor(dto.cursor, sortBy, sortOrder) : null,
  };
}

// a part of a text for like: its _ and % are the characters themselves, not wildcards
export const likePattern = (part: string) => `%${part.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// the filters, the same for a page and for the total
function filtersOf(q: UsersListQuery): Prisma.Sql[] {
  const parts = [
    q.deleted ? Prisma.sql`u."deletedAt" IS NOT NULL` : Prisma.sql`u."deletedAt" IS NULL`,
  ];

  // emails are stored in lower case; the trigram index serves ilike
  if (q.email) parts.push(Prisma.sql`u.email ILIKE ${likePattern(q.email)} ESCAPE '\\'`);
  if (q.roles) parts.push(Prisma.sql`u.role::text = ANY(${q.roles}::text[])`);
  if (q.providers) parts.push(Prisma.sql`u."authProvider"::text = ANY(${q.providers}::text[])`);
  if (q.isVerified !== null) parts.push(Prisma.sql`u."isVerified" = ${q.isVerified}`);

  return parts;
}

// the rows after the cursor in the order of the list
function afterCursor(q: UsersListQuery): Prisma.Sql | null {
  if (!q.cursor) return null;

  const { id, v } = q.cursor;
  const op = Prisma.raw(q.sortOrder === 'asc' ? '>' : '<');

  if (q.sortBy === 'createdAt') {
    return Prisma.sql`(u."createdAt" ${op} ${v} OR (u."createdAt" = ${v} AND u.id ${op} ${id}))`;
  }

  // the accounts that never logged in come after every login, in the order of their ids
  if (v === null) return Prisma.sql`(l."lastLoginAt" IS NULL AND u.id ${op} ${id})`;

  return Prisma.sql`(
    l."lastLoginAt" ${op} ${v}
    OR (l."lastLoginAt" = ${v} AND u.id ${op} ${id})
    OR l."lastLoginAt" IS NULL
  )`;
}

function orderOf(q: UsersListQuery): Prisma.Sql {
  const dir = Prisma.raw(q.sortOrder === 'asc' ? 'ASC' : 'DESC');

  return q.sortBy === 'createdAt'
    ? Prisma.sql`u."createdAt" ${dir}, u.id ${dir}`
    : Prisma.sql`l."lastLoginAt" ${dir} NULLS LAST, u.id ${dir}`;
}

// one page and one row more, which tells there is a next page
export function buildUsersPageQuery(q: UsersListQuery): Prisma.Sql {
  const cursor = afterCursor(q);
  const where = Prisma.join(cursor ? [...filtersOf(q), cursor] : filtersOf(q), ' AND ');

  return Prisma.sql`
    SELECT
      u.id,
      u.email,
      u.name,
      u.role::text AS role,
      u."authProvider"::text AS "authProvider",
      u."isVerified",
      u.locale,
      u."avatarUrl",
      u."createdAt",
      u."updatedAt",
      l."lastLoginAt",
      u."deletedAt"
    FROM cartlify.users u
    LEFT JOIN LATERAL (
      SELECT max(ll."createdAt") AS "lastLoginAt"
      FROM cartlify.login_logs ll
      WHERE ll."userId" = u.id
    ) l ON true
    WHERE ${where}
    ORDER BY ${orderOf(q)}
    LIMIT ${q.limit + 1}
  `;
}

export function buildUsersCountQuery(q: UsersListQuery): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS total
    FROM cartlify.users u
    WHERE ${Prisma.join(filtersOf(q), ' AND ')}
  `;
}

export function usersListNextCursor(q: UsersListQuery, last: UsersListRow): string {
  const value = q.sortBy === 'createdAt' ? last.createdAt : last.lastLoginAt;
  const payload = {
    id: last.id,
    v: value ? value.toISOString() : null,
    s: orderKey(q.sortBy, q.sortOrder),
  };

  return encodeCursor(payload);
}
