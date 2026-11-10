import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { failureOf } from '@helpers/failureOf.js';
import { mailLocaleOf } from '@helpers/locale.js';
import { returnCodeOf } from '@helpers/returns.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { itemNameOf } from '@routes/api/orders/services/helpers/itemName.helper.js';
import { buildReturnByShopTemplate } from '@services/email/templates/returns/returnByShop.template.js';

export type ReturnMailLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// frontend page of an order (WEB_PAGE_ORDER)
const orderPage = (orderId: number) => webPageUrl(env.WEB_PAGE_ORDER, { id: orderId });

// the statement with what the mail shows; it is sent after the statement is kept, as the system
function loadReturn(returnId: number) {
  return prisma.$transaction(async (tx) => {
    await setAdminContext(tx);

    // a query reads at most two relations side by side, so the rows and the buyer are read apart
    const row = await tx.orderReturn.findUnique({
      where: { id: returnId },
      select: {
        id: true,
        orderId: true,
        number: true,
        basis: true,
        extendsId: true,
        reason: true,
        description: true,
        statedAt: true,
        contactName: true,
        contactEmail: true,
      },
    });
    if (!row) return null;

    const items = await tx.orderReturnItem.findMany({
      where: { returnId },
      orderBy: { id: 'asc' },
      select: {
        quantity: true,
        orderItem: {
          select: { productName: true, variantId: true, product: { select: { name: true } } },
        },
      },
    });

    const buyer = await tx.order.findUnique({
      where: { id: row.orderId },
      select: { user: { select: { deletedAt: true, name: true, locale: true } } },
    });

    return { ...row, items, buyer: buyer?.user ?? null };
  });
}

// mails the buyer that the shop registered a return for their order. The statement is kept before
// this runs, so a mail that fails is only logged, with the statement id and not the address. A
// deleted account gets no mail from the account: the address of a statement of a form is kept for
// the answers, but this mail is for the one an admin made
export async function sendReturnByShopEmail(
  returnId: number,
  log: ReturnMailLogger,
): Promise<void> {
  try {
    const row = await loadReturn(returnId);

    if (!row) {
      log.warn({ returnId }, 'return mail skipped: the statement is gone');
      return;
    }
    if (row.buyer?.deletedAt) return;

    // the rows with units, the same item named by its parts once
    const units = new Map<string, number>();
    for (const item of row.items) {
      const name = itemNameOf(item.orderItem);
      units.set(name, (units.get(name) ?? 0) + item.quantity);
    }

    const { subject, text, html } = buildReturnByShopTemplate({
      appName: shopSettings().shopName,
      orderId: row.orderId,
      code: returnCodeOf(row.basis, row.orderId, row.number),
      timeZone: env.SHOP_TIME_ZONE,
      orderUrl: orderPage(row.orderId),
      items: [...units].map(([name, quantity]) => ({ name, quantity })),
      reason: row.reason,
      description: row.description,
      statedAt: row.statedAt,
      supportEmail: shopSettings().emailReplyTo,
      extended: row.extendsId !== null,
      ...(row.buyer?.name ? { userName: row.buyer.name } : {}),
      logoUrl: shopSettings().logoUrl,
      locale: mailLocaleOf(row.buyer?.locale),
    });

    await sendEmail({
      to: row.contactEmail,
      subject,
      text,
      html,
    });
  } catch (err) {
    log.error({ ...failureOf(err), returnId }, 'return mail was not sent');
  }
}
