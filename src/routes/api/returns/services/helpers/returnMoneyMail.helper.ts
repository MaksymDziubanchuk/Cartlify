import env from '@config/env.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { failureOf } from '@helpers/failureOf.js';
import { returnCodeOf } from '@helpers/returns.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { itemNameOf } from '@routes/api/orders/services/helpers/itemName.helper.js';
import { paymentProviders } from '@routes/api/payments/providers/index.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';
import {
  NOT_ACCEPTED_WORDS,
  buildReturnClosedTemplate,
} from '@services/email/templates/returns/returnClosed.template.js';
import { buildReturnRefundFailedTemplate } from '@services/email/templates/returns/returnRefundFailed.template.js';
import { buildReturnRefundedTemplate } from '@services/email/templates/returns/returnRefunded.template.js';
import { buildReturnReimbursedTemplate } from '@services/email/templates/returns/returnReimbursed.template.js';

import type { ReturnMailLogger } from './sendReturnByShopEmail.helper.js';

// the mails of the money of a statement: the money is back, the statement is closed, the money
// could not go to the card. They go to the email of the statement (a buyer whose account is gone
// still gets the answers), after the money or the closing is kept: a mail that fails is only
// logged, with the statement id and not the address

// frontend page of an order (WEB_PAGE_ORDER)
const orderPage = (orderId: number) => webPageUrl(env.WEB_PAGE_ORDER, { id: orderId });

// every provider charges in the same currency (providers/index.ts checks it)
const currency = () => paymentProviders[0]!.currency;

// cents without float math
const cents = (value: number) => Math.round(value * 100);

async function loadStatement(returnId: number) {
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
        source: true,
        closedAt: true,
        closeCode: true,
        contactName: true,
        contactEmail: true,
        shippingReimbursed: true,
        shippingReimbursedAt: true,
        shippingReimbursedMethod: true,
      },
    });
    if (!row) return null;

    const items = await tx.orderReturnItem.findMany({
      where: { returnId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        quantity: true,
        goods: true,
        money: true,
        amount: true,
        deliveryShare: true,
        shippingDeduction: true,
        notAcceptedReason: true,
        outsideMethod: true,
        refundedAt: true,
        refundFailure: true,
        orderItem: {
          select: {
            productName: true,
            variantId: true,
            unitPrice: true,
            product: { select: { name: true } },
          },
        },
      },
    });

    const order = await tx.order.findUnique({
      where: { id: row.orderId },
      select: { user: { select: { name: true, deletedAt: true } } },
    });

    // a statement of the public form is greeted by the name given there, as its first mail was:
    // the one who sent it may not be the holder of the account
    const publicForm = row.source === 'form_code' || row.source === 'form_manual';

    return {
      ...row,
      items,
      userName: publicForm ? row.contactName : (order?.user?.name ?? null),
      // the email of a statement an admin made is the one of the account; a deleted account has
      // none that leads anywhere
      noAddress: row.source === 'admin' && order?.user?.deletedAt != null,
    };
  });
}

type Statement = NonNullable<Awaited<ReturnType<typeof loadStatement>>>;
type Row = Statement['items'][number];

// what root kept of the money of the rows for the value the goods lost (the price of their units
// less what they give back), and the goods it was kept for; the note of root stays the shop's
function withheldOf(rows: Row[]) {
  const names = new Set<string>();
  let kept = 0;
  for (const row of rows) {
    const price = cents(decimalToNumber(row.orderItem.unitPrice) * row.quantity);
    const lowered = price - cents(decimalToNumber(row.amount));
    if (lowered > 0) {
      kept += lowered;
      names.add(itemNameOf(row.orderItem));
    }
  }
  return { withheldAmount: kept / 100, withheldItems: [...names] };
}

// the same item named by its parts once, with its units added
function linesOf(rows: Row[], why?: (row: Row) => string) {
  const lines = new Map<string, { quantity: number; why: string }>();
  for (const row of rows) {
    const name = itemNameOf(row.orderItem);
    const reason = why ? why(row) : '';
    const key = `${name}\n${reason}`;
    const line = lines.get(key);
    lines.set(key, { quantity: (line?.quantity ?? 0) + row.quantity, why: reason });
  }
  return [...lines].map(([key, line]) => ({
    name: key.split('\n')[0]!,
    quantity: line.quantity,
    why: line.why,
  }));
}

// what the rows took back in all: the units and the delivery, less the way back the buyer owes,
// in cents
const moneyOf = (rows: Row[]) =>
  rows.reduce(
    (sum, row) => ({
      total:
        sum.total +
        cents(decimalToNumber(row.amount)) +
        cents(decimalToNumber(row.deliveryShare)) -
        cents(decimalToNumber(row.shippingDeduction)),
      delivery: sum.delivery + cents(decimalToNumber(row.deliveryShare)),
      deduction: sum.deduction + cents(decimalToNumber(row.shippingDeduction)),
    }),
    { total: 0, delivery: 0, deduction: 0 },
  );

const common = (statement: Statement) => ({
  orderId: statement.orderId,
  code: returnCodeOf(statement.basis, statement.orderId, statement.number),
  timeZone: env.SHOP_TIME_ZONE,
  orderUrl: orderPage(statement.orderId),
  currency: currency(),
  supportEmail: env.EMAIL_REPLY_TO,
  appName: env.SHOP_NAME,
  logoCid: SHOP_LOGO_CID,
  ...(statement.userName ? { userName: statement.userName } : {}),
});

async function send(statement: Statement, mail: { subject: string; text: string; html: string }) {
  if (statement.noAddress) return;

  await sendEmail({
    to: statement.contactEmail,
    ...mail,
    attachments: [await shopLogoAttachment()],
  });
}

// the money of these rows is back: when the statement is over it is the mail that closes it (the
// units that went back and those that did not, with the money in all), else the mail that tells
// the money of this transfer
export async function sendReturnMoneyEmail(
  returnId: number,
  itemIds: number[],
  log: ReturnMailLogger,
): Promise<void> {
  try {
    const statement = await loadStatement(returnId);
    if (!statement) {
      log.warn({ returnId }, 'return mail skipped: the statement is gone');
      return;
    }

    // closed by the money of this transfer: the code root closed other rows with is not its reason
    if (statement.closedAt) {
      await sendClosed(statement, false);
      return;
    }

    const rows = statement.items.filter(
      (row) => itemIds.includes(row.id) && row.money === 'refunded',
    );
    if (!rows.length) return;

    const money = moneyOf(rows);
    const outside = rows.find((row) => row.outsideMethod);
    await send(
      statement,
      buildReturnRefundedTemplate({
        ...common(statement),
        items: linesOf(rows).map(({ name, quantity }) => ({ name, quantity })),
        amount: money.total / 100,
        deliveryAmount: money.delivery / 100,
        deductionAmount: money.deduction / 100,
        ...withheldOf(rows),
        ...(outside ? { outsideMethod: outside.outsideMethod, sentOn: outside.refundedAt } : {}),
      }),
    );
  } catch (err) {
    log.error({ ...failureOf(err), returnId }, 'return money mail was not sent');
  }
}

// the statement is over: what went back and what did not. withCode: root closed it just now, the
// code it gave says why in words; a statement closed by its goods or its money has no such reason
export async function sendReturnClosedEmail(
  returnId: number,
  log: ReturnMailLogger,
  opts: { withCode?: boolean } = {},
): Promise<void> {
  try {
    const statement = await loadStatement(returnId);
    if (!statement) {
      log.warn({ returnId }, 'return mail skipped: the statement is gone');
      return;
    }
    if (!statement.closedAt) return;

    await sendClosed(statement, opts.withCode === true);
  } catch (err) {
    log.error({ ...failureOf(err), returnId }, 'return closed mail was not sent');
  }
}

async function sendClosed(statement: Statement, withCode: boolean) {
  const refunded = statement.items.filter((row) => row.money === 'refunded');
  const declined = statement.items.filter((row) => row.money === 'refused');

  await send(
    statement,
    buildReturnClosedTemplate({
      ...common(statement),
      // a form without a code can come from anybody who knows the number and the name of the
      // recipient: its mails never say what the order holds (its first mail does not either)
      hideItems: statement.source === 'form_manual',
      refunded: linesOf(refunded).map(({ name, quantity }) => ({ name, quantity })),
      declined: linesOf(declined, (row) =>
        row.goods === 'not_accepted' && row.notAcceptedReason
          ? (NOT_ACCEPTED_WORDS[row.notAcceptedReason] ?? NOT_ACCEPTED_WORDS.other!)
          : 'the goods did not arrive',
      ),
      refundedAmount: moneyOf(refunded).total / 100,
      ...withheldOf(refunded),
      closeCode: withCode ? statement.closeCode : null,
    }),
  );
}

// the card can no longer take the money: the buyer is told the shop will write about another way
export async function sendReturnRefundFailedEmail(
  returnId: number,
  itemIds: number[],
  log: ReturnMailLogger,
  // the money had gone to the card and its bank sent it back
  sentBack = false,
): Promise<void> {
  try {
    const statement = await loadStatement(returnId);
    if (!statement) {
      log.warn({ returnId }, 'return mail skipped: the statement is gone');
      return;
    }

    const rows = statement.items.filter(
      (row) => itemIds.includes(row.id) && row.refundFailure === 'card_unavailable',
    );
    if (!rows.length) return;

    await send(
      statement,
      buildReturnRefundFailedTemplate({
        ...common(statement),
        amount: moneyOf(rows).total / 100,
        sentBack,
      }),
    );
  } catch (err) {
    log.error({ ...failureOf(err), returnId }, 'return refund failed mail was not sent');
  }
}

// root recorded that the shop paid the buyer back the cost of sending the goods back, outside the
// app: the buyer is told how much, how and when
export async function sendReturnReimbursedEmail(
  returnId: number,
  log: ReturnMailLogger,
): Promise<void> {
  try {
    const statement = await loadStatement(returnId);
    if (!statement) {
      log.warn({ returnId }, 'return mail skipped: the statement is gone');
      return;
    }
    if (
      statement.shippingReimbursed === null ||
      statement.shippingReimbursedAt === null ||
      statement.shippingReimbursedMethod === null
    ) {
      return;
    }

    await send(
      statement,
      buildReturnReimbursedTemplate({
        ...common(statement),
        amount: decimalToNumber(statement.shippingReimbursed),
        method: statement.shippingReimbursedMethod,
        sentOn: statement.shippingReimbursedAt,
      }),
    );
  } catch (err) {
    log.error({ ...failureOf(err), returnId }, 'return reimbursed mail was not sent');
  }
}
