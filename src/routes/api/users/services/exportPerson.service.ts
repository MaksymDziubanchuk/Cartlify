import { prisma } from '@db/client.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { setUserContext } from '@db/dbContext.service.js';
import { variantNamesOf } from '@db/variantNames.helper.js';
import { returnCodeOf } from '@helpers/returns.js';
import {
  newsletterSubscriptionsOf,
  type ExportedNewsletterSubscription,
} from './helpers/exportNewsletter.helper.js';
import { itemNameOf } from '@routes/api/orders/services/helpers/itemName.helper.js';
import {
  readReturnMoneyLines,
  rowSharesOf,
  sentAtOf,
} from '@routes/api/returns/services/helpers/returnMoneyLines.helper.js';
import { InternalError, isAppError, NotFoundError } from '@utils/errors.js';

import type { Role } from 'types/user.js';

// the person whose data it is, and who asks: the person themselves, or root on a request that came
// by other means (the person is checked outside the app)
export type ExportPersonDto = {
  subjectId: number;
  actorId: number;
  actorRole: Role;
  // the request came by the route of root: the journal of the admins names it
  audit: boolean;
};

export type ExportPersonResponseDto = {
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
  // the subscriptions to the newsletter the address of the account has had, with their journal
  newsletterSubscriptions: ExportedNewsletterSubscription[];
  // every movement of the money of the person, the oldest first (the money journal)
  money: Record<string, unknown>[];
};

// everything the shop keeps of the person, read with the rights of whoever asks (rls shows a person
// their own rows only, root all): the profile, the orders with what they held, where they went and
// the statements of return made on them, the favorites, the reviews and votes, the chats with their
// messages, the logins, the open sessions, the consents to the terms and the contract, the
// subscriptions to the newsletter on the address of the account with their journal (the fields
// are agreed by name, see exportNewsletter.helper.ts), and every movement of the money of the
// person (the money journal: what it was, its part, the sum, the currency, the time, the state and
// the number the bank gives to follow a refund). The money of a statement comes from its lines of
// the money journal: the share of the delivery and the deduction for the way back a row carries,
// when its money went back, the way root sent it outside the app (the way back given back is a line
// of the money journal of the person, part way_back).
// What is no data of the person stays out: the hash of the password, the id of the provider
// account, the ids of payments and of files, what a send or a parcel back cost the shop, and of a
// statement of return what became of the goods, the ids of the provider, the keys of the requests,
// the meta of the money journal and who of the admins did what, and the notes root wrote (they may
// name others) but the one of money sent outside the app. What the cleanups of the retention terms
// have emptied is not given. A request by the route of root leaves a line in the journal of the
// admins
// the parcel the goods of a statement went back to the shop in, as the export gives it: when it was
// told, the carrier, the number and the link, and what the person paid the carrier; all empty while
// no parcel was told
function proofOf(
  parcel:
    | {
        shippedAt: Date;
        carrier: string | null;
        trackingNumber: string | null;
        trackingUrl: string | null;
        buyerPaid: { toString(): string } | null;
      }
    | undefined,
) {
  return {
    providedAt: parcel?.shippedAt ?? null,
    carrier: parcel?.carrier ?? null,
    trackingNumber: parcel?.trackingNumber ?? null,
    trackingUrl: parcel?.trackingUrl ?? null,
    buyerPaid: parcel?.buyerPaid ? parcel.buyerPaid.toString() : null,
  };
}

export async function exportPerson({
  subjectId: userId,
  actorId,
  actorRole,
  audit,
}: ExportPersonDto): Promise<ExportPersonResponseDto> {
  try {
    return await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const row = await tx.user.findUnique({
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
          deletedAt: true,
        },
      });
      if (!row) throw new NotFoundError('USER_NOT_FOUND');
      // the mark of the deletion decides what the newsletter has to say; it is no field of the profile
      const { deletedAt, ...profile } = row;

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
              variantId: true,
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
        where: { orderId: { in: orderRows.map((order) => order.id) }, returnId: null },
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

      // the statements of return of these orders and their rows: what is the person's own (their
      // words, their data, their money, the parcel they sent)
      const statements = await tx.orderReturn.findMany({
        where: { orderId: { in: orderRows.map((order) => order.id) } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          orderId: true,
          number: true,
          extendsId: true,
          statedAt: true,
          source: true,
          basis: true,
          reason: true,
          description: true,
          contactName: true,
          contactEmail: true,
          ip: true,
          userAgent: true,
          closeCode: true,
          closedAt: true,
        },
      });
      // the parcels the goods of the statements went back to the shop in
      const statementParcels = await tx.orderShipment.findMany({
        where: {
          returnId: { in: statements.map((statement) => statement.id) },
          direction: 'to_shop',
        },
        select: {
          returnId: true,
          shippedAt: true,
          carrier: true,
          trackingNumber: true,
          trackingUrl: true,
          buyerPaid: true,
        },
      });
      const statementRows = await tx.orderReturnItem.findMany({
        where: { returnId: { in: statements.map((statement) => statement.id) } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          returnId: true,
          quantity: true,
          goods: true,
          money: true,
          amount: true,
          moneyLogId: true,
          refusedCode: true,
          notAcceptedReason: true,
          orderItem: {
            select: {
              productId: true,
              variantId: true,
              productName: true,
              product: { select: { name: true } },
            },
          },
        },
      });

      // what the money of the statements did: their lines of the money journal, oldest first
      const statementMoney = await readReturnMoneyLines(
        tx,
        statements.map((statement) => statement.id),
      );

      // a form without a code can come from anybody who knows the number and the name of the
      // recipient: what its sender wrote (the contact, the address, the browser, the words) is the
      // person's only when the shop took it for theirs (money went back for it) or its email is the
      // one of the account, and never when root closed it as not of the buyer
      const accountEmail = profile.email.toLowerCase();
      const own = new Set(
        statements
          .filter(
            (statement) =>
              statement.source !== 'form_manual' ||
              (statement.closeCode !== 'not_buyer' &&
                (statement.contactEmail.toLowerCase() === accountEmail ||
                  statementRows.some(
                    (row) => row.returnId === statement.id && row.money === 'refunded',
                  ))),
          )
          .map((statement) => statement.id),
      );

      const orders = orderRows.map((order) => ({
        ...order,
        shipments: sends
          .filter((send) => send.orderId === order.id)
          .map(({ orderId: _orderId, ...send }) => send),
        returns: statements
          .filter((statement) => statement.orderId === order.id)
          .map(
            ({
              orderId: _orderId,
              number,
              contactName,
              contactEmail,
              ip,
              userAgent,
              description,
              closeCode: _closeCode,
              ...statement
            }) => {
              const lines = statementMoney.get(statement.id) ?? [];
              const shares = rowSharesOf(lines);
              const lineOf = (id: number | null) => lines.find((line) => line.id === id) ?? null;

              return {
                ...statement,
                code: returnCodeOf(statement.basis, order.id, number),
                // the words of an admin on a statement of the shop are a note of the shop; the address
                // and the browser of it are of the admin
                description:
                  own.has(statement.id) && statement.source !== 'admin' ? description : null,
                contact: own.has(statement.id) ? { name: contactName, email: contactEmail } : null,
                ip: own.has(statement.id) && statement.source !== 'admin' ? ip : null,
                userAgent: own.has(statement.id) && statement.source !== 'admin' ? userAgent : null,
                // the parcel the goods went back in: the carrier, the number and the link, and
                // what the person paid the carrier
                proof: proofOf(statementParcels.find((parcel) => parcel.returnId === statement.id)),
                items: statementRows
                  .filter((row) => row.returnId === statement.id)
                  .map((row) => {
                    // the line that put the money of the row where it stands
                    const line = lineOf(row.moneyLogId);
                    const share = shares.get(row.id);

                    return {
                      productId: row.orderItem.productId,
                      variantId: row.orderItem.variantId,
                      name: itemNameOf(row.orderItem),
                      quantity: row.quantity,
                      money: row.money,
                      amount: row.amount.toString(),
                      // the delivery that went back with the row, and the cost of the way back taken
                      // off its money
                      deliveryShare: String(share?.delivery ?? 0),
                      shippingDeduction: String(share?.deduction ?? 0),
                      refundedAt: row.money === 'refunded' ? sentAtOf(line) : null,
                      // why the money was refused, as the order of the buyer says it: the goods not
                      // accepted, or not arrived (with the code root closed the row with)
                      refusal:
                        row.money !== 'refused'
                          ? null
                          : row.goods === 'not_accepted'
                            ? row.notAcceptedReason
                            : (row.refusedCode ?? 'not_arrived'),
                      outside:
                        row.money === 'refunded' && line?.event === 'money.outside' && line.method
                          ? { method: line.method, note: line.note }
                          : null,
                    };
                  }),
              };
            },
          ),
      }));

      const favorites = await tx.favorite.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
        select: {
          productId: true,
          variantId: true,
          createdAt: true,
          product: { select: { name: true } },
        },
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

      // every movement of the money of the person: what a send or a parcel back cost the shop is
      // not theirs; the keys, the ids of the provider, the meta, the notes and the actors stay out
      const money = await tx.moneyLog.findMany({
        where: { userId, purpose: { not: 'shipping' } },
        orderBy: { id: 'asc' },
        select: {
          orderId: true,
          event: true,
          part: true,
          amount: true,
          currency: true,
          createdAt: true,
          state: true,
          bankReference: true,
        },
      });

      // the subscriptions on the address of the account, read last of the person's tables
      const newsletterSubscriptions = await newsletterSubscriptionsOf(tx, {
        subjectId: userId,
        actorId,
        actorRole,
        isVerified: profile.isVerified,
        isDeleted: deletedAt !== null,
      });

      // a person's data given on the request of root: the journal of the admins names it
      if (audit) {
        await writeAdminAuditLog(tx, {
          actorId,
          actorRole,
          entityType: 'user',
          entityId: userId,
          action: 'OTHER',
          event: 'user.export',
          changes: [{ field: 'event', old: null, new: 'export' }],
        });
      }

      // the names the variants have now: a cart and the favorites show them
      const liveNames = await variantNamesOf(tx, [
        ...orders
          .filter((order) => order.status === 'pending' || order.status === 'unconfirmed')
          .flatMap((order) => order.items.map((item) => item.variantId)),
        ...favorites.map((favorite) => favorite.variantId),
      ]);

      return {
        exportedAt: new Date(),
        profile,
        orders: orders.map(({ total, items, delivery, ...order }) => ({
          ...order,
          total: total.toString(),
          delivery: delivery && { ...delivery, price: delivery.price.toString() },
          // a position is a variant of a product: both ids, the name of the variant and the prices
          // the confirmation kept (the name and the price of now for a cart)
          items: items.map(({ product, productName, unitPrice, totalPrice, ...item }) => ({
            ...item,
            name:
              order.status === 'pending' || order.status === 'unconfirmed'
                ? (liveNames.get(item.variantId)?.name ?? product.name)
                : itemNameOf({ productName, variantId: item.variantId, product }),
            unitPrice: unitPrice.toString(),
            totalPrice: totalPrice.toString(),
          })),
        })),
        // a favorite is a variant of a product: both ids and the name of the variant
        favorites: favorites.map(({ product, ...favorite }) => ({
          ...favorite,
          name: liveNames.get(favorite.variantId)?.name ?? product.name,
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
        newsletterSubscriptions,
        money: money.map(({ amount, createdAt, ...line }) => ({
          ...line,
          amount: amount.toString(),
          createdAt: createdAt.toISOString(),
        })),
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'USERS_EXPORT_UNEXPECTED' }, err);
  }
}
