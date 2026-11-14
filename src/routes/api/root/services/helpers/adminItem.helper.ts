import type { Prisma } from '@prisma/client';

import { canManageMoneyOf } from '@helpers/moneyManager.js';
import { canManageNewslettersOf } from '@helpers/newsletterManager.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { avatarOf } from '@utils/avatar.util.js';

import type { AdminItemDto } from 'types/dto/root.dto.js';

// the columns of an admin as root reads one: in the list of admins and in the answer to a change
export const adminItemSelect = {
  id: true,
  email: true,
  role: true,
  isVerified: true,
  createdAt: true,
  updatedAt: true,
  name: true,
  avatarUrl: true,
  locale: true,
  phone: true,
  canManageNewsletters: true,
  canManageMoney: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

export type AdminRow = Prisma.UserGetPayload<{ select: typeof adminItemSelect }>;

// an admin of the list of root. A deleted admin keeps the role: the page tells it from a working
// one by deletedAt. The right to run the newsletters is the one that works (canManageNewslettersOf):
// a deleted admin has none, whatever the column kept
export function adminItemOf(u: AdminRow): AdminItemDto {
  assertEmail(u.email);

  return {
    id: u.id as any,
    email: u.email,
    role: u.role,
    isVerified: u.isVerified,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    ...(u.name ? { name: u.name } : {}),
    ...avatarOf({ ...u, deleted: u.deletedAt !== null }),
    canManageNewsletters: canManageNewslettersOf(u),
    canManageMoney: canManageMoneyOf(u),
    ...(u.locale ? { locale: u.locale } : {}),
    ...(u.phone ? { phone: u.phone } : {}),
    deletedAt: u.deletedAt,
  };
}
