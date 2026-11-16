import { Prisma, type ParcelState } from '@prisma/client';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { getPgMessage, tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { failureOf } from '@helpers/failureOf.js';
import { holdReasonsOf } from '@helpers/orderHolds.js';
import { deliveryProvider, type DeliveryEvent } from '@providers/delivery/index.js';
import { ForbiddenError, ServiceUnavailableError, UnauthorizedError } from '@utils/errors.js';

import type { FastifyBaseLogger } from 'fastify';

import {
  assertLaidOut,
  itemsToSendOf,
  type BoxItem,
} from '../../orders/services/helpers/parcelItems.helper.js';
import { parcelCaseSql } from '../../orders/services/helpers/parcelCases.helper.js';
import { sendOrderStatusEmail } from '../../orders/services/helpers/sendOrderStatusEmail.helper.js';
import { sendReturnByShopEmail } from '../../returns/services/helpers/sendReturnByShopEmail.helper.js';

// What the events of the delivery provider do (decisions 9, 19, 22, 36 of the delivery): a parcel
// moves forward only (made, sent, delivered; back to the shop, back, lost), never back and never
// after its void; the order follows its live parcels: shipped when the carrier has taken every one
// and they hold every unit, delivered when every one is delivered. A parcel the database does not
// know, a repeat, an event of a voided parcel, change nothing. The creation of a parcel is
// synchronous: its own events (created, failed) repeat what the app knows. Everything runs as the
// system; the mails go after the commit. An order something holds is not moved (the parcel is, it
// is a fact): the admin is told by the alert parcels_ahead_of_order. A parcel the carrier says the
// buyer refused opens the statement of the refusal itself, with the moment of the event
// (decision 16); one that goes back without a reason, is back or is lost waits for the admin (the
// alerts parcels_coming_back and parcels_lost)

type EventLog = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

const NO_SIZES = { weightGrams: null, lengthMm: null, widthMm: null, heightMm: null };

// how far a state is: an event moves a parcel only to a state further on
// (a parcel going back that the carrier delivers after all is delivered)
const RANK: Record<ParcelState, number> = {
  created: 0,
  void_pending: 0,
  sent: 1,
  returning: 2,
  delivered: 3,
  returned: 4,
  lost: 4,
  voided: 9,
};

// the states a parcel ends in
const OVER: ParcelState[] = ['delivered', 'returned', 'lost'];

const STATE_OF: Record<Exclude<DeliveryEvent['kind'], 'created' | 'failed'>, ParcelState> = {
  collected: 'sent',
  delivered: 'delivered',
  returning: 'returning',
  returned: 'returned',
  lost: 'lost',
};

const LIVE = (one: { rolledBackAt: Date | null; state: ParcelState }) =>
  one.rolledBackAt === null && one.state !== 'void_pending' && one.state !== 'voided';

// the moment of an event as the columns keep it: utc without a zone
// now, in milliseconds as the columns keep the times: a moment of the provider ahead of the clock
// of the database is cut to it, and now() in microseconds would be rounded up when written, a
// fraction of a millisecond in the future the guards of the orders refuse (ORDER_DELIVERED_AT_INVALID)
const NOW_MS = Prisma.sql`date_trunc('milliseconds', now() at time zone 'UTC')`;

const atOf = (event: DeliveryEvent) =>
  Prisma.sql`(${event.at.toISOString()}::timestamptz at time zone 'UTC')`;

type Outcome = {
  orderId: number;
  shipped: boolean;
  delivered: boolean;
  // the moment the buyer refused the parcel, as the provider tells it
  refusedAt: Date | null;
} | null;

async function applyOne(db: Prisma.TransactionClient, event: DeliveryEvent): Promise<Outcome> {
  if (event.kind === 'created' || event.kind === 'failed') return null;

  const parcel = await db.orderShipment.findUnique({
    where: { providerParcelId: event.parcelId },
    select: { id: true, orderId: true, returnId: true, rolledBackAt: true },
  });
  // a parcel of a statement, or one a step back took back: not the events' to move
  if (!parcel || parcel.returnId !== null || parcel.rolledBackAt !== null) return null;

  // the events of an order go one after another
  await db.$queryRaw`select id from cartlify.orders where id = ${parcel.orderId} for update`;

  const next = STATE_OF[event.kind];
  const now = await db.orderShipment.findUniqueOrThrow({
    where: { id: parcel.id },
    select: { state: true },
  });
  if (RANK[next] <= RANK[now.state]) return null;

  // the moment the carrier took it: the event that tells it, or the first one after it, never of
  // the future (a clock of the provider ahead) and never before the order was paid (a date of the
  // provider that is none: the cost of the send is counted in the period of this moment); the time
  // of the change is the database's, as the times of the order it is compared with
  // (parcelCases.helper.ts)
  await db.$executeRaw`
    update cartlify.order_shipments
    set state = ${next}::cartlify."ParcelState",
      "shippedAt" = coalesce(
        "shippedAt",
        greatest(
          least(${atOf(event)}, ${NOW_MS}),
          (select o."paidAt" from cartlify.orders as o where o.id = order_shipments."orderId")
        )
      ),
      "updatedAt" = (now() at time zone 'UTC')
    where id = ${parcel.id}::int
  `;

  const refusedAt = event.kind === 'returning' && event.refused ? event.at : null;

  const moved = await followParcels(db, parcel.orderId, atOf(event));
  return { orderId: parcel.orderId, ...moved, refusedAt };
}

// The order follows its live parcels (decisions 9, 19, 22 of the delivery, 8 of its check): shipped
// when the carrier took every one and they hold every unit that travels; delivered when every one
// is over (delivered, back at the shop, lost), one at least delivered, and a statement holds the
// units of the ones that did not reach the buyer. An order something holds is not moved. at is the
// moment of the delivery
async function followParcels(
  db: Prisma.TransactionClient,
  orderId: number,
  at: Prisma.Sql,
): Promise<{ shipped: boolean; delivered: boolean }> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true, holds: true },
  });
  if (holdReasonsOf(order.holds).length) return { shipped: false, delivered: false };

  const parcels = await db.orderShipment.findMany({
    where: { orderId, returnId: null, direction: 'to_buyer' },
    select: { id: true, state: true, rolledBackAt: true },
  });
  const live = parcels.filter(LIVE);

  let shipped = false;
  let delivered = false;

  // shipped: the carrier took every live parcel and they hold every unit that travels
  if (order.status === 'paid' && live.length && live.every((one) => RANK[one.state] >= 1)) {
    const boxes = await db.shipmentBox.findMany({
      where: { shipmentId: { in: live.map((one) => one.id) } },
      select: { items: true },
    });
    let whole = true;
    try {
      assertLaidOut(
        boxes.map((box) => ({ ...NO_SIZES, items: box.items as BoxItem[] })),
        await itemsToSendOf(db, orderId),
      );
    } catch {
      whole = false;
    }
    if (whole) {
      await db.order.updateMany({
        where: { id: orderId, status: 'paid' },
        data: { status: 'shipped' },
      });
      shipped = true;
    }
  }

  // delivered: at the moment given; never of the future, and never before the send (an admin sent
  // it by hand after the carrier had it: the moment of the send), the rule of the guard of the
  // orders (db/05). An order with an open refusal stays shipped, as the guard wants
  // (ORDER_HAS_OPEN_REFUSAL): the statement waits for the goods as any. A parcel back at the shop
  // or lost with a unit no statement holds keeps the order sent too: the admin has to tell what
  // became of it first (the alerts parcels_coming_back and parcels_lost)
  const status = shipped ? 'shipped' : order.status;
  const over =
    live.length > 0 &&
    live.every((one) => OVER.includes(one.state)) &&
    live.some((one) => one.state === 'delivered');
  if (status === 'shipped' && over) {
    const moved = await db.$executeRaw`
      update cartlify.orders as t
      set status = 'delivered'::cartlify."OrderStatus",
        "deliveredAt" = greatest(
          least(${at}, ${NOW_MS}),
          coalesce(
            (
              select max(sh."shippedAt")
              from cartlify.order_shipments as sh
              where sh."orderId" = t.id and sh."returnId" is null and sh."rolledBackAt" is null
            ),
            t."paidAt"
          )
        )
      where t.id = ${orderId}::int and t.status = 'shipped'::cartlify."OrderStatus"
        and not exists (
          select 1 from cartlify.returns as r
          where r."orderId" = t.id and r.reason = 'refused'::cartlify."ReturnReason"
            and r."closedAt" is null
        )
        and not ${parcelCaseSql('coming_back')}
        and not ${parcelCaseSql('lost')}
    `;
    delivered = moved > 0;
  }

  return { shipped, delivered };
}

// Once a statement holds the units of a parcel that did not reach the buyer, the order may be
// delivered by the parcels that did: looked at again after a statement of an admin (no event of the
// carrier comes any more). The moment of the delivery is when the shop learned of the last parcel
// delivered. Nothing for an order with no parcel of the provider
export async function settleOrderByParcels(orderId: number, log: EventLog): Promise<void> {
  const moved = await tx(async (db) => {
    await setAdminContext(db);
    const parcels = await db.orderShipment.count({
      where: { orderId, returnId: null, providerParcelId: { not: null } },
    });
    if (!parcels) return null;
    await db.$queryRaw`select id from cartlify.orders where id = ${orderId} for update`;
    return followParcels(
      db,
      orderId,
      Prisma.sql`(
        select max(s."updatedAt") from cartlify.order_shipments as s
        where s."orderId" = ${orderId}::int and s."returnId" is null
          and s.state = 'delivered'::cartlify."ParcelState"
      )`,
    );
  });
  if (moved?.shipped) await sendOrderStatusEmail(orderId, 'shipped', log);
  if (moved?.delivered) await sendOrderStatusEmail(orderId, 'delivered', log);
}

// the statement of the system for a parcel the buyer refused: the units of the parcels coming back
// that no statement holds, with the moment of the event (never after the moment of the database),
// in a transaction of its own once the parcel is kept; none when a statement holds them all (the
// buyer withdrew while it was on its way). A failure is logged: the alert parcels_coming_back keeps
// the parcel before the admin. The buyer is mailed that the shop registered a return
async function statementOfRefusal(orderId: number, at: Date, log: EventLog): Promise<void> {
  let returnId: number | null;
  try {
    returnId = await tx(async (db) => {
      await setAdminContext(db);
      const order = await db.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { userId: true, status: true },
      });
      // a cancelled order takes no statement: the parcel it sent anyway is the alert's
      if (order.status !== 'paid' && order.status !== 'shipped') return null;
      // the answers go to the buyer of the order: their name, or their email when they gave none
      const buyer = await db.user.findUniqueOrThrow({
        where: { id: order.userId },
        select: { name: true, email: true },
      });
      const [made] = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
        select cartlify.create_return(
          ${orderId}::int,
          null::jsonb,
          'system'::cartlify."ReturnSource",
          'withdrawal'::cartlify."ReturnBasis",
          'refused'::cartlify."ReturnReason",
          null::text,
          ${(buyer.name?.trim() || buyer.email).slice(0, 200)}::text,
          ${buyer.email}::text,
          least(
            (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
            (now() AT TIME ZONE 'UTC')::timestamp(3)
          ),
          null::int,
          ${shopSettings().withdrawalGraceDays}::int,
          ${env.SHOP_TIME_ZONE}::text
        ) as id
      `);
      return made?.id ?? null;
    });
  } catch (err) {
    if (getPgMessage(err) === 'RETURN_ITEMS_REQUIRED') return;
    log.error({ ...failureOf(err), orderId }, 'the statement of a refused parcel was not made');
    return;
  }
  if (returnId !== null) await sendReturnByShopEmail(returnId, log);
}

// a request of the webhook: checked by the provider (its secret), its events applied one by one;
// the answer is the json body the provider waits for
export async function handleDeliveryWebhook(
  request: { headers: Readonly<Record<string, string | string[] | undefined>>; body: unknown },
  log: EventLog,
): Promise<Record<string, unknown>> {
  const check = deliveryProvider.webhook.check({ headers: request.headers });
  if (check.verdict === 'missing') throw new UnauthorizedError('DELIVERY_WEBHOOK_SECRET_MISSING');
  if (check.verdict === 'unavailable') {
    // a fault of the server: the provider tries again later
    log.warn({ reason: check.reason }, 'delivery webhook cannot be checked');
    throw new ServiceUnavailableError('DELIVERY_WEBHOOK_UNAVAILABLE');
  }
  if (check.verdict === 'invalid') {
    log.warn({ reason: check.reason }, 'delivery webhook with another secret');
    throw new ForbiddenError('DELIVERY_WEBHOOK_SECRET_INVALID');
  }

  // a body of the provider that is no event the app knows (a kind it has added, a test of the
  // webhook) is left alone and answered as taken: any other answer and it posts the body again
  const events = deliveryProvider.webhook.readEvents(request.body);
  if (events === null) {
    log.info({}, 'delivery webhook: a body that is no event was left alone');
    return { ...deliveryProvider.webhook.answer };
  }

  await applyDeliveryEvents(events, log);
  return { ...deliveryProvider.webhook.answer };
}

// the events of one request of the provider, one transaction each
export async function applyDeliveryEvents(
  events: readonly DeliveryEvent[],
  log: EventLog,
): Promise<void> {
  for (const event of events) {
    const outcome = await tx(async (db) => {
      await setAdminContext(db);
      return applyOne(db, event);
    });
    if (!outcome) continue;

    // the step is committed; a mail never undoes it, a failure is only logged
    if (outcome.shipped) await sendOrderStatusEmail(outcome.orderId, 'shipped', log);
    if (outcome.delivered) await sendOrderStatusEmail(outcome.orderId, 'delivered', log);
    if (outcome.refusedAt) await statementOfRefusal(outcome.orderId, outcome.refusedAt, log);
  }
}
