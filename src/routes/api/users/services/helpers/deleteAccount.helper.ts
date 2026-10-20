import { Prisma } from '@prisma/client';

import { getPgMessage, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { requireSiteDomain } from '@helpers/siteDomain.js';
import { isRedisReady } from '@redis/client.js';
import { ConflictError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';
import { deleteImage, isOwnFile } from '@utils/cloudinary.util.js';
import {
  cancelOrderReservationExpiry,
  deleteOrderPaymentPageLink,
  getOrderPaymentPageLink,
} from '@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js';
import { getPaymentProvider } from '@routes/api/payments/providers/index.js';
import type {
  AccountDeletedCancelled,
  AccountDeletedDelivery,
  AccountDeletedItem,
  CancelledOrderPayment,
} from '@services/email/templates/users/accountDeleted.template.js';

import {
  sendAccountDeletedEmail,
  type AccountDeletionLogger,
} from './accountDeletedEmail.helper.js';

export type { AccountDeletionLogger };

// the name a deleted account keeps, the one reviews and chats show for it
export const DELETED_USER_NAME = 'Guest';

export type DeleteAccountArgs = {
  userId: number;
  // the id of the root context the transaction runs in: the root who deletes, or the user
  // deleting their own account (the server then acts as the system for them)
  systemActorId: number;
  // false refuses with ACCOUNT_HAS_OPEN_ORDERS while the account has an order waiting for payment,
  // paid or shipped; a root deletes without asking
  confirmOpenOrders: boolean;
  log: AccountDeletionLogger;
};

type OpenOrder = {
  id: number;
  status: 'waiting' | 'paid' | 'shipped';
  total: Prisma.Decimal;
  items: { quantity: number; product: { name: string } }[];
};

type ErasedAccount = {
  email: string;
  name: string | null;
  publicId: string | null;
  open: OpenOrder[];
};

const itemsOf = (order: OpenOrder): AccountDeletedItem[] =>
  order.items.map((item) => ({ name: item.product.name, quantity: item.quantity }));

// the address a deleted account gets: on the domain of the site, so a mail that still goes to it
// never leaves for a domain of someone else; the old address stays readable in it, cut and
// made safe for the email format
function deletedEmailOf(userId: number, email: string, domain: string): string {
  const previous = email
    .toLowerCase()
    .replace(/@/g, '_at_')
    .replace(/[^a-z0-9_]+/g, '_')
    .slice(0, 32);

  return `deleted+${userId}+${previous}@${domain}`;
}

// everything in the database in one transaction. A waiting order goes back to the cart through
// the system function, then the carts are deleted; paid and shipped orders, favorites, reviews,
// chat messages and login logs stay. The row stays too (orders keep pointing at it), emptied of
// everything personal; the role stays, so a deleted admin is still seen as one
async function eraseAccount(
  { userId, systemActorId, confirmOpenOrders }: DeleteAccountArgs,
  domain: string,
): Promise<ErasedAccount> {
  return tx(
    async (db) => {
      // root context: it reads and locks the row of any user, and only root may change an email
      await setUserContext(db, { userId: systemActorId, role: 'ROOT' });
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      const users = await db.$queryRaw<
        { id: number; email: string; name: string | null; publicId: string | null }[]
      >`
        select id, email, name, "publicId" as "publicId"
        from cartlify.users
        where id = ${userId}::int
        for update
      `;
      const user = users[0];
      if (!user) throw new NotFoundError('USER_NOT_FOUND');

      // the orders the person has to know about before the account goes
      const open = (await db.order.findMany({
        where: {
          userId,
          OR: [{ status: 'waiting', confirmed: true }, { status: { in: ['paid', 'shipped'] } }],
        },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          status: true,
          total: true,
          items: {
            orderBy: { id: 'asc' },
            select: { quantity: true, product: { select: { name: true } } },
          },
        },
      })) as OpenOrder[];

      if (open.length && !confirmOpenOrders) {
        throw new ConflictError('ACCOUNT_HAS_OPEN_ORDERS', {
          orders: open.map((order) => ({
            orderId: order.id,
            status: order.status,
            total: order.total.toString(),
          })),
        });
      }

      // a waiting order gives its reserved stock back and returns to the cart; the system function
      // takes the admin role, root is one. A payment that got in first stops it, see below
      for (const order of open) {
        if (order.status === 'waiting') {
          await db.$executeRaw`select cartlify.unconfirm_order(${order.id}::int)`;
        }
      }

      // the carts and the orders just sent back to the cart go with their items:
      // only the owner deletes an order that is not confirmed
      await setUserContext(db, { userId, role: 'USER' });
      await db.order.deleteMany({ where: { userId, confirmed: false } });

      await setUserContext(db, { userId: systemActorId, role: 'ROOT' });

      // open chats leave the admin queue, the messages stay
      await db.chatThread.updateMany({
        where: { userId, status: 'open' },
        data: { status: 'closed', unreadCount: 0, adminRequestedAt: null, adminUnreadSince: null },
      });

      // every session ends
      await db.userToken.deleteMany({ where: { userId } });

      // empty the row of everything personal; the name Guest is what reviews and chats show
      // for the account, deletedAt is what marks it deleted
      await db.user.update({
        where: { id: userId },
        data: {
          email: deletedEmailOf(userId, user.email, domain),
          passwordHash: null,
          authProvider: 'LOCAL',
          providerSub: null,
          isVerified: false,
          deletedAt: new Date(),
          name: DELETED_USER_NAME,
          avatarUrl: null,
          publicId: null,
          locale: null,
          phone: null,
        },
        select: { id: true },
      });

      return { email: user.email, name: user.name, publicId: user.publicId, open };
    },
    {
      maxRetries: 3,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1500,
    },
  );
}

// the payment page of a cancelled order is closed by the provider that opened it, and its answer
// tells what happened to the money. Nothing here can undo the deletion: a failure is logged and
// the payment is unknown
export async function closeCheckoutOf(
  orderId: number,
  log: AccountDeletionLogger,
): Promise<CancelledOrderPayment> {
  // the link from the order to its payment page lives in redis
  if (!isRedisReady()) return 'unknown';

  try {
    // the reservation timer has nothing to release any more
    await cancelOrderReservationExpiry(orderId);

    // no page was opened for the order, or redis lost the link: nothing can be said for sure
    const page = await getOrderPaymentPageLink(orderId);
    if (!page) return 'unknown';

    const closed = await getPaymentProvider(page.provider).closePaymentPage(page.pageId);

    if (closed.state === 'closed') {
      await deleteOrderPaymentPageLink(orderId);
      return 'not_taken';
    }

    // a page that is already paid cannot be closed: the order is gone, so the payment event refunds it
    if (closed.state === 'paid') return 'refunding';

    // a payment still on its way, or a page the provider did not close
    log.warn(
      {
        err: closed.state === 'open' ? closed.cause : undefined,
        orderId,
        provider: page.provider,
        state: closed.state,
      },
      'payment page of a cancelled order was not closed',
    );
    return 'unknown';
  } catch (err) {
    log.error({ err, orderId }, 'payment page of a cancelled order was not closed');
    return 'unknown';
  }
}

// deletes an account for the root and for the user alike: the database first, in one transaction,
// then what lives outside it - the payment pages of the cancelled orders, the avatar file and the
// mail to the person. Those steps never undo the deletion, a failure is only logged
export async function deleteAccount(args: DeleteAccountArgs): Promise<void> {
  // the domain of the new address, checked before anything is changed
  const domain = requireSiteDomain();

  let erased: ErasedAccount;
  try {
    erased = await eraseAccount(args, domain);
  } catch (err) {
    // a payment or the reservation timer changed a waiting order meanwhile:
    // nothing was changed, a new try sees the order as it is now
    const message = getPgMessage(err) ?? '';
    if (message.includes('ORDER_STATUS_NOT_WAITING') || message.includes('ORDER_NOT_CONFIRMED')) {
      throw new ConflictError('ACCOUNT_ORDERS_CHANGED', undefined, err);
    }
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'ACCOUNT_DELETE_UNEXPECTED' }, err);
  }

  const { log, userId } = args;

  const cancelled: AccountDeletedCancelled[] = [];
  for (const order of erased.open) {
    if (order.status !== 'waiting') continue;

    cancelled.push({
      orderId: order.id,
      total: order.total.toString(),
      items: itemsOf(order),
      payment: await closeCheckoutOf(order.id, log),
    });
  }

  const deliveries: AccountDeletedDelivery[] = erased.open
    .filter(
      (order): order is OpenOrder & { status: 'paid' | 'shipped' } => order.status !== 'waiting',
    )
    .map((order) => ({
      orderId: order.id,
      status: order.status,
      total: order.total.toString(),
      items: itemsOf(order),
    }));

  // only a file of this environment: a restored copy of prod points to the avatars of prod
  if (isOwnFile(erased.publicId)) {
    try {
      await deleteImage(erased.publicId);
    } catch (err) {
      log.error({ err, userId }, 'avatar of a deleted account was not removed');
    }
  }

  await sendAccountDeletedEmail(
    { userId, to: erased.email, userName: erased.name, deliveries, cancelled },
    log,
  );
}
