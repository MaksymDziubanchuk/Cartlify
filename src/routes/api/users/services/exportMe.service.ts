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
  legalAcceptances: Record<string, unknown>[];
};

// everything the shop keeps of the person, read with the rights of the person (rls shows them
// their own rows only): the profile, the orders with what they held and where they went, the
// favorites, the reviews and votes, the chats with their messages, the logins, the open sessions
// and the consents to the terms and the contract. What is no data of the person stays out: the hash
// of the password, the id of the provider account, the ids of payments and of files, and what a send
// cost the shop
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

      const orderRows = await tx.order.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          status: true,
          total: true,
          createdAt: true,
          paidAt: true,
          cancelledAt: true,
          delivery: {
            select: {
              method: true,
              recipientFirstName: true,
              recipientLastName: true,
              recipientPhone: true,
              country: true,
              postalCode: true,
              city: true,
              street: true,
              house: true,
              apartment: true,
              note: true,
              price: true,
            },
          },
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

      // what the buyer is told of a send; what it cost the shop is no data of the person. A query
      // reads at most two relations side by side, so the sends are read apart
      const sends = await tx.orderShipment.findMany({
        where: { orderId: { in: orderRows.map((order) => order.id) } },
        orderBy: { id: 'asc' },
        select: {
          orderId: true,
          carrier: true,
          trackingNumber: true,
          trackingUrl: true,
          shippedAt: true,
          rolledBackAt: true,
        },
      });
      const orders = orderRows.map((order) => ({
        ...order,
        shipments: sends
          .filter((send) => send.orderId === order.id)
          .map(({ orderId: _orderId, ...send }) => send),
      }));

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
        select: { createdAt: true, ipAddress: true, userAgent: true, event: true },
      });

      const sessions = await tx.userToken.findMany({
        where: { userId, type: 'REFRESH_TOKEN', usedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { id: 'desc' },
        select: { userAgent: true, createdAt: true, expiresAt: true },
      });

      const legalAcceptances = await tx.legalAcceptance.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
        select: {
          documentId: true,
          orderId: true,
          ip: true,
          userAgent: true,
          event: true,
          createdAt: true,
          document: { select: { kind: true, version: true, title: true } },
        },
      });

      return {
        exportedAt: new Date(),
        profile,
        orders: orders.map(({ total, items, delivery, ...order }) => ({
          ...order,
          total: total.toString(),
          delivery: delivery && { ...delivery, price: delivery.price.toString() },
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
        legalAcceptances: legalAcceptances.map(({ document, ...consent }) => ({
          documentId: consent.documentId,
          kind: document.kind,
          version: document.version,
          title: document.title,
          orderId: consent.orderId,
          ip: consent.ip,
          userAgent: consent.userAgent,
          event: consent.event,
          createdAt: consent.createdAt,
        })),
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'USERS_EXPORT_ME_UNEXPECTED' }, err);
  }
}
