import { t } from '@config/i18n.js';
import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { failureOf } from '@helpers/failureOf.js';
import { mailLocaleOf } from '@helpers/locale.js';
import { returnCodeOf } from '@helpers/returns.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { itemNameOf } from '@routes/api/orders/services/helpers/itemName.helper.js';
import { paymentProviders } from '@routes/api/payments/providers/index.js';
import { buildOrderCancelledByBankTemplate } from '@services/email/templates/orders/orderCancelledByBank.template.js';
import { buildOrderCancelledRefundedTemplate } from '@services/email/templates/orders/orderCancelledRefunded.template.js';
import {
  buildReturnClosedTemplate,
  type ReturnClosedMoney,
} from '@services/email/templates/returns/returnClosed.template.js';
import { buildReturnRefundFailedTemplate } from '@services/email/templates/returns/returnRefundFailed.template.js';
import { buildReturnRefundedTemplate } from '@services/email/templates/returns/returnRefunded.template.js';
import { buildReturnReimbursedTemplate } from '@services/email/templates/returns/returnReimbursed.template.js';
import { buildReturnSentBackTemplate } from '@services/email/templates/returns/returnSentBack.template.js';
import { buildReturnSplitTemplate } from '@services/email/templates/returns/returnSplit.template.js';

import {
  movementOf,
  namesRow,
  readReturnMoneyLines,
  wayBackOutsideOf,
  wayBackSentOf,
  sumsOf,
  type ReturnMoneyLine,
} from './returnMoneyLines.helper.js';

import type { ReturnMailLogger } from './sendReturnByShopEmail.helper.js';

// the mails of the money of a statement: the money is back, the statement is closed, the money
// could not go to the card; the mail of the goods the shop sent back to the buyer, and the mail of
// the units that left a statement for one of their own. They go to the email of the statement (a buyer whose account is gone
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
        reason: true,
        closedAt: true,
        closeCode: true,
        contactName: true,
        contactEmail: true,
        splitFromId: true,
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
        notAcceptedReason: true,
        moneyLogId: true,
        backShipmentId: true,
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
      select: { user: { select: { name: true, deletedAt: true, locale: true } } },
    });

    // what the money of the statement did, from the money journal (with the money already with the
    // buyer its parts covered took: what a bank gave for a dispute, a refund made by hand)
    const lines = (await readReturnMoneyLines(tx, [returnId])).get(returnId) ?? [];

    // a statement of the public form is greeted by the name given there, as its first mail was:
    // the one who sent it may not be the holder of the account
    const publicForm = row.source === 'form_code' || row.source === 'form_manual';

    return {
      ...row,
      items,
      lines,
      userName: publicForm ? row.contactName : (order?.user?.name ?? null),
      // a form has no account to read a language from: its mails go in the shop's language
      locale: publicForm ? null : (order?.user?.locale ?? null),
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

// the movement of the money journal the money of a row stands on: the line the row names (the
// goods of a transfer, money sent outside the app, the failure of a transfer) with its parts
// the lines of the goods that paid a row: the line it names, and each part of its money that went
// and did not fail (a row is paid in parts when the payment held only some of it)
function paidLinesOfRow(statement: Statement, row: Row): ReturnMoneyLine[] {
  const failed = new Set(
    statement.lines.filter((one) => one.event === 'money.refund_failed').map((one) => one.coversId),
  );
  return statement.lines.filter(
    (one) =>
      one.part === 'goods' &&
      (one.id === row.moneyLogId ||
        ((one.event === 'money.refund' || one.event === 'money.outside') &&
          !failed.has(one.id) &&
          namesRow(one, row.id))),
  );
}

// the line of the last money of a row: the line it names, or, for a row paid in part that waits
// for the rest naming none, the last part of it that went
function lineOfRow(statement: Statement, row: Row): ReturnMoneyLine | null {
  if (row.moneyLogId !== null) {
    return statement.lines.find((one) => one.id === row.moneyLogId) ?? null;
  }
  return paidLinesOfRow(statement, row).at(-1) ?? null;
}

function movementOfRow(statement: Statement, row: Row): ReturnMoneyLine[] {
  const line = lineOfRow(statement, row);
  return line ? movementOf(statement.lines, line) : [];
}

// what the rows took back in all: the units and the delivery, less the way back the buyer owes,
// in cents; the rows of one movement share its parts, each movement counts once
function moneyOf(statement: Statement, rows: Row[]) {
  const seen = new Set<number>();
  const sum = { total: 0, delivery: 0, deduction: 0, wayBack: 0 };

  for (const row of rows) {
    const line = lineOfRow(statement, row);
    if (!line || seen.has(line.id)) continue;
    seen.add(line.id);

    const sums = sumsOf(movementOfRow(statement, row));
    sum.total += cents(sums.total);
    sum.delivery += cents(sums.delivery);
    sum.deduction += cents(sums.deduction);
    sum.wayBack += cents(sums.wayBack);
  }

  return sum;
}

// what money already with the buyer paid of a movement, in cents, by where it came from: what the
// bank gave for a dispute, or a refund made by hand in the dashboard of the provider (earlier);
// never more than the movement gave, and the rest of it is what the movement itself sent
function coveredOf(statement: Statement, parts: ReturnMoneyLine[]) {
  let rest = cents(sumsOf(parts).total);
  const sum = { bank: 0, earlier: 0, rest: 0 };

  for (const part of parts.filter((one) => one.part === 'covered')) {
    const covered = Math.min(rest, cents(part.amount));
    const source = statement.lines.find((one) => one.id === part.coversId);
    if (source?.purpose === 'dispute') sum.bank += covered;
    else sum.earlier += covered;
    rest -= covered;
  }

  return { ...sum, rest };
}

// what money already with the buyer paid of the rows, each movement once
function coveredOfRows(statement: Statement, rows: Row[]) {
  const seen = new Set<number>();
  const sum = { bank: 0, earlier: 0 };

  for (const row of rows) {
    const line = lineOfRow(statement, row);
    if (!line || seen.has(line.id)) continue;
    seen.add(line.id);

    const covered = coveredOf(statement, movementOfRow(statement, row));
    sum.bank += covered.bank;
    sum.earlier += covered.earlier;
  }

  return sum;
}

// where the money of the rows came from, for the mail of the end, each movement once: the parts money already there covered go to the source of that
// money (what the bank gave for a dispute; a refund made by hand in the dashboard of the provider
// went the way the buyer paid), the rest to the movement itself (a transfer went the way the buyer
// paid; money root sent another way has its way and its day)
function moneySourcesOf(statement: Statement, rows: Row[]): ReturnClosedMoney {
  const seen = new Set<number>();
  const sum = { bank: 0, card: 0 };
  const outside: { cents: number; method: string; sentOn: Date }[] = [];

  // every part of the money of a row, once: a row paid in parts went more than one way
  for (const line of rows.flatMap((row) => paidLinesOfRow(statement, row))) {
    if (seen.has(line.id)) continue;
    seen.add(line.id);

    const covered = coveredOf(statement, movementOf(statement.lines, line));
    sum.bank += covered.bank;
    sum.card += covered.earlier;
    const rest = covered.rest;

    if (line.event === 'money.outside' && line.method) {
      outside.push({ cents: rest, method: line.method, sentOn: line.happenedAt ?? line.createdAt });
    } else {
      sum.card += rest;
    }
  }

  return {
    bank: sum.bank / 100,
    card: sum.card / 100,
    outside: outside.map((one) => ({
      amount: one.cents / 100,
      method: one.method,
      sentOn: one.sentOn,
    })),
  };
}

const common = (statement: Statement) => ({
  orderId: statement.orderId,
  code: returnCodeOf(statement.basis, statement.orderId, statement.number),
  timeZone: env.SHOP_TIME_ZONE,
  orderUrl: orderPage(statement.orderId),
  currency: currency(),
  supportEmail: shopSettings().emailReplyTo,
  appName: shopSettings().shopName,
  locale: mailLocaleOf(statement.locale),
  logoUrl: shopSettings().logoUrl,
  ...(statement.userName ? { userName: statement.userName } : {}),
});

async function send(statement: Statement, mail: { subject: string; text: string; html: string }) {
  if (statement.noAddress) return;

  await sendEmail({ to: statement.contactEmail, ...mail });
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

    // a statement of the system cancelled an order whose money went back another way: its own mail
    if (statement.source === 'system') {
      await sendSystemCancel(statement, itemIds);
      return;
    }

    // closed by the money of this transfer: the code root closed other rows with is not its reason
    if (statement.closedAt) {
      await sendClosed(statement, false);
      return;
    }

    // the rows the money went for: refunded, or paid in part when the payment held only some of
    // it (the rest goes outside the app, and the mail of the end tells it)
    const rows = statement.items.filter(
      (row) =>
        itemIds.includes(row.id) && (row.money === 'refunded' || row.money === 'not_refunded'),
    );
    if (!rows.length) return;

    const money = moneyOf(statement, rows);
    const covered = coveredOfRows(statement, rows);
    // money sent outside the app: its way and the day it went
    const outside = rows
      .map((row) => lineOfRow(statement, row))
      .find((line) => line?.event === 'money.outside' && line.method);
    await send(
      statement,
      buildReturnRefundedTemplate({
        ...common(statement),
        items: linesOf(rows).map(({ name, quantity }) => ({ name, quantity })),
        amount: money.total / 100,
        deliveryAmount: money.delivery / 100,
        deductionAmount: money.deduction / 100,
        wayBackAmount: money.wayBack / 100,
        bankAmount: covered.bank / 100,
        earlierAmount: covered.earlier / 100,
        ...withheldOf(rows),
        ...(outside
          ? { outsideMethod: outside.method, sentOn: outside.happenedAt ?? outside.createdAt }
          : {}),
      }),
    );
  } catch (err) {
    log.error({ ...failureOf(err), returnId }, 'return money mail was not sent');
  }
}

// what the buyer has back of a statement of the system, in cents: what the bank gave by a dispute
// (the parts covered by it), and what went the way the buyer paid or another way (refunds made by
// hand in the dashboard of the provider, the transfers of the statement, money sent outside the app)
function systemMoneyOf(statement: Statement) {
  const sources = moneySourcesOf(
    statement,
    statement.items.filter((row) => row.money === 'refunded'),
  );
  const outside = sources.outside.reduce((all, one) => all + cents(Number(one.amount)), 0);

  return { bank: cents(Number(sources.bank)), sent: cents(Number(sources.card)) + outside };
}

// The mail of a statement the system made to cancel an order that was not sent, once its rows are
// refunded: all of the payment went back by hand in the dashboard of the provider (stripe_refund:
// the order is cancelled and the money is sent), or the bank decided a dispute of it for the buyer
// (dispute_lost: what the bank gave back, and what the shop sent of the rest). It takes the place of
// the mails of a statement of the shop: the buyer never asked for a return
async function sendSystemCancel(statement: Statement, itemIds: number[]) {
  const done = statement.items.some((row) => itemIds.includes(row.id) && row.money === 'refunded');
  if (!done) return;

  const money = systemMoneyOf(statement);

  if (statement.reason === 'stripe_refund') {
    await send(
      statement,
      buildOrderCancelledRefundedTemplate({
        ...common(statement),
        amount: (money.bank + money.sent) / 100,
      }),
    );
  } else if (statement.reason === 'dispute_lost') {
    await send(
      statement,
      buildOrderCancelledByBankTemplate({
        ...common(statement),
        bankAmount: money.bank / 100,
        sentAmount: money.sent / 100,
      }),
    );
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
  const locale = mailLocaleOf(statement.locale);

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
          ? t(`notAcceptedReasons.${row.notAcceptedReason}`, locale)
          : t('returnClosed.goodsNotArrived', locale),
      ),
      money: moneySourcesOf(statement, refunded),
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

    // the rows of the transfer the card did not take: the failure is the line the row names
    const rows = statement.items.filter(
      (row) =>
        itemIds.includes(row.id) &&
        row.money === 'failed' &&
        statement.lines.find((line) => line.id === row.moneyLogId)?.failure === 'card_unavailable',
    );
    if (!rows.length) return;

    // what the card was asked to take: the money already with the buyer that the transfer took
    // first (a refund made by hand, what a bank gave) did not go to the card and did not fail
    const covered = coveredOfRows(statement, rows);
    await send(
      statement,
      buildReturnRefundFailedTemplate({
        ...common(statement),
        amount: (moneyOf(statement, rows).total - covered.bank - covered.earlier) / 100,
        sentBack,
      }),
    );
  } catch (err) {
    log.error({ ...failureOf(err), returnId }, 'return refund failed mail was not sent');
  }
}

// the shop paid the buyer back the cost of sending the goods back with nothing else: by a transfer of
// its own to the payment (transferKey, once the provider told it sent), or outside the app (a
// transfer could not hold it). The buyer is told how much, how and when
export async function sendReturnReimbursedEmail(
  returnId: number,
  log: ReturnMailLogger,
  transferKey?: string,
): Promise<void> {
  try {
    const statement = await loadStatement(returnId);
    if (!statement) {
      log.warn({ returnId }, 'return mail skipped: the statement is gone');
      return;
    }
    // by a transfer of its own (the key names it, told sent), or outside the app
    const sent = transferKey ? wayBackSentOf(statement.lines, transferKey) : null;
    const paid = transferKey ? null : wayBackOutsideOf(statement.lines);
    if (!sent && !paid?.method) return;

    await send(
      statement,
      buildReturnReimbursedTemplate({
        ...common(statement),
        amount: -(sent ?? paid!).amount,
        method: sent ? 'provider' : paid!.method!,
        sentOn: sent ? (sent.stateAt ?? sent.createdAt) : (paid!.happenedAt ?? paid!.createdAt),
      }),
    );
  } catch (err) {
    log.error({ ...failureOf(err), returnId }, 'return reimbursed mail was not sent');
  }
}

// an admin sent goods the shop did not accept back to the buyer: the units the parcel carries, its
// carrier and its number
export async function sendReturnSentBackEmail(
  returnId: number,
  shipmentId: number,
  log: ReturnMailLogger,
): Promise<void> {
  try {
    const statement = await loadStatement(returnId);
    if (!statement) {
      log.warn({ returnId }, 'return mail skipped: the statement is gone');
      return;
    }
    const parcel = await prisma.$transaction(async (tx) => {
      await setAdminContext(tx);
      return tx.orderShipment.findUnique({
        where: { id: shipmentId },
        select: { carrier: true, trackingNumber: true, trackingUrl: true },
      });
    });
    const rows = statement.items.filter((row) => row.backShipmentId === shipmentId);
    if (!parcel || !rows.length) return;

    await send(
      statement,
      buildReturnSentBackTemplate({
        ...common(statement),
        items: linesOf(rows),
        carrier: parcel.carrier,
        trackingNumber: parcel.trackingNumber,
        trackingUrl: parcel.trackingUrl,
      }),
    );
  } catch (err) {
    log.error({ ...failureOf(err), returnId }, 'return sent back mail was not sent');
  }
}

// units of a statement went into a statement of their own, sent back in a parcel of their own: the
// buyer is told its code, the statement they left and the units
export async function sendReturnSplitEmail(returnId: number, log: ReturnMailLogger): Promise<void> {
  try {
    const statement = await loadStatement(returnId);
    if (!statement || statement.splitFromId === null) {
      log.warn({ returnId }, 'return mail skipped: the statement is gone');
      return;
    }
    const from = await loadStatement(statement.splitFromId);
    if (!from) {
      log.warn({ returnId }, 'return mail skipped: the statement is gone');
      return;
    }

    await send(
      statement,
      buildReturnSplitTemplate({
        ...common(statement),
        fromCode: returnCodeOf(from.basis, from.orderId, from.number),
        items: linesOf(statement.items),
      }),
    );
  } catch (err) {
    log.error({ ...failureOf(err), returnId }, 'return split mail was not sent');
  }
}
