import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import { avatarOf } from '@utils/avatar.util.js';
import { InternalError, isAppError } from '@utils/errors.js';

import type { Email } from 'types/common.js';
import type { UserId } from 'types/ids.js';
import type { FindUsersDto, UsersListItemDto, UsersListResponseDto } from 'types/dto/users.dto.js';

import {
  buildUsersCountQuery,
  buildUsersPageQuery,
  normalizeUsersListQuery,
  usersListNextCursor,
  type UsersListRow,
} from './helpers/usersList.helper.js';

const toItem = (row: UsersListRow): UsersListItemDto => ({
  id: row.id as UserId,
  email: row.email as Email,
  name: row.name,
  role: row.role,
  authProvider: row.authProvider,
  isVerified: row.isVerified,
  locale: row.locale,
  ...avatarOf({ ...row, deleted: row.deletedAt !== null }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  lastLoginAt: row.lastLoginAt,
  deletedAt: row.deletedAt,
});

// the admin table of users: rls lets an admin or root read every account and its login log
export async function findUsers(dto: FindUsersDto): Promise<UsersListResponseDto> {
  const q = normalizeUsersListQuery(dto);

  try {
    return await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: dto.actorId, role: dto.actorRole });

      const rows = await tx.$queryRaw<UsersListRow[]>(buildUsersPageQuery(q));
      const [count] = await tx.$queryRaw<{ total: number }[]>(buildUsersCountQuery(q));

      const hasNext = rows.length > q.limit;
      const page = hasNext ? rows.slice(0, q.limit) : rows;
      const last = page.at(-1);

      return {
        items: page.map(toItem),
        limit: q.limit,
        nextCursor: hasNext && last ? usersListNextCursor(q, last) : null,
        total: count?.total ?? 0,
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'USERS_LIST_UNEXPECTED' }, err);
  }
}
