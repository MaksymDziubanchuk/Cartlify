import type { Prisma } from '@prisma/client';

import { returnCodeOf } from '@helpers/returns.js';
import { HIDDEN_ID, hiddenText } from '@helpers/rootHidden.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { itemNameOf } from '@routes/api/orders/services/helpers/itemName.helper.js';

import type { ReturnDto, ReturnPersonDto } from 'types/dto/returns.dto.js';
import type { Role } from 'types/user.js';

type Db = Prisma.TransactionClient;

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

// cents without float math
const cents = (value: number) => Math.round(value * 100);

// the card of a statement for an admin (6.2): the statement, its rows, the order it stands on with
// its buyer and recipient, the people it names and what was done with it, from the journal of the
// admins. Root, as the journals show it, is hidden from an admin. A query of a transaction reads at
// most two relations beside its row, so the parts are read apart, one after the other; null when
// the statement is not there
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
      proofProvidedAt: true,
      proofCarrier: true,
      proofTrackingNumber: true,
      proofTrackingUrl: true,
      proofConfirmedAt: true,
      proofConfirmedById: true,
      acceptedAt: true,
      acceptedById: true,
      closedAt: true,
      closedById: true,
      closeCode: true,
      closeNote: true,
      shippingReimbursed: true,
      shippingReimbursedAt: true,
      shippingReimbursedMethod: true,
      shippingReimbursedNote: true,
      shippingReimbursedById: true,
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
      deliveryShare: true,
      shippingDeduction: true,
      refundId: true,
      refundedAt: true,
      refundFailure: true,
      refundFailureText: true,
      outsideMethod: true,
      outsideNote: true,
      outsideById: true,
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
      status: true,
      returnStatus: true,
      returnShippingPaidBy: true,
      userId: true,
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
      meta: { array_contains: [{ field: 'returnId', new: returnId }] },
    },
    orderBy: { id: 'asc' },
    select: { id: true, createdAt: true, event: true, actorId: true, actorRole: true, meta: true },
  });

  const parcels = await db.returnShipment.findMany({
    where: { returnId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      carrier: true,
      trackingNumber: true,
      trackingUrl: true,
      cost: true,
      shippedAt: true,
      recordedById: true,
      createdAt: true,
    },
  });

  const personIds = [
    ...new Set(
      [
        order?.userId ?? null,
        ...history.map((line) => line.actorId),
        row.createdById,
        row.proofConfirmedById,
        row.acceptedById,
        row.closedById,
        row.shippingReimbursedById,
        ...rows.map((item) => item.goodsSetById),
        ...rows.map((item) => item.outsideById),
        ...parcels.map((parcel) => parcel.recordedById),
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

  // the way back the next transfer may still take off: the cost of the parcels less what the rows
  // whose money went (or is on its way) took, in cents; begin_return_refund holds the same bound
  const parcelsCost = parcels.reduce(
    (sum, parcel) => sum + (parcel.cost === null ? 0 : cents(decimalToNumber(parcel.cost))),
    0,
  );
  const deducted = rows
    .filter((item) => item.money !== 'not_refunded')
    .reduce((sum, item) => sum + cents(decimalToNumber(item.shippingDeduction)), 0);
  const deductible =
    row.basis === 'withdrawal' &&
    order?.returnShippingPaidBy === 'buyer' &&
    rows.some((item) => item.money === 'not_refunded')
      ? Math.max(0, parcelsCost - deducted) / 100
      : 0;

  return {
    id: row.id,
    code: returnCodeOf(row.basis, row.orderId, row.number),
    orderId: row.orderId,
    extendsId: row.extendsId,
    statedAt: row.statedAt.toISOString(),
    source: row.source,
    basis: row.basis,
    reason: row.reason,
    description: row.description,
    contact: { name: row.contactName, email: row.contactEmail },
    createdBy: personOf(row.createdById),
    ip: row.ip,
    userAgent: row.userAgent,
    proof: {
      providedAt: iso(row.proofProvidedAt),
      carrier: row.proofCarrier,
      trackingNumber: row.proofTrackingNumber,
      trackingUrl: row.proofTrackingUrl,
      confirmedAt: iso(row.proofConfirmedAt),
      confirmedBy: personOf(row.proofConfirmedById),
    },
    acceptedAt: iso(row.acceptedAt),
    acceptedBy: personOf(row.acceptedById),
    closedAt: iso(row.closedAt),
    closedBy: personOf(row.closedById),
    closeCode: row.closeCode,
    closeNote: row.closeNote,
    shippingReimbursement:
      row.shippingReimbursed !== null &&
      row.shippingReimbursedAt !== null &&
      row.shippingReimbursedMethod !== null
        ? {
            amount: decimalToNumber(row.shippingReimbursed),
            at: row.shippingReimbursedAt.toISOString(),
            method: row.shippingReimbursedMethod,
            note: row.shippingReimbursedNote ?? '',
            by: personOf(row.shippingReimbursedById),
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    shipments: parcels.map((parcel) => ({
      id: parcel.id,
      carrier: parcel.carrier,
      trackingNumber: parcel.trackingNumber,
      trackingUrl: parcel.trackingUrl,
      cost: parcel.cost === null ? null : decimalToNumber(parcel.cost),
      shippedAt: parcel.shippedAt.toISOString(),
      recordedBy: personOf(parcel.recordedById),
      createdAt: parcel.createdAt.toISOString(),
    })),
    deductible,
    warnings: parcels.length ? ['shop_paid_parcel'] : [],
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
      amountNote: item.amountNote,
      deliveryShare: decimalToNumber(item.deliveryShare),
      shippingDeduction: decimalToNumber(item.shippingDeduction),
      goodsSetAt: iso(item.goodsSetAt),
      goodsSetBy: personOf(item.goodsSetById),
      refundId: item.refundId,
      refundedAt: iso(item.refundedAt),
      refundFailure: item.refundFailure
        ? { code: item.refundFailure, text: item.refundFailureText }
        : null,
      outside:
        item.outsideMethod && item.outsideNote !== null
          ? {
              method: item.outsideMethod,
              note: item.outsideNote,
              by: personOf(item.outsideById),
            }
          : null,
      refusedCode: item.refusedCode,
    })),
  };
}
