import type { Prisma, ReturnStatus } from '@prisma/client';

import { shopSettings } from '@config/shopSettings.js';
import { expiredUnitsOf } from '@db/expiredStock.helper.js';
import { variantNamesOf, type VariantNameInfo } from '@db/variantNames.helper.js';

import { deliveryPriceOf, deliveryQuotesOf } from '@helpers/deliveryPrice.js';
import { holdsOf, type OrderHoldReason } from '@helpers/orderHolds.js';
import { returnCodeOf } from '@helpers/returns.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { readProductWithdrawals } from '@db/productWithdrawal.helper.js';
import { withdrawalOf, withdrawalRightOf, type WithdrawalRuleName } from '@helpers/withdrawal.js';
import { withdrawalEndsOf, withdrawalOpenOf } from './withdrawal.helper.js';
import { unitsHeldOf } from './withdrawalItems.helper.js';
import { shipmentCostsOf } from './shipment.helper.js';
import {
  isVariantVisible,
  variantRowSelect,
  variantShortOf,
} from '@routes/api/products/services/helpers/variant.helper.js';
import {
  movementOf,
  readReturnMoneyLines,
  sumsOf,
  type ReturnMoneyLine,
} from '@routes/api/returns/services/helpers/returnMoneyLines.helper.js';

import type {
  OrderDeliveryDto,
  OrderItemDto,
  OrderMoneyLineDto,
  OrderResponseDto,
  OrderShipmentAdminDto,
} from 'types/dto/orders.dto.js';
import type {
  BuyerReturnDto,
  BuyerReturnRefundDto,
  ReturnItemUnitsDto,
  ReturnSummaryDto,
  WithdrawableDto,
} from 'types/dto/returns.dto.js';

// what every order answer reads: the cart, the confirmation, one order, the list and the status
// change of an admin. The payment id stays internal and is not read
export const orderResponseSelect = {
  id: true,
  userId: true,
  status: true,
  confirmed: true,
  reservationExpiresAt: true,
  total: true,
  paidAt: true,
  cancelledAt: true,
  deliveredAt: true,
  // the days the order kept from the contract; their end is counted by the database
  withdrawalDays: true,
  // where the order stands as to its statements of withdrawal and return
  returnStatus: true,
  // what keeps the order from its sending, and the warning of the provider about an order already
  // sent, for the view of an admin
  holds: true,
  fraudWarnedAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    select: {
      id: true,
      productId: true,
      variantId: true,
      quantity: true,
      unitPrice: true,
      totalPrice: true,
      productName: true,
      // the rule of withdrawal kept by the item (db/05); a cart shows the rule of now instead
      withdrawal: true,

      // the product of the position, and its variant as the catalog reads it (the price, the sale,
      // the stock, the weight and the pictures of THIS variant); a query reads at most two
      // relations side by side
      product: { select: { id: true, name: true, categoryId: true, deletedAt: true } },
      variant: { select: variantRowSelect },
    },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.OrderSelect;

// where an order goes and the sends of it. The relations of one query run at once on the one
// connection of a transaction, and pg warns of a query started while another runs: so the order
// is read with its items only, and its delivery and its sends are read apart and put on it
// (withDeliveryAndSends)
export const orderDeliverySelect = {
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
  price: true,
} satisfies Prisma.OrderDeliverySelect;

export type OrderDeliveryRow = Prisma.OrderDeliveryGetPayload<{
  select: typeof orderDeliverySelect;
}>;

export const orderShipmentSelect = {
  id: true,
  carrier: true,
  trackingNumber: true,
  trackingUrl: true,
  expense: true,
  shippedAt: true,
  rolledBackAt: true,
} satisfies Prisma.OrderShipmentSelect;

// a send with what the shop paid the carrier for it: the sum of its lines in the money journal
// (the first cost and its corrections), null while none was written
export type OrderShipmentRow = Prisma.OrderShipmentGetPayload<{
  select: typeof orderShipmentSelect;
}> & { cost: number | null };

type OrderRowWithoutShipments = Prisma.OrderGetPayload<{ select: typeof orderResponseSelect }>;

// the order as the answers read it: the buyer is given the send on its way, without its cost
export type OrderResponseRow = OrderRowWithoutShipments & {
  delivery: OrderDeliveryRow | null;
  shipments: OrderShipmentRow[];
};

// the delivery and the sends of the rows, the latest send of an order first, each send with what it
// cost the shop (from the money journal): one query for each, one after the other, for all the rows
export async function withDeliveryAndSends<T extends { id: number }>(
  db: Prisma.TransactionClient,
  rows: T[],
): Promise<(T & { delivery: OrderDeliveryRow | null; shipments: OrderShipmentRow[] })[]> {
  if (rows.length === 0) return [];

  const orderIds = rows.map((row) => row.id);

  const deliveries = await db.orderDelivery.findMany({
    where: { orderId: { in: orderIds } },
    select: { ...orderDeliverySelect, orderId: true },
  });

  const sends = await db.orderShipment.findMany({
    where: { orderId: { in: orderIds }, returnId: null },
    orderBy: [{ shippedAt: 'desc' }, { id: 'desc' }],
    select: { ...orderShipmentSelect, orderId: true },
  });

  // what the shop paid for each send: its lines money.shipping_cost and money.correction
  const costOf = await shipmentCostsOf(
    db,
    sends.map((send) => send.id),
  );

  const deliveryOf = new Map<number, OrderDeliveryRow>();
  for (const { orderId, ...delivery } of deliveries) deliveryOf.set(orderId, delivery);

  const sendsOf = new Map<number, OrderShipmentRow[]>();
  for (const { orderId, ...send } of sends) {
    sendsOf.set(orderId, [
      ...(sendsOf.get(orderId) ?? []),
      { ...send, cost: costOf.get(send.id) ?? null },
    ]);
  }

  return rows.map((row) => ({
    ...row,
    delivery: deliveryOf.get(row.id) ?? null,
    shipments: sendsOf.get(row.id) ?? [],
  }));
}

// one order as the answers read it, or null when it is not there or the context may not see it
export async function readOrderResponse(
  db: Prisma.TransactionClient,
  id: number,
): Promise<OrderResponseRow | null> {
  const row = await db.order.findUnique({ where: { id }, select: orderResponseSelect });
  if (!row) return null;

  const [full] = await withDeliveryAndSends(db, [row]);
  return full;
}

// what the items of orders need besides their rows: the units of batches that are over of their
// variants, by the day of the shop the transaction carries (the free units of an item leave them
// out), and the names the variants have now, for the items that do not carry a name of the
// confirmation, the rule of withdrawal of the products of the items that are not confirmed yet (a
// confirmed item keeps its own), and the end of the period of withdrawal of each delivered order
export type OrderContext = {
  expired: Map<number, number>;
  names: Map<number, VariantNameInfo>;
  rules: Map<number, WithdrawalRuleName>;
  withdrawalEnds: Map<number, Date>;
  // the end of the period of the contract, without the grace of the shop: the date the buyer is told
  withdrawalDeadlines: Map<number, Date>;
  // the statements of each order that has any, for the view of an admin
  returns: Map<number, ReturnSummaryDto[]>;
  // what the statements did to the items of each order that has any, for the view of an admin:
  // the units of each item and the money that went back, in cents
  returnUnits: Map<number, { items: Map<number, ReturnItemUnitsDto>; refundedCents: number }>;
  // the same statements with their path and money, for the view of the buyer
  withdrawals: Map<number, BuyerReturnDto[]>;
  // the units of each order the buyer can still state
  withdrawable: Map<number, WithdrawableDto[]>;
  // the money of each order the money journal holds, short, the oldest first, for the view of an
  // admin
  money: Map<number, OrderMoneyLineDto[]>;
};

export async function orderContextOf(
  db: Prisma.TransactionClient,
  rows: {
    id: number;
    status: string;
    confirmed: boolean;
    deliveredAt: Date | null;
    withdrawalDays: number | null;
    returnStatus: ReturnStatus;
    items: {
      id: number;
      quantity: number;
      withdrawal: WithdrawalRuleName;
      productId: number;
      variantId: number;
      productName: string | null;
    }[];
  }[],
  // who reads: an admin needs the summaries of the statements, the buyer their path and what they can
  // still state; each view reads only its own
  view: 'buyer' | 'admin' = 'buyer',
): Promise<OrderContext> {
  const expired = await expiredUnitsOf(
    db,
    rows.flatMap((row) => row.items.map((item) => item.variantId)),
  );
  // the name of a confirmed item is its copy; every other item shows the name of now
  const names = await variantNamesOf(
    db,
    rows.flatMap((row) =>
      row.items
        .filter((item) => !(row.confirmed && item.productName))
        .map((item) => item.variantId),
    ),
  );

  // the rule of now for the items of an order that is not confirmed
  const rules = new Map<number, WithdrawalRuleName>();
  const live = await readProductWithdrawals(
    db,
    rows.filter((row) => !row.confirmed).flatMap((row) => row.items.map((item) => item.productId)),
  );
  for (const [productId, row] of live) rules.set(productId, row.rule);

  const withdrawalEnds = await withdrawalEndsOf(db, rows);
  const withdrawalDeadlines = await withdrawalEndsOf(db, rows, 0);

  // the statements of the orders that have any
  const returns = new Map<number, ReturnSummaryDto[]>();
  const returnUnits: OrderContext['returnUnits'] = new Map();
  const withReturns = rows.filter((row) => row.returnStatus !== 'none').map((row) => row.id);
  if (view === 'admin' && withReturns.length) {
    const found = await db.orderReturn.findMany({
      where: { orderId: { in: withReturns } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        orderId: true,
        number: true,
        statedAt: true,
        source: true,
        basis: true,
        reason: true,
        extendsId: true,
        closedAt: true,
        refundedTotal: true,
      },
    });
    for (const { orderId, number, statedAt, closedAt, refundedTotal, ...rest } of found) {
      // the money the statements gave back, counted by the database from the money journal
      const order = returnUnits.get(orderId) ?? { items: new Map(), refundedCents: 0 };
      order.refundedCents += centsOf(refundedTotal);
      returnUnits.set(orderId, order);
      returns.set(orderId, [
        ...(returns.get(orderId) ?? []),
        {
          ...rest,
          code: returnCodeOf(rest.basis, orderId, number),
          statedAt: statedAt.toISOString(),
          closedAt: closedAt?.toISOString() ?? null,
        },
      ]);
    }

    // the rows of those statements, for what they did to each item (6.3)
    const statementOf = new Map(found.map((statement) => [statement.id, statement.orderId]));
    const lines = await db.orderReturnItem.findMany({
      where: { returnId: { in: found.map((statement) => statement.id) } },
      orderBy: { id: 'asc' },
      select: {
        returnId: true,
        orderItemId: true,
        quantity: true,
        goods: true,
        money: true,
      },
    });
    for (const line of lines) {
      const orderId = statementOf.get(line.returnId)!;
      const order = returnUnits.get(orderId) ?? { items: new Map(), refundedCents: 0 };
      const item = order.items.get(line.orderItemId) ?? {
        orderItemId: line.orderItemId,
        quantity: rows
          .find((row) => row.id === orderId)!
          .items.find((orderItem) => orderItem.id === line.orderItemId)!.quantity,
        refunded: 0,
        refused: 0,
        waiting: 0,
        withShop: 0,
        toShip: 0,
      };
      if (line.money === 'refunded') item.refunded += line.quantity;
      else if (line.money === 'refused') item.refused += line.quantity;
      else item.waiting += line.quantity;
      if (line.goods === 'to_stock' || line.goods === 'written_off' || line.goods === 'lost') {
        item.withShop += line.quantity;
      }
      item.toShip = item.quantity - item.withShop;
      order.items.set(line.orderItemId, item);
      returnUnits.set(orderId, order);
    }
  }

  const { withdrawals, withdrawable } =
    view === 'buyer'
      ? await buyerReturnsOf(db, rows, withdrawalEnds)
      : { withdrawals: new Map(), withdrawable: new Map() };

  const money = view === 'admin' ? await orderMoneyOf(db, rows) : new Map();

  return {
    expired,
    names,
    rules,
    withdrawalEnds,
    withdrawalDeadlines,
    returns,
    returnUnits,
    withdrawals,
    withdrawable,
    money,
  };
}

// the money of the orders, a line of the money journal at a time, the oldest first: every movement
// that names the order (its payment, the refunds, the money of its statements, a late payment, the
// money of a dispute, what the shop paid the carriers), short; the whole lines are the money journal
// of the admins (GET /api/admin/money-log?orderId=)
async function orderMoneyOf(
  db: Prisma.TransactionClient,
  rows: { id: number }[],
): Promise<Map<number, OrderMoneyLineDto[]>> {
  const money = new Map<number, OrderMoneyLineDto[]>();
  if (rows.length === 0) return money;

  const lines = await db.moneyLog.findMany({
    where: { orderId: { in: rows.map((row) => row.id) } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      orderId: true,
      event: true,
      purpose: true,
      part: true,
      amount: true,
      state: true,
      createdAt: true,
    },
  });
  for (const { orderId, amount, createdAt, ...line } of lines) {
    money.set(orderId!, [
      ...(money.get(orderId!) ?? []),
      { ...line, amount: decimalToNumber(amount), createdAt: createdAt.toISOString() },
    ]);
  }

  return money;
}

// when the money of a line went: a refund when it was told sent (asked, when it is still on its
// way), money sent outside the app on the day it really went
function sentAtOf(line: ReturnMoneyLine | null): string | null {
  if (!line) return null;
  if (line.event === 'money.outside') return (line.happenedAt ?? line.createdAt).toISOString();
  return (line.state === 'sent' ? (line.stateAt ?? line.createdAt) : line.createdAt).toISOString();
}

// the money a statement sent back, a movement at a time as the buyer sees it: a transfer to the
// way they paid (each a key, in its parts) and money root sent outside the app; what went back,
// what was kept for the way back, and where it stands. A transfer that money already sent covered
// (a refund made by hand in the dashboard of the provider tied to the statement) did not reach the
// buyer when that money failed later; root sends it another way then, on the refund itself
// (money.outside of the refund made by hand, tied to the statement)
function buyerRefundsOf(lines: ReturnMoneyLine[]): BuyerReturnRefundDto[] {
  const failureOf = (lineId: number | null) =>
    lines.find((one) => one.event === 'money.refund_failed' && one.coversId === lineId);

  return lines
    .filter(
      (line) =>
        (line.purpose === 'return' &&
          (line.event === 'money.refund' || line.event === 'money.outside') &&
          (line.part === 'goods' ||
            // the way back the shop paid alone, outside the app
            (line.part === 'way_back' &&
              !movementOf(lines, line).some((one) => one.part === 'goods')))) ||
        (line.event === 'money.outside' && line.purpose !== 'return'),
    )
    .map((goods) => {
      if (goods.purpose !== 'return') {
        // money root sent another way in place of a refund made by hand that failed: all of it
        // gives back what the refund gave
        const sent = -goods.amount;
        return {
          way: 'outside',
          method: goods.method,
          state: 'sent',
          goods: sent,
          delivery: 0,
          deduction: 0,
          wayBack: 0,
          amount: sent,
          at: sentAtOf(goods)!,
          bankReference: null,
        };
      }

      const movement = movementOf(lines, goods);
      const sums = sumsOf(movement);
      const failure =
        failureOf(goods.id) ??
        movement
          .filter((one) => one.part === 'covered')
          .map((one) => failureOf(one.coversId))
          .find((one) => one !== undefined);
      const outside = goods.event === 'money.outside';
      const state = failure ? 'failed' : outside ? 'sent' : (goods.state ?? 'in_transit');

      return {
        way: outside ? 'outside' : 'payment',
        method: goods.method,
        state,
        goods: sums.goods,
        delivery: sums.delivery,
        deduction: sums.deduction,
        wayBack: sums.wayBack,
        amount: sums.total,
        at: failure ? failure.createdAt.toISOString() : sentAtOf(goods)!,
        bankReference: outside ? null : goods.bankReference,
      };
    });
}

// the statements of the orders as their buyer sees them, and the units each order still lets them
// state: what an item bought less what the statements that were not refused hold, for the items
// that have the right of withdrawal, while the order can be withdrawn from
export async function buyerReturnsOf(
  db: Prisma.TransactionClient,
  rows: {
    id: number;
    status: string;
    deliveredAt: Date | null;
    returnStatus: ReturnStatus;
    items: { id: number; quantity: number; withdrawal: WithdrawalRuleName }[];
  }[],
  withdrawalEnds: Map<number, Date>,
): Promise<{
  withdrawals: Map<number, BuyerReturnDto[]>;
  withdrawable: Map<number, WithdrawableDto[]>;
}> {
  const withdrawals = new Map<number, BuyerReturnDto[]>();
  const withdrawable = new Map<number, WithdrawableDto[]>();

  // the statements, then their rows: a query reads at most two relations side by side
  const withStatements = rows.filter((row) => row.returnStatus !== 'none').map((row) => row.id);
  if (withStatements.length) {
    const statements = await db.orderReturn.findMany({
      where: { orderId: { in: withStatements } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        orderId: true,
        number: true,
        statedAt: true,
        source: true,
        basis: true,
        reason: true,
        closedAt: true,
        refundedTotal: true,
      },
    });
    // the parcels of the statements: the one the goods went back to the shop in, the ones the shop
    // sent the goods it did not accept back in
    const parcels = await db.orderShipment.findMany({
      where: { returnId: { in: statements.map((statement) => statement.id) } },
      orderBy: { id: 'asc' },
      select: {
        returnId: true,
        direction: true,
        carrier: true,
        trackingNumber: true,
        trackingUrl: true,
        shippedAt: true,
        confirmedAt: true,
        buyerPaid: true,
      },
    });
    const lines = await db.orderReturnItem.findMany({
      where: { returnId: { in: statements.map((statement) => statement.id) } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        returnId: true,
        orderItemId: true,
        quantity: true,
        amount: true,
        money: true,
        moneyLogId: true,
        goods: true,
        notAcceptedReason: true,
      },
    });
    // what the money of the statements did: the lines of the money journal of the buyer
    const moneyLines = await readReturnMoneyLines(
      db,
      statements.map((statement) => statement.id),
    );

    for (const statement of statements) {
      const own = parcels.filter((parcel) => parcel.returnId === statement.id);
      const back = own.find((parcel) => parcel.direction === 'to_shop');
      const step: BuyerReturnDto['step'] = statement.closedAt
        ? 'closed'
        : back?.confirmedAt
          ? 'proof_confirmed'
          : back
            ? 'proof_provided'
            : 'received';

      const money = moneyLines.get(statement.id) ?? [];
      const lineOf = (id: number | null) => money.find((one) => one.id === id) ?? null;

      const dto: BuyerReturnDto = {
        id: statement.id,
        code: returnCodeOf(statement.basis, statement.orderId, statement.number),
        statedAt: statement.statedAt.toISOString(),
        source: statement.source,
        basis: statement.basis,
        reason: statement.reason,
        step,
        closedAt: statement.closedAt?.toISOString() ?? null,
        parcels: own.map((parcel) => ({
          direction: parcel.direction,
          carrier: parcel.carrier,
          trackingNumber: parcel.trackingNumber,
          trackingUrl: parcel.trackingUrl,
          shippedAt: parcel.shippedAt.toISOString(),
          confirmed: parcel.confirmedAt !== null,
          buyerPaid: parcel.buyerPaid === null ? null : decimalToNumber(parcel.buyerPaid),
        })),
        refundedTotal: decimalToNumber(statement.refundedTotal),
        refunds: buyerRefundsOf(money),
        items: lines
          .filter((line) => line.returnId === statement.id)
          .map((line) => ({
            id: line.id,
            orderItemId: line.orderItemId,
            quantity: line.quantity,
            amount: decimalToNumber(line.amount),
            money: line.money,
            refundedAt: line.money === 'refunded' ? sentAtOf(lineOf(line.moneyLogId)) : null,
            refusal:
              line.money !== 'refused'
                ? null
                : line.goods === 'not_arrived'
                  ? 'not_arrived'
                  : line.notAcceptedReason,
          })),
      };
      withdrawals.set(statement.orderId, [...(withdrawals.get(statement.orderId) ?? []), dto]);
    }
  }

  // the units still free: the order can be withdrawn from (a paid or shipped one, a delivered one
  // until the end of its period), and the item has the right; the units of an open statement of the
  // form without the code are free to the buyer, their statement takes them over
  const open = rows.filter((row) =>
    withdrawalOpenOf(row.status, withdrawalEnds.get(row.id), Date.now()),
  );
  const items = open.flatMap((row) =>
    row.items.filter((item) => withdrawalRightOf(item.withdrawal) !== 'none'),
  );
  if (items.length) {
    const taken = await unitsHeldOf(
      db,
      items.map((item) => item.id),
      true,
    );

    for (const row of open) {
      const free = row.items
        .filter((item) => withdrawalRightOf(item.withdrawal) !== 'none')
        .map((item) => ({
          orderItemId: item.id,
          quantity: item.quantity - (taken.get(item.id) ?? 0),
        }))
        .filter((one) => one.quantity > 0);
      withdrawable.set(row.id, free);
    }
  }

  return { withdrawals, withdrawable };
}

// the orders the buyer has not paid yet: the price of their variants is still the one of now
const UNPAID_STATUSES = new Set(['pending', 'unconfirmed', 'waiting']);

// what the items of the row cost, to the cent
const itemsTotalOf = (row: OrderResponseRow): number =>
  row.items.reduce((sum, item) => sum + Math.round(decimalToNumber(item.totalPrice) * 100), 0) /
  100;

// where and to whom the row goes. The price is the one fixed at the confirmation; an order that is
// not confirmed has none yet, it shows the price of now. The buyer is given the send on its way,
// the one that was not rolled back, once the order is shipped
function mapDelivery(row: OrderResponseRow, itemsTotal: number): OrderDeliveryDto | null {
  const d = row.delivery;
  if (!d) return null;

  const onItsWay = row.shipments.find((s) => s.rolledBackAt === null);
  const sent = row.status === 'shipped' || row.status === 'delivered';

  return {
    method: d.method,
    price: row.confirmed ? decimalToNumber(d.price) : deliveryPriceOf(d.method, itemsTotal),
    recipient: {
      firstName: d.recipientFirstName,
      lastName: d.recipientLastName,
      phone: d.recipientPhone,
    },
    address:
      d.method === 'manual' && d.country && d.city && d.street && d.house
        ? {
            country: d.country,
            postalCode: d.postalCode,
            city: d.city,
            street: d.street,
            house: d.house,
            apartment: d.apartment,
          }
        : null,
    note: d.note,
    pickup:
      d.method === 'pickup'
        ? { address: shopSettings().pickupAddress, hours: shopSettings().pickupHours }
        : null,
    shipment:
      sent && d.method === 'manual' && onItsWay
        ? {
            carrier: onItsWay.carrier,
            trackingNumber: onItsWay.trackingNumber,
            trackingUrl: onItsWay.trackingUrl,
          }
        : null,
  };
}

const mapShipments = (row: OrderResponseRow): OrderShipmentAdminDto[] =>
  row.shipments.map((s) => ({
    id: s.id,
    carrier: s.carrier,
    trackingNumber: s.trackingNumber,
    trackingUrl: s.trackingUrl,
    cost: s.cost,
    expense: s.expense,
    shippedAt: s.shippedAt,
    rolledBackAt: s.rolledBackAt,
  }));

// what the order weighs: the variants that have a weight add up to it (the weight of one times the
// units ordered), and it is whole only when every variant has one
const weightOf = (row: OrderResponseRow) => ({
  grams: row.items.reduce((sum, item) => sum + (item.variant.weightGrams ?? 0) * item.quantity, 0),
  complete: row.items.every((item) => item.variant.weightGrams !== null),
});

// a position of the order as the answers show it: the product, and the variant that was bought.
// While the buyer has not paid, the variant shows what it sells at now (the price, the sale while
// it lasts, the name of now until the confirmation fixes it); a position of a paid order shows the
// copies of the confirmation, the name and the price it was bought at, and no sale. A variant a
// buyer does not see any more (taken out of sale, its product removed, its pictures taken away)
// stays in an order that is confirmed and says so with forSale: false
function mapItem(
  row: OrderResponseRow,
  it: OrderResponseRow['items'][number],
  context: OrderContext,
  unpaid: boolean,
): OrderItemDto {
  // an item that keeps its name needs none of now
  const named = context.names.get(it.variantId) ?? {
    name: it.productName ?? it.product.name,
    values: [],
  };
  const live = variantShortOf(
    it.variant,
    {
      expired: context.expired,
      names: new Map([[it.variantId, named]]),
      costs: new Map(),
      attributes: new Map(),
    },
    'buyer',
  );
  const forSale = isVariantVisible(it.variant) && it.product.deletedAt === null;

  // the name kept at the confirmation; a cart and an unconfirmed order follow the variant, an item
  // from before the name was kept shows the name of now
  const name = (row.confirmed && it.productName) || live.name;
  const unitPrice = decimalToNumber(it.unitPrice);

  return {
    // order item id, cart item routes take it as itemId
    id: it.id,
    product: {
      id: it.product.id as any,
      name: it.product.name,
      categoryId: it.product.categoryId as any,
    },
    variant: unpaid
      ? {
          id: live.id,
          position: live.position,
          name,
          price: live.price,
          ...(live.salePrice !== undefined ? { salePrice: live.salePrice } : {}),
          ...(live.saleEndsAt !== undefined ? { saleEndsAt: live.saleEndsAt } : {}),
          ...(live.salePriorPrice !== undefined ? { salePriorPrice: live.salePriorPrice } : {}),
          stock: live.stock,
          image: live.image,
          forSale,
        }
      : {
          id: live.id,
          position: live.position,
          name,
          price: unitPrice,
          stock: live.stock,
          image: live.image,
          forSale,
        },
    quantity: it.quantity,
    unitPrice,
    totalPrice: decimalToNumber(it.totalPrice),
    // a confirmed item keeps the rule of its confirmation, a cart shows the rule of now
    withdrawal: withdrawalOf(
      row.confirmed ? it.withdrawal : (context.rules.get(it.productId) ?? it.withdrawal),
    ),
  };
}

// cents of a sum without float math
const centsOf = (value: Prisma.Decimal) => Math.round(decimalToNumber(value) * 100);

// what the statements of an order did to its items, the items in the order of the order, and the
// money that went back with what the order is worth after it; none for an order without statements
function returnUnitsOf(row: OrderResponseRow, context: OrderContext) {
  const units = context.returnUnits.get(row.id);
  if (!units) return {};

  const totalCents = centsOf(row.total);
  return {
    returnUnits: {
      items: row.items
        .map((item) => units.items.get(item.id))
        .filter((item): item is ReturnItemUnitsDto => item !== undefined),
      refundedTotal: units.refundedCents / 100,
      netTotal: (totalCents - units.refundedCents) / 100,
    },
  };
}

// the holds the buyer is told of as a check of the payment: an early warning of fraud of the network
// of the card, a review of the payment provider
const PAYMENT_CHECKS: ReadonlySet<OrderHoldReason> = new Set(['fraud_warning', 'payment_review']);

// the admin and the root see the sends of an order with what the shop pays for them and what it
// weighs; the buyer does not
export type OrderView = 'buyer' | 'admin';

export function mapOrderRowToResponse(
  row: OrderResponseRow,
  context: OrderContext,
  view: OrderView = 'buyer',
): OrderResponseDto {
  const unpaid = UNPAID_STATUSES.has(row.status);
  const itemsTotal = itemsTotalOf(row);
  const delivery = mapDelivery(row, itemsTotal);
  // the period starts with the delivery: an order that is not delivered has no end
  // the end the server keeps, with the grace of the shop, opens the button; the buyer is told the end
  // of the contract
  const withdrawalEndsAt = row.deliveredAt ? context.withdrawalEnds.get(row.id) : undefined;
  const withdrawalDeadline = row.deliveredAt ? context.withdrawalDeadlines.get(row.id) : undefined;

  return {
    id: row.id as any,
    userId: row.userId as any,
    status: row.status,
    confirmed: row.confirmed,
    itemsTotal,
    // what the buyer pays: the total the database holds once the order is confirmed (the items and
    // the delivery fixed then), before that the items and the delivery of now
    total: row.confirmed
      ? decimalToNumber(row.total)
      : Math.round((itemsTotal + (delivery?.price ?? 0)) * 100) / 100,
    delivery,
    items: row.items.map((it) => mapItem(row, it, context, unpaid)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // a field the order does not have yet is left out
    ...(row.reservationExpiresAt ? { reservationExpiresAt: row.reservationExpiresAt } : {}),
    ...(row.paidAt ? { paidAt: row.paidAt } : {}),
    ...(row.cancelledAt ? { cancelledAt: row.cancelledAt } : {}),
    ...(row.deliveredAt ? { deliveredAt: row.deliveredAt } : {}),
    ...(withdrawalDeadline ? { withdrawalEndsAt: withdrawalDeadline } : {}),
    withdrawalOpen: withdrawalOpenOf(row.status, withdrawalEndsAt, Date.now()),
    returnStatus: row.returnStatus,
    // an order that is not confirmed: what each method of the shop would cost now
    ...(row.confirmed ? {} : { deliveryQuotes: deliveryQuotesOf(itemsTotal) }),
    ...(view === 'admin'
      ? {
          shipments: mapShipments(row),
          weight: weightOf(row),
          returns: context.returns.get(row.id) ?? [],
          ...returnUnitsOf(row, context),
          // what keeps the order from its sending, the warning of the provider about an order
          // already sent (left out while there is none), and the money of the order
          holds: holdsOf(row.holds),
          ...(row.fraudWarnedAt ? { fraudWarnedAt: row.fraudWarnedAt } : {}),
          money: context.money.get(row.id) ?? [],
        }
      : {
          withdrawals: context.withdrawals.get(row.id) ?? [],
          withdrawable: context.withdrawable.get(row.id) ?? [],
          // the payment is checked: never which check (a warning of fraud can be wrong)
          paymentCheck: holdsOf(row.holds).some((hold) => PAYMENT_CHECKS.has(hold.reason)),
        }),
  };
}
