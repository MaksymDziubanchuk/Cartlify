import { Prisma } from '@prisma/client';

import { returnCodeOf } from '@helpers/returns.js';
import { HIDDEN_ID, hiddenText } from '@helpers/rootHidden.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { itemNameOf } from '@routes/api/orders/services/helpers/itemName.helper.js';
import { bankMoneyPendingOf } from '@routes/api/payments/services/helpers/moneyHeld.helper.js';

import {
  deductibleOf,
  readReturnMoneyLines,
  rowPaidOf,
  shipmentCostOf,
} from './returnMoneyLines.helper.js';

import type { ReturnDto, ReturnPersonDto } from 'types/dto/returns.dto.js';
import type { Role } from 'types/user.js';

type Db = Prisma.TransactionClient;

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

// the card of a statement for an admin (6.2): the statement, its rows, the order it stands on with
// its buyer and recipient, the people it names, what was done with it (the journal of the admins)
// and what its money did (the money journal: the parts of its transfers, their failures, money sent
// outside the app, the way back paid back, what its parcels cost). Whether a dispute of the payment
// is open at the bank or a refund made by hand waits for root: no transfer goes then. Root, as the
// journals show it, is hidden from an admin. A query of a transaction reads at most two relations
// beside its row, so the parts are read apart, one after the other; null when the statement is not
// there
export async function readReturnCard(
  db: Db,
  returnId: number,
  viewer: Role,
): Promise<ReturnDto | null> {
  const row = await db.orderReturn.findUnique({
    where: { id: returnId },
    select: {
      id: true,
      orderId: true,
      number: true,
      extendsId: true,
      splitFromId: true,
      statedAt: true,
      source: true,
      createdById: true,
      basis: true,
      reason: true,
      description: true,
      contactName: true,
      contactEmail: true,
      ip: true,
      userAgent: true,
      acceptedAt: true,
      acceptedById: true,
      closedAt: true,
      closedById: true,
      closeCode: true,
      closeNote: true,
      refundedTotal: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) return null;

  const rows = await db.orderReturnItem.findMany({
    where: { returnId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      orderItemId: true,
      quantity: true,
      goods: true,
      notAcceptedReason: true,
      money: true,
      amount: true,
      amountNote: true,
      moneyLogId: true,
      refusedCode: true,
      goodsSetAt: true,
      goodsSetById: true,
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

  const order = await db.order.findUnique({
    where: { id: row.orderId },
    select: {
      id: true,
      total: true,
      status: true,
      returnStatus: true,
      returnShippingPaidBy: true,
      userId: true,
      paymentId: true,
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
        },
      },
    },
  });

  // what was done with the statement: the lines of the journal of the admins that name it
  const history = await db.adminAuditLog.findMany({
    where: {
      entityType: 'order',
      entityId: row.orderId,
      event: { startsWith: 'return.' },
      OR: [
        { meta: { array_contains: [{ field: 'returnId', new: returnId }] } },
        { meta: { array_contains: [{ field: 'splitId', new: returnId }] } },
      ],
    },
    orderBy: { id: 'asc' },
    select: { id: true, createdAt: true, event: true, actorId: true, actorRole: true, meta: true },
  });

  // the statements split from this one
  const splits = await db.orderReturn.findMany({
    where: { splitFromId: returnId },
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  // the parcels of the statement, and the rows each parcel to the buyer carried back
  const parcels = await db.orderShipment.findMany({
    where: { returnId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      direction: true,
      carrier: true,
      trackingNumber: true,
      trackingUrl: true,
      shippedAt: true,
      recordedById: true,
      confirmedAt: true,
      confirmedById: true,
      buyerPaid: true,
      createdAt: true,
    },
  });
  const sentBack = await db.orderReturnItem.findMany({
    where: { returnId, backShipmentId: { not: null } },
    orderBy: { id: 'asc' },
    select: { id: true, backShipmentId: true },
  });

  const lines = (await readReturnMoneyLines(db, [returnId])).get(returnId) ?? [];
  const paymentId = order?.paymentId ?? null;

  // a dispute of the payment open at the bank, and a refund of it made by hand that root has not
  // said what it was for yet: begin_return_refund refuses a transfer while either is there (db/05)
  const disputeOpen = paymentId
    ? (await db.paymentDispute.count({
        where: {
          paymentId,
          status: { notIn: ['won', 'lost', 'prevented', 'warning_closed'] },
        },
      })) > 0
    : false;
  const handRefundPending = paymentId
    ? (
        await db.$queryRaw<{ pending: boolean }[]>(Prisma.sql`
          select exists (
            select 1 from cartlify.money_log as l
            where l."paymentId" = ${paymentId}
              and l.purpose = 'hand'::cartlify."MoneyPurpose"
              and l.event = 'money.refund'
              and l."moneyUse" is null
              and not exists (
                select 1 from cartlify.money_log as f
                where f.event = 'money.refund_failed' and f."coversId" = l.id
              )
          ) as pending
        `)
      )[0]!.pending
    : false;

  // what the bank took for a dispute lost on an order sent waits for root to say what it was for
  const bankMoneyPending = paymentId
    ? (
        await db.$queryRaw<{ pending: boolean }[]>(Prisma.sql`
          select ${bankMoneyPendingOf(Prisma.sql`${paymentId}`)} as pending
        `)
      )[0]!.pending
    : false;

  // what the statement still owes the buyer, what money already with the buyer covers of what is due
  // and what the provider can still take (return_money_left, db/05)
  const [owed] = await db.$queryRaw<{ left: Record<string, string | boolean> }[]>(Prisma.sql`
    select cartlify.return_money_left(${returnId}::int) as left
  `);
  const moneyLeft = {
    rows: Number(owed!.left.rows),
    delivery: Number(owed!.left.delivery),
    wayBack: Number(owed!.left.wayBack),
    total: Number(owed!.left.total),
    due: Number(owed!.left.due),
    covered: Number(owed!.left.covered),
    paymentLeft: Number(owed!.left.paymentLeft),
    short: owed!.left.short === true,
  };

  // what money already with the buyer gave the goods of the order more than its statements took
  // (order_money_overpaid, db/05): the buyer gave it back, the shop gives it up or keeps the goods
  const [over] = await db.$queryRaw<{ overpaid: string }[]>(Prisma.sql`
    select cartlify.order_money_overpaid(${row.orderId}::int)::text as overpaid
  `);
  const moneyOverpaid = Number(over!.overpaid);

  const personIds = [
    ...new Set(
      [
        order?.userId ?? null,
        ...history.map((line) => line.actorId),
        row.createdById,
        row.acceptedById,
        row.closedById,
        ...lines.map((line) => line.actorId),
        ...rows.map((item) => item.goodsSetById),
        ...parcels.flatMap((parcel) => [parcel.recordedById, parcel.confirmedById]),
      ].filter((id): id is number => id !== null),
    ),
  ];
  const people = personIds.length
    ? await db.user.findMany({
        where: { id: { in: personIds } },
        select: { id: true, name: true, email: true, role: true, deletedAt: true },
      })
    : [];
  // root, as the journals show it to an admin: the id 0 and the texts hidden
  const personOf = (id: number | null): ReturnPersonDto | null => {
    if (id === null) return null;
    const person = people.find((one) => one.id === id);
    if (!person) return null;
    if (viewer !== 'ROOT' && person.role === 'ROOT') {
      return { id: HIDDEN_ID, name: hiddenText(person.name), email: hiddenText(person.email)! };
    }
    return { id: person.id, name: person.name, email: person.email };
  };
  const buyer = people.find((one) => one.id === order?.userId);

  // the way back the next transfer may still take off: the cost of the parcels less what the
  // transfers took for them (begin_return_refund holds the same bound), while a row waits for its
  // money and the buyer owes the way back of the withdrawal
  const deductible =
    row.basis === 'withdrawal' &&
    order?.returnShippingPaidBy === 'buyer' &&
    rows.some((item) => item.money === 'not_refunded' || item.money === 'failed')
      ? deductibleOf(parcels.find((parcel) => parcel.direction === 'to_shop')?.id ?? null, lines)
      : 0;
  const lineOf = (id: number | null) => lines.find((line) => line.id === id) ?? null;
  // what a row had of its money: refunded, all of it; a row the lines name, what they paid of it;
  // a row that came of a row a transfer pays (its units with a result of their own) goes with it
  const paidOf = rowPaidOf(lines);
  const paidOfRow = (id: number, money: string, amount: number) => {
    if (money === 'refunded') return amount;
    const named = paidOf.get(id);
    if (named !== undefined) return Math.min(Math.max(named, 0), amount);
    return money === 'pending' ? amount : 0;
  };

  return {
    id: row.id,
    code: returnCodeOf(row.basis, row.orderId, row.number),
    orderId: row.orderId,
    extendsId: row.extendsId,
    splitFromId: row.splitFromId,
    splitIds: splits.map((one) => one.id),
    statedAt: row.statedAt.toISOString(),
    source: row.source,
    basis: row.basis,
    reason: row.reason,
    description: row.description,
    contact: { name: row.contactName, email: row.contactEmail },
    createdBy: personOf(row.createdById),
    ip: row.ip,
    userAgent: row.userAgent,
    acceptedAt: iso(row.acceptedAt),
    acceptedBy: personOf(row.acceptedById),
    closedAt: iso(row.closedAt),
    closedBy: personOf(row.closedById),
    closeCode: row.closeCode,
    closeNote: row.closeNote,
    refundedTotal: decimalToNumber(row.refundedTotal),
    disputeOpen,
    handRefundPending,
    bankMoneyPending,
    moneyLeft,
    moneyOverpaid,
    money: lines.map((line) => ({
      id: line.id,
      event: line.event,
      purpose: line.purpose,
      part: line.part,
      amount: line.amount,
      currency: line.currency,
      state: line.state,
      stateAt: iso(line.stateAt),
      createdAt: line.createdAt.toISOString(),
      happenedAt: iso(line.happenedAt),
      refundId: line.refundId,
      bankReference: line.bankReference,
      byDashboard: line.byDashboard,
      failure: line.failure,
      failureText: line.failureText,
      method: line.method,
      note: line.note,
      coversId: line.coversId,
      shipmentId: line.orderShipmentId,
      by: personOf(line.actorId),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    parcels: parcels.map((parcel) => ({
      id: parcel.id,
      direction: parcel.direction,
      carrier: parcel.carrier,
      trackingNumber: parcel.trackingNumber,
      trackingUrl: parcel.trackingUrl,
      shippedAt: parcel.shippedAt.toISOString(),
      recordedBy: personOf(parcel.recordedById),
      confirmedAt: iso(parcel.confirmedAt),
      confirmedBy: personOf(parcel.confirmedById),
      buyerPaid: parcel.buyerPaid === null ? null : decimalToNumber(parcel.buyerPaid),
      cost: shipmentCostOf(lines, parcel.id),
      itemIds: sentBack.filter((one) => one.backShipmentId === parcel.id).map((one) => one.id),
      createdAt: parcel.createdAt.toISOString(),
    })),
    deductible,
    // the shop paid the parcel of the goods back to the shop; what the buyer paid the carrier for it
    // is more than the order cost (a typo to check before money goes)
    warnings: [
      ...(parcels.some(
        (parcel) => parcel.direction === 'to_shop' && (shipmentCostOf(lines, parcel.id) ?? 0) > 0,
      )
        ? (['shop_paid_parcel'] as const)
        : []),
      ...(order &&
      parcels.some(
        (parcel) =>
          parcel.direction === 'to_shop' &&
          parcel.buyerPaid !== null &&
          parcel.buyerPaid.greaterThan(order.total),
      )
        ? (['buyer_paid_over_total'] as const)
        : []),
    ],
    order: order
      ? {
          id: order.id,
          status: order.status,
          returnStatus: order.returnStatus,
          // the account of the order; a deleted one keeps no address that leads anywhere
          buyer: buyer
            ? {
                id: buyer.id,
                name: buyer.name,
                email: buyer.deletedAt ? null : buyer.email,
                deleted: buyer.deletedAt !== null,
              }
            : null,
          recipient: order.delivery
            ? {
                method: order.delivery.method,
                firstName: order.delivery.recipientFirstName,
                lastName: order.delivery.recipientLastName,
                phone: order.delivery.recipientPhone,
                country: order.delivery.country,
                postalCode: order.delivery.postalCode,
                city: order.delivery.city,
                street: order.delivery.street,
                house: order.delivery.house,
                apartment: order.delivery.apartment,
                note: order.delivery.note,
              }
            : null,
        }
      : {
          id: row.orderId,
          status: 'unknown',
          returnStatus: 'none',
          buyer: null,
          recipient: null,
        },
    history: history.map((line) => ({
      id: line.id,
      createdAt: line.createdAt.toISOString(),
      event: line.event,
      actorRole: line.actorRole,
      actor: personOf(line.actorId),
      changes: Array.isArray(line.meta) ? (line.meta as unknown[]) : [],
    })),
    items: rows.map((item) => ({
      id: item.id,
      orderItemId: item.orderItemId,
      productId: item.orderItem.productId,
      variantId: item.orderItem.variantId,
      name: itemNameOf(item.orderItem),
      quantity: item.quantity,
      goods: item.goods,
      notAcceptedReason: item.notAcceptedReason,
      money: item.money,
      amount: decimalToNumber(item.amount),
      paid: paidOfRow(item.id, item.money, decimalToNumber(item.amount)),
      amountNote: item.amountNote,
      goodsSetAt: iso(item.goodsSetAt),
      goodsSetBy: personOf(item.goodsSetById),
      moneyLogId: item.moneyLogId,
      refundFailure: (() => {
        const failed = item.money === 'failed' ? lineOf(item.moneyLogId) : null;
        return failed?.failure ? { code: failed.failure, text: failed.failureText } : null;
      })(),
      refusedCode: item.refusedCode,
    })),
  };
}
