import { readFile } from 'node:fs/promises';
import path from 'node:path';

import env from '@config/env.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { webUrl } from '@helpers/webOrigin.js';
import { buildOrderPaidTemplate } from '@services/email/templates/orders/orderPaid.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';

import { currencyOf } from '../../providers/index.js';

export type OrderMailLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// frontend page of an order, a placeholder until the frontend fixes its routes
const orderPage = (orderId: number) => `/orders/${orderId}`;

// the kinds of the documents a mail carries, in the order it names them
const DOCUMENT_KINDS = ['terms', 'contract'] as const;

// the order with what the mail shows; the payment event runs as the system, so admin context
function loadOrder(orderId: number) {
  return prisma.$transaction(async (tx) => {
    await setAdminContext(tx);

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        total: true,
        paymentProvider: true,
        shippingAddress: true,
        recipientFirstName: true,
        recipientLastName: true,
        recipientPhone: true,
        paidAt: true,
        user: { select: { email: true, name: true } },
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

    // the versions of the terms and of the contract the order was confirmed with, latest first:
    // an order confirmed again keeps the ones of its last confirmation. A query of its own, one
    // statement of a transaction runs at a time
    const acceptances = await tx.legalAcceptance.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { document: { select: { kind: true, content: true } } },
    });

    return { ...order, acceptances };
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
      orderUrl: webUrl(orderPage(order.id)),
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
      shippingAddress: order.shippingAddress,
      recipientName: [order.recipientFirstName, order.recipientLastName].filter(Boolean).join(' '),
      recipientPhone: order.recipientPhone,
      attachedDocuments: documents.map((doc) => doc.kind),
      logoCid: 'cartlify-logo',
    });

    const logoPath = path.join(process.cwd(), 'src', 'static', 'images', 'logo3.png');
    const logoBase64 = (await readFile(logoPath)).toString('base64');

    await sendEmail({
      to: order.user.email,
      subject,
      text,
      html,
      attachments: [
        {
          content: logoBase64,
          type: 'image/png',
          filename: 'logo3.png',
          disposition: 'inline',
          content_id: 'cartlify-logo',
        },
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
