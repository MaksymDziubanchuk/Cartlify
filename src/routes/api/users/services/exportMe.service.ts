import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { InternalError, isAppError, NotFoundError } from '@utils/errors.js';

import type { Role } from 'types/user.js';

export type ExportMeDto = { userId: number; role: Role };

export type ExportMeResponseDto = {
  exportedAt: Date;
  profile: Record<string, unknown>;
  orders: Record<string, unknown>[];
  favorites: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  reviewVotes: Record<string, unknown>[];
  chats: Record<string, unknown>[];
  logins: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
};

// everything the shop keeps of the person, read with the rights of the person (rls shows them
// their own rows only): the profile, the orders with what they held and where they went, the
// favorites, the reviews and votes, the chats with their messages, the logins and the open
// sessions. What is no data of the person stays out: the hash of the password, the id of the
// provider account, the ids of payments and of files
export async function exportMe({ userId, role }: ExportMeDto): Promise<ExportMeResponseDto> {
  try {
    return await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId, role });

      const profile = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          locale: true,
          phone: true,
          avatarUrl: true,
          role: true,
          authProvider: true,
          isVerified: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!profile) throw new NotFoundError('USER_NOT_FOUND');

      const orders = await tx.order.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          status: true,
          total: true,
          shippingAddress: true,
          recipientFirstName: true,
          recipientLastName: true,
          recipientPhone: true,
          note: true,
          createdAt: true,
          paidAt: true,
          cancelledAt: true,
          items: {
            orderBy: { id: 'asc' },
            select: {
              productId: true,
              quantity: true,
              unitPrice: true,
              totalPrice: true,
              productName: true,
              product: { select: { name: true } },
            },
          },
        },
      });

      const favorites = await tx.favorite.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
        select: { productId: true, createdAt: true, product: { select: { name: true } } },
      });

      const reviews = await tx.review.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          productId: true,
          rating: true,
          comment: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const reviewVotes = await tx.reviewVote.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
        select: { reviewId: true, action: true, createdAt: true },
      });

      const chats = await tx.chatThread.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true,
          messages: {
            orderBy: { id: 'asc' },
            select: { senderType: true, content: true, createdAt: true },
          },
        },
      });

      const logins = await tx.loginLog.findMany({
        where: { userId },
        orderBy: { id: 'desc' },
        select: { createdAt: true, ipAddress: true, userAgent: true },
      });

      const sessions = await tx.userToken.findMany({
        where: { userId, type: 'REFRESH_TOKEN', usedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { id: 'desc' },
        select: { userAgent: true, createdAt: true, expiresAt: true },
      });

      return {
        exportedAt: new Date(),
        profile,
        orders: orders.map(({ total, items, ...order }) => ({
          ...order,
          total: total.toString(),
          items: items.map(({ product, productName, unitPrice, totalPrice, ...item }) => ({
            ...item,
            // the name the item was confirmed with, the one of now for a cart
            name: (order.status !== 'pending' && order.status !== 'unconfirmed' && productName) || product.name,
            unitPrice: unitPrice.toString(),
            totalPrice: totalPrice.toString(),
          })),
        })),
        favorites: favorites.map(({ product, ...favorite }) => ({
          ...favorite,
          name: product.name,
        })),
        reviews,
        reviewVotes,
        chats,
        logins,
        sessions: sessions.map((session) => ({
          device: session.userAgent,
          lastUsedAt: session.createdAt,
          expiresAt: session.expiresAt,
        })),
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'USERS_EXPORT_ME_UNEXPECTED' }, err);
  }
}
