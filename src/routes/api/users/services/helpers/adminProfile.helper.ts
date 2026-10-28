import type { Prisma } from '@prisma/client';

import { BadRequestError } from '@utils/errors.js';
import type { AdminProfileListsDto } from 'types/dto/users.dto.js';

// what an admin asks for on the profile of a user (GET /api/users/:userId): the lists the
// checkboxes of the page give in include, and the period the lists cover

export const PROFILE_LISTS = [
  'orders',
  'reviews',
  'favorites',
  'votes',
  'loginLogs',
  'consents',
] as const;

export type ProfileList = (typeof PROFILE_LISTS)[number];

// the period when the admin gives no date, and the longest one: a longer one would put
// thousands of records into one answer
export const PROFILE_PERIOD_DEFAULT_DAYS = 30;
export const PROFILE_PERIOD_MAX_DAYS = 60;

const DAY_MS = 86_400_000;

const isProfileList = (name: string): name is ProfileList =>
  (PROFILE_LISTS as readonly string[]).includes(name);

// the checked lists once each, in the order they come; the schema of the route lets only the
// known names through, an unknown one is left out here as well
export function parseProfileLists(include: string | undefined): ProfileList[] {
  if (!include) return [];

  return [...new Set(include.split(','))].filter(isProfileList);
}

function toDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestError('PROFILE_PERIOD_INVALID');
  return date;
}

// to is now unless it comes, from is 30 days before to unless it comes; any dates, but at most
// 60 days between them
export function resolveProfilePeriod(
  query: { from?: string | undefined; to?: string | undefined },
  now: Date = new Date(),
): { from: Date; to: Date } {
  const to = query.to ? toDate(query.to) : now;
  const from = query.from
    ? toDate(query.from)
    : new Date(to.getTime() - PROFILE_PERIOD_DEFAULT_DAYS * DAY_MS);

  if (from.getTime() > to.getTime()) throw new BadRequestError('PROFILE_PERIOD_INVALID');

  if (to.getTime() - from.getTime() > PROFILE_PERIOD_MAX_DAYS * DAY_MS) {
    throw new BadRequestError('PROFILE_PERIOD_TOO_LONG', { maxDays: PROFILE_PERIOD_MAX_DAYS });
  }

  return { from, to };
}

// the records of the user the admin asked for, created in the period, newest first; read under
// the admin context, rls lets an admin read every one of them
export async function loadProfileLists(
  tx: Prisma.TransactionClient,
  userId: number,
  lists: ProfileList[],
  period: { from: Date; to: Date },
): Promise<Partial<AdminProfileListsDto>> {
  const createdAt = { gte: period.from, lte: period.to };
  const newestFirst = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
  const result: Partial<AdminProfileListsDto> = {};

  for (const list of lists) {
    switch (list) {
      case 'orders': {
        const orders = await tx.order.findMany({
          where: { userId, createdAt },
          orderBy: newestFirst,
          select: { id: true, status: true, total: true, createdAt: true, updatedAt: true },
        });
        result.orders = orders.map((order) => ({ ...order, total: order.total.toNumber() }));
        break;
      }
      case 'reviews':
        result.reviews = await tx.review.findMany({
          where: { userId, createdAt },
          orderBy: newestFirst,
          select: {
            id: true,
            productId: true,
            rating: true,
            comment: true,
            upVotes: true,
            downVotes: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        break;
      case 'favorites':
        result.favorites = await tx.favorite.findMany({
          where: { userId, createdAt },
          orderBy: newestFirst,
          select: { id: true, productId: true, createdAt: true },
        });
        break;
      case 'votes': {
        const votes = await tx.reviewVote.findMany({
          where: { userId, createdAt },
          orderBy: newestFirst,
          select: { id: true, reviewId: true, action: true, createdAt: true },
        });
        result.votes = votes.map((vote) => ({
          ...vote,
          action: vote.action === 'UP' ? ('up' as const) : ('down' as const),
        }));
        break;
      }
      case 'loginLogs':
        result.loginLogs = await tx.loginLog.findMany({
          where: { userId, createdAt },
          orderBy: newestFirst,
          select: { id: true, createdAt: true, ipAddress: true, userAgent: true, event: true },
        });
        break;
      // the versions of the terms and of the contract the user accepted (orderId null) and the
      // ones each order was confirmed with; the text of a version is GET /api/legal/documents/:id
      case 'consents': {
        const consents = await tx.legalAcceptance.findMany({
          where: { userId, createdAt },
          orderBy: newestFirst,
          select: {
            id: true,
            documentId: true,
            orderId: true,
            ip: true,
            userAgent: true,
            event: true,
            createdAt: true,
            document: { select: { kind: true, version: true, title: true } },
          },
        });
        result.consents = consents.map(({ document, ...consent }) => ({
          id: consent.id,
          documentId: consent.documentId,
          kind: document.kind,
          version: document.version,
          title: document.title,
          orderId: consent.orderId,
          ip: consent.ip,
          userAgent: consent.userAgent,
          event: consent.event,
          createdAt: consent.createdAt,
        }));
        break;
      }
    }
  }

  return result;
}
