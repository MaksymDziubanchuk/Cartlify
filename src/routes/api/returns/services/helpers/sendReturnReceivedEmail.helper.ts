import env from '@config/env.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { failureOf } from '@helpers/failureOf.js';
import { returnCodeOf } from '@helpers/returns.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { withdrawalLinkOf } from '@helpers/withdrawalCode.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { itemNameOf } from '@routes/api/orders/services/helpers/itemName.helper.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';
import { buildReturnReceivedTemplate } from '@services/email/templates/returns/returnReceived.template.js';

import type { ReturnMailLogger } from './sendReturnByShopEmail.helper.js';

// the days the law gives to send the goods back after the notice of withdrawal: 14, whatever days the
// contract gives to withdraw (Directive 2011/83, article 14)
const SEND_BACK_DAYS = 14;

// frontend page of an order (WEB_PAGE_ORDER)
const orderPage = (orderId: number) => webPageUrl(env.WEB_PAGE_ORDER, { id: orderId });

// the statement with what the mail shows; it is sent after the statement is kept, as the system
function loadReturn(returnId: number) {
  return prisma.$transaction(async (tx) => {
    await setAdminContext(tx);

    // a query reads at most two relations side by side, so the rows, the order and the contract
    // are read apart
    const row = await tx.orderReturn.findUnique({
      where: { id: returnId },
      select: {
        id: true,
        orderId: true,
        number: true,
        basis: true,
        statedAt: true,
        source: true,
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
        goods: true,
        orderItem: {
          select: { productName: true, variantId: true, product: { select: { name: true } } },
        },
      },
    });

    const order = await tx.order.findUnique({
      where: { id: row.orderId },
      select: {
        returnShippingPaidBy: true,
        user: { select: { name: true, email: true, deletedAt: true } },
      },
    });

    // the address the goods go back to is the one of the contract in force now
    const contract = await tx.legalDocument.findFirst({
      where: { kind: 'contract' },
      orderBy: { version: 'desc' },
      select: { returnAddress: true },
    });

    return { ...row, items, order, returnAddress: contract?.returnAddress ?? null };
  });
}

// mails the buyer that their withdrawal was registered, with the date and time of it (the notice the
// law asks for) and what comes next: for a paid order that was not sent, that the goods stay with
// the shop and the money follows; for a sent one, where to send the goods, by when and who pays. A
// failure is only logged, with the statement id and not the address
export async function sendReturnReceivedEmail(
  returnId: number,
  log: ReturnMailLogger,
): Promise<void> {
  try {
    const row = await loadReturn(returnId);

    if (!row) {
      log.warn({ returnId }, 'return mail skipped: the statement is gone');
      return;
    }

    // the goods that came back at once belong to an order that was not sent
    const beforeShipment = row.items.every((item) => item.goods !== 'expected');

    const units = new Map<string, number>();
    for (const item of row.items) {
      const name = itemNameOf(item.orderItem);
      units.set(name, (units.get(name) ?? 0) + item.quantity);
    }

    // a statement of the public form: the account of the order may be gone, so the buyer is greeted by
    // the name they gave, the mail links no order, and with the code it links the page of the parcel
    const publicForm = row.source === 'form_code' || row.source === 'form_manual';

    const manualCheck = row.source === 'form_manual';

    const mailTo = async (to: string, userName: string | null | undefined) => {
      const { subject, text, html } = buildReturnReceivedTemplate({
        appName: env.SHOP_NAME,
        orderId: row.orderId,
        code: returnCodeOf(row.basis, row.orderId, row.number),
        timeZone: env.SHOP_TIME_ZONE,
        ...(publicForm
          ? {
              publicForm: true,
              manualCheck,
              ...(row.source === 'form_code'
                ? { proofUrl: withdrawalLinkOf(row.orderId, row.id) }
                : {}),
            }
          : {
              orderUrl: orderPage(row.orderId),
              // the account may be gone when the parcel is sent: the page of the code needs none
              ...(row.source === 'account'
                ? { proofUrl: withdrawalLinkOf(row.orderId, row.id) }
                : {}),
            }),
        items: [...units].map(([name, quantity]) => ({ name, quantity })),
        statedAt: row.statedAt,
        beforeShipment,
        returnAddress: row.returnAddress,
        sendBy: new Date(row.statedAt.getTime() + SEND_BACK_DAYS * 86_400_000),
        shippingPaidBy: row.order?.returnShippingPaidBy ?? null,
        supportEmail: env.EMAIL_REPLY_TO,
        ...(userName ? { userName } : {}),
        logoCid: SHOP_LOGO_CID,
      });

      await sendEmail({
        to,
        subject,
        text,
        html,
        attachments: [await shopLogoAttachment()],
      });
    };

    // a statement of the form is greeted by the name given there, the other by the account
    await mailTo(row.contactEmail, publicForm ? row.contactName : row.order?.user?.name);

    // A statement made by hand needs no code, so a third person can send it with the order number
    // and the name of its recipient: the account of the order, while it lives, is told as well
    const owner = row.order?.user;
    if (
      manualCheck &&
      owner &&
      !owner.deletedAt &&
      owner.email.toLowerCase() !== row.contactEmail.toLowerCase()
    ) {
      await mailTo(owner.email, owner.name);
    }
  } catch (err) {
    log.error({ ...failureOf(err), returnId }, 'return received mail was not sent');
  }
}
