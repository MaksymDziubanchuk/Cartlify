import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { mailLocaleOf } from '@helpers/locale.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { buildOrderReceiptTemplate } from '@services/email/templates/orders/orderReceipt.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';

// The mail of a fiscal receipt the fiscal service registered (docs/taxes.md), to the buyer of the
// order. The receipt is kept before the mail goes, so a mail that fails is only logged, with the
// order id and not the address. A deleted account gets none: its address is not the person's any
// more

type Log = { error: (obj: unknown, msg?: string) => void };

export type ReceiptMailArgs = {
  orderId: number;
  kind: 'sale' | 'return';
  number: string | null;
  url: string | null;
  text: string | null;
  gross: number;
  currency: string;
};

export async function sendReceiptEmail(args: ReceiptMailArgs, log: Log): Promise<void> {
  try {
    const buyer = await prisma.$transaction(async (db) => {
      await setAdminContext(db);
      const order = await db.order.findUnique({
        where: { id: args.orderId },
        select: { user: { select: { email: true, name: true, locale: true, deletedAt: true } } },
      });
      return order?.user ?? null;
    });
    if (!buyer || buyer.deletedAt) return;

    const { subject, text, html } = buildOrderReceiptTemplate({
      appName: shopSettings().shopName,
      orderId: args.orderId,
      orderUrl: webPageUrl(env.WEB_PAGE_ORDER, { id: args.orderId }),
      kind: args.kind,
      number: args.number,
      checkUrl: args.url,
      lawText: args.text,
      amount: args.gross,
      currency: args.currency,
      supportEmail: shopSettings().emailReplyTo,
      ...(buyer.name ? { userName: buyer.name } : {}),
      logoUrl: shopSettings().logoUrl,
      locale: mailLocaleOf(buyer.locale),
    });

    await sendEmail({ to: buyer.email, subject, text, html });
  } catch (err) {
    log.error({ err, orderId: args.orderId }, 'receipt mail was not sent');
  }
}
