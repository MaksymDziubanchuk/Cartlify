import { Prisma, type ParcelState } from '@prisma/client';

// The orders whose parcels of the delivery provider wait for an admin (decisions 13 to 22 of the
// delivery): the one place of each rule, a condition on an order t. The alerts count their cases with
// it (alerts.service.ts) and the desk of the orders lists them with it (the filter parcels of GET
// /api/orders), so the count of an alert is the total of its list:
// not_collected - a parcel made and not taken by the carrier (made before a time, the threshold);
// void_pending - a parcel that waits for its void (the carrier cannot be asked, or the provider did
//   not answer): the admin cancels it in the dashboard of the carrier and confirms;
// coming_back - a parcel going back to the shop or back at it, with units no statement holds: the
//   admin tells the refusal, or waits for it to be back;
// lost - a parcel the carrier lost, with units no statement holds: the admin opens a statement;
// ahead - parcels ahead of their order: a cancelled order a parcel of went to the buyer after the
//   cancel, a paid order something holds the carrier took a parcel of, a paid order the carrier has
//   every live parcel of and that is still not shipped (a unit left in no parcel), a sent order
//   with an open refusal a parcel of which was delivered after all (the refusal may be none);
// none - a paid order of the carrier with no live parcel yet: a filter of the desk only, no alert,
//   and a condition of the list itself (getOrders.helper.ts), since the paid orders may be many.

export const PARCEL_CASES = [
  'not_collected',
  'void_pending',
  'coming_back',
  'lost',
  'ahead',
  'none',
] as const;

export type ParcelCase = (typeof PARCEL_CASES)[number];

// the cases the alerts count: their orders are few, read by their ids
export type ParcelAlertCase = Exclude<ParcelCase, 'none'>;

// the states of a parcel the carrier has or had
const TAKEN: ParcelState[] = ['sent', 'delivered', 'returning', 'returned', 'lost'];

const utcTime = (date: Date) => Prisma.sql`(${date.toISOString()}::timestamptz at time zone 'UTC')`;

// a parcel s to the buyer of the order t, not taken back with a step back, in one of the states
const parcelIn = (states: ParcelState[], more: Prisma.Sql = Prisma.empty) => Prisma.sql`exists (
    select 1 from cartlify.order_shipments as s
    where s."orderId" = t.id and s."returnId" is null
      and s.direction = 'to_buyer'::cartlify."ShipmentDirection" and s."rolledBackAt" is null
      and s.state = any(${states}::cartlify."ParcelState"[]) ${more}
  )`;

// a unit in the boxes of the parcel s that no statement holds (a row whose money was refused gives
// its units back)
const UNITS_UNSTATED = Prisma.sql`and exists (
    select 1
    from cartlify.shipment_boxes as b
    cross join lateral jsonb_array_elements(b.items) as e
    where b."shipmentId" = s.id
      and (e.value ->> 'quantity')::int > (
        select coalesce(sum(i.quantity), 0)
        from cartlify.return_items as i
        where i."orderItemId" = (e.value ->> 'orderItemId')::int
          and i.money <> 'refused'::cartlify."ReturnMoney"
      )
  )`;

// the condition of a case on the order t; madeBefore narrows not_collected to the parcels made
// before the time
export function parcelCaseSql(kind: ParcelAlertCase, madeBefore?: Date): Prisma.Sql {
  switch (kind) {
    case 'not_collected':
      return parcelIn(
        ['created'],
        madeBefore ? Prisma.sql`and s."createdAt" < ${utcTime(madeBefore)}` : Prisma.empty,
      );
    case 'void_pending':
      return parcelIn(['void_pending']);
    case 'coming_back':
      return parcelIn(['returning', 'returned'], UNITS_UNSTATED);
    case 'lost':
      return parcelIn(['lost'], UNITS_UNSTATED);
    case 'ahead':
      return Prisma.sql`(
        (t.status = 'cancelled'::cartlify."OrderStatus"
          and ${parcelIn(['sent', 'delivered'], Prisma.sql`and s."updatedAt" > t."cancelledAt"`)})
        or (t.status = 'paid'::cartlify."OrderStatus"
          and ${parcelIn(TAKEN)}
          and (t.holds <> '[]'::jsonb or not ${parcelIn(['created'])}))
        or (t.status = 'shipped'::cartlify."OrderStatus"
          and ${parcelIn(['delivered'])}
          and not ${parcelIn(['sent', 'returning', 'returned'])}
          and exists (
            select 1 from cartlify.returns as r
            where r."orderId" = t.id and r.reason = 'refused'::cartlify."ReturnReason"
              and r."closedAt" is null
          ))
      )`;
  }
}

// the states of a live parcel: made, or the carrier has or had it
export const LIVE_PARCEL_STATES: ParcelState[] = ['created', ...TAKEN];

// the ids of the orders of a case, for the filter of the list (the database narrows them first)
export async function ordersOfParcelCase(
  db: Prisma.TransactionClient,
  kind: ParcelAlertCase,
  madeBefore?: Date,
): Promise<number[]> {
  const rows = await db.$queryRaw<{ id: number }[]>(
    Prisma.sql`select t.id from cartlify.orders as t where ${parcelCaseSql(kind, madeBefore)}`,
  );
  return rows.map((row) => row.id);
}
