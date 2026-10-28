import env from '@config/env.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { deliveryMailParts } from '@helpers/deliveryText.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { buildOrderPaidTemplate } from '@services/email/templates/orders/orderPaid.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';

import { currencyOf } from '../../providers/index.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';

export type OrderMailLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// frontend page of an order (WEB_PAGE_ORDER)
const orderPage = (orderId: number) => webPageUrl(env.WEB_PAGE_ORDER, { id: orderId });

// the kinds of the documents a mail carries, in the order it names them
const DOCUMENT_KINDS = ['terms', 'contract'] as const;

// the order with what the mail shows; the payment event runs as the system, so admin context
function loadOrder(orderId: number) {
  return prisma.$transaction(async (tx) => {
    await setAdminContext(tx);

    // a query reads at most two relations side by side (the relations of one query run at once on
    // the one connection of a transaction), so the buyer is read apart, one after
    // the other
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        total: true,
        paymentProvider: true,
        delivery: {
          select: {
            method: true,
            price: true,
            recipientFirstName: true,
            recipientLastName: true,
            recipientPhone: true,
            country: true,
            postalCode: true,
            city: true,
            street: true,
            house: true,
            apartment: true,
          },
        },
        paidAt: true,
        items: {
          orderBy: { id: 'asc' },
          select: {
            quantity: true,
            unitPrice: true,
            totalPrice: true,
            productName: true,
            product: { select: { name: true } },
          },
        },
      },
    });
    if (!order) return null;

    const user = await tx.user.findUniqueOrThrow({
      where: { id: order.userId },
      select: { email: true, name: true },
    });

    // the versions of the terms and of the contract the order was confirmed with, latest first:
    // an order confirmed again keeps the ones of its last confirmation. A query of its own, one
    // statement of a transaction runs at a time
    const acceptances = await tx.legalAcceptance.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { document: { select: { kind: true, content: true } } },
    });

    return { ...order, user, acceptances };
  });
}

// mails the buyer that the order is paid, with the texts of the terms and of the contract the order
// was confirmed with as files: the copy of the contract the buyer keeps. The payment is recorded
// before this runs, so a mail that fails is only logged: the webhook still answers the provider
// with success, or it would deliver the event again. The log keeps the order id, not the address
// of the buyer
export async function sendOrderPaidEmail(orderId: number, log: OrderMailLogger): Promise<void> {
  try {
    const order = await loadOrder(orderId);

    if (!order) {
      log.warn({ orderId }, 'order paid mail skipped: the order is gone');
      return;
    }

    // the mail names the time of the payment; an order without one was never paid
    if (!order.paidAt) {
      log.warn({ orderId }, 'order paid mail skipped: the order is not paid');
      return;
    }
    const { paidAt } = order;

    // the latest version of each kind the order holds; none for an order confirmed while no
    // version was in force
    const documents = DOCUMENT_KINDS.flatMap((kind) => {
      const row = order.acceptances.find((one) => one.document.kind === kind);
      return row ? [{ kind, content: row.document.content }] : [];
    });

    const { subject, text, html } = buildOrderPaidTemplate({
      // the name of the shop the mail is from
      appName: env.SHOP_NAME,
      orderId: order.id,
      orderUrl: orderPage(order.id),
      items: order.items.map((item) => ({
        // the name the product had when the order was confirmed
        name: item.productName ?? item.product.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice.toString(),
        totalPrice: item.totalPrice.toString(),
      })),
      total: order.total.toString(),
      // the money of the provider that took it
      currency: currencyOf(order.paymentProvider),
      paidAt,
      ...(order.user.name ? { userName: order.user.name } : {}),
      ...deliveryMailParts(order.delivery),
      // what the buyer pays for the delivery, none for a pickup
      deliveryPrice: order.delivery?.method === 'manual' ? order.delivery.price.toString() : null,
      attachedDocuments: documents.map((doc) => doc.kind),
      logoCid: SHOP_LOGO_CID,
    });

    await sendEmail({
      to: order.user.email,
      subject,
      text,
      html,
      attachments: [
        await shopLogoAttachment(),
        ...documents.map((doc) => ({
          content: Buffer.from(doc.content, 'utf8').toString('base64'),
          type: 'text/plain',
          filename: `${doc.kind}.txt`,
          disposition: 'attachment' as const,
        })),
      ],
    });
  } catch (err) {
    log.error({ err, orderId }, 'order paid mail was not sent');
  }
}
