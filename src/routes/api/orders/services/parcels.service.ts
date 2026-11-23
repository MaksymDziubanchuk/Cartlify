import { taxDocumentNumberOf } from '@helpers/taxDocumentNumber.js';
import type { CustomsInvoiceMode, Prisma, Role } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { shopCountry } from '@config/shopCountries.js';
import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { customsNeededFor, productsWithoutCustomsData } from '@helpers/customs.js';
import { failureOf } from '@helpers/failureOf.js';
import { holdReasonsOf } from '@helpers/orderHolds.js';
import { senderAddressOf } from '@helpers/parcelBox.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import {
  DELIVERY_PARCEL_REFUSED,
  deliveryProvider,
  type DeliveryBox,
  type DeliveryCustomsLine,
  type DeliveryParcel,
  type DeliveryParcelRequest,
  type DeliveryTaxNumber,
} from '@providers/delivery/index.js';
import { takeRedisLock } from '@redis/lock.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';

import { carrierOptionsFor, cartForDelivery, contentsOf } from './helpers/carrierQuotes.helper.js';
import { mapOrderRowToResponse, orderContextOf, readOrderResponse } from './helpers/index.js';
import {
  assertLaidOut,
  boxDataOf,
  itemsToSendOf,
  oneBoxOf,
  type BoxData,
  type BoxItem,
  type ItemToSend,
} from './helpers/parcelItems.helper.js';
import { recordShipmentCost } from './helpers/shipment.helper.js';

import type {
  OrderCarriersDto,
  OrderResponseDto,
  ParcelsBodyDto,
  ParcelsBulkResultDto,
  ParcelsDraftDto,
  ParcelsResultDto,
} from 'types/dto/orders.dto.js';
import type { UserId } from 'types/ids.js';

// The parcels of an order of a carrier of the delivery provider, made by an admin when the goods are
// packed (decisions 4, 22, 37 of the delivery): one parcel with one box of every unit unless the
// admin lays them out otherwise, all at once; the provider makes each with its label, the app writes
// it with its boxes and what the provider priced it at as the cost of the send. The provider is
// asked outside the transactions of the database, under a lock of the order, so two admins never
// make the parcels twice; before a parcel is asked for, the provider is asked whether it made it
// already for the number of the parcel (an answer lost on the way never makes two)

// the lock lives two minutes from each parcel asked for: a parcel takes the provider seconds
const LOCK_MS = 2 * 60 * 1000;
const lockKey = (orderId: number) => `lock:orders:parcels:${orderId}`;

type Actor = { actorId: UserId; actorRole: Role };

// the order as the parcels need it, read in the context of the admin
async function parcelOrderOf(db: Prisma.TransactionClient, orderId: number) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      status: true,
      holds: true,
      paidAt: true,
      user: { select: { email: true } },
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
          carrierName: true,
          carrierService: true,
          carrierConnection: true,
        },
      },
    },
  });
  if (!order) throw new NotFoundError('ORDER_NOT_FOUND', { orderId });

  const parcels = await db.orderShipment.findMany({
    where: { orderId, returnId: null, direction: 'to_buyer' },
    orderBy: { id: 'asc' },
    select: { id: true, state: true, rolledBackAt: true, providerParcelId: true },
  });
  const live = parcels.filter(
    (one) => one.rolledBackAt === null && !['void_pending', 'voided'].includes(one.state),
  );

  // what the live parcels hold already
  const boxes = live.length
    ? await db.shipmentBox.findMany({
        where: { shipmentId: { in: live.map((one) => one.id) } },
        select: { items: true },
      })
    : [];
  const packed = new Map<number, number>();
  for (const box of boxes) {
    for (const item of box.items as BoxItem[]) {
      packed.set(item.orderItemId, (packed.get(item.orderItemId) ?? 0) + item.quantity);
    }
  }

  const items = (await itemsToSendOf(db, orderId))
    .map((item) => ({ ...item, units: item.units - (packed.get(item.orderItemId) ?? 0) }))
    .filter((item) => item.units > 0);

  const lines = await db.orderItem.findMany({
    where: { orderId },
    select: {
      id: true,
      productId: true,
      productName: true,
      quantity: true,
      unitPrice: true,
      taxRule: true,
      taxCountry: true,
      taxAmount: true,
      product: { select: { name: true, hsCode: true, originCountry: true } },
      variant: { select: { sku: true, weightGrams: true } },
    },
  });

  // the invoice of the order the commercial invoice of a parcel names
  const invoice = await db.taxDocument.findFirst({
    where: { orderId, kind: 'invoice' },
    orderBy: { id: 'asc' },
    select: { series: true, number: true, createdAt: true },
  });

  return {
    order,
    invoice,
    // every parcel of the provider the order ever had, for the number of the next one
    providerParcels: parcels.filter((one) => one.providerParcelId !== null).length,
    live,
    items,
    lineOf: new Map(lines.map((line) => [line.id, line])),
  };
}

type ParcelOrder = Awaited<ReturnType<typeof parcelOrderOf>>;

// an order the parcels can be made for: paid, of a carrier, nothing holds it, and units are left
// that no live parcel holds (the rest of an order the carrier took a parcel of already gets its
// parcels the same way)
function assertParcelsCanBeMade(read: ParcelOrder): void {
  const { order } = read;
  if (order.delivery?.method !== 'carrier') throw new ConflictError('ORDER_NOT_BY_CARRIER');
  if (order.status !== 'paid') {
    throw new ConflictError('ORDER_STATUS_NOT_ALLOWED', { status: order.status });
  }
  const holds = holdReasonsOf(order.holds);
  if (holds.length) throw new ConflictError('ORDER_ON_HOLD', { orderId: order.id, holds });
  if (!read.items.length) throw new ConflictError('PARCELS_ALREADY_MADE');
}

// a country with customs takes a parcel only with the customs data of every product in it
// (DELIVERY_CUSTOMS_DATA_MISSING, the products named): the buyer was checked at the confirmation,
// but the countries without customs and the address of the order may have changed since
function assertCustomsData(read: ParcelOrder): void {
  if (!customsNeededFor(read.order.delivery!.country)) return;
  const products = productsWithoutCustomsData(
    read.items.map((item) => {
      const line = read.lineOf.get(item.orderItemId)!;
      return {
        productId: line.productId,
        name: line.productName ?? line.product.name,
        hsCode: line.product.hsCode,
        originCountry: line.product.originCountry,
      };
    }),
  );
  if (products.length) throw new BadRequestError('DELIVERY_CUSTOMS_DATA_MISSING', { products });
}

// the boxes of a parcel hold no more of an item than the order still has to send
// (PARCEL_ITEMS_MISMATCH, as a layout that does not add up)
function assertBoxesFit(boxes: readonly BoxData[], items: readonly ItemToSend[]): void {
  const packed = new Map<number, number>();
  for (const box of boxes) {
    for (const item of box.items) {
      packed.set(item.orderItemId, (packed.get(item.orderItemId) ?? 0) + item.quantity);
    }
  }
  const unitsOf = new Map(items.map((item) => [item.orderItemId, item.units]));
  const wrong = [...packed]
    .map(([orderItemId, units]) => ({
      orderItemId,
      units: unitsOf.get(orderItemId) ?? 0,
      packed: units,
    }))
    .filter((item) => item.packed > item.units);
  if (wrong.length) throw new BadRequestError('PARCEL_ITEMS_MISMATCH', { items: wrong });
}

// the columns of a parcel take a text of the provider only when it fits them (no space, not longer
// than the column): a link or a number that does not is left out, the parcel is kept all the same
const fitting = (value: string | null | undefined, max: number): string | null =>
  value && value.length <= max && !/\s/.test(value) ? value : null;

// what the app puts in the parcels when the admin says nothing: one parcel, one box of every unit
// left, the weight and the sizes from the variants
const draftOf = (items: readonly ItemToSend[]): BoxData[][] => [[oneBoxOf(items)]];

// GET /api/orders/:orderId/parcels/draft
export async function parcelsDraft(args: Actor & { orderId: number }): Promise<ParcelsDraftDto> {
  assertStaff(args.actorRole);
  const read = await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    return parcelOrderOf(db, args.orderId);
  });
  assertParcelsCanBeMade(read);

  const d = read.order.delivery!;
  return {
    carrier: { name: d.carrierName!, service: d.carrierService!, connection: d.carrierConnection! },
    parcels: draftOf(read.items).map((boxes) => ({ boxes })),
  };
}

// GET /api/orders/:orderId/carriers: the carriers of the delivery provider for the order to its
// address now, the cheapest first, each with what it would cost the shop: the list an admin picks
// another carrier from (PATCH .../delivery takes one of them). Asked of the provider now, not from
// the five minutes kept for the buyers
export async function orderCarriers(
  args: Actor & { orderId: number },
  log: FastifyBaseLogger,
): Promise<OrderCarriersDto> {
  assertStaff(args.actorRole);
  const read = await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    const delivery = await db.orderDelivery.findUnique({
      where: { orderId: args.orderId },
      select: {
        method: true,
        country: true,
        postalCode: true,
        city: true,
        street: true,
        house: true,
        apartment: true,
      },
    });
    if (!delivery) {
      const order = await db.order.findUnique({
        where: { id: args.orderId },
        select: { id: true },
      });
      if (!order) throw new NotFoundError('ORDER_NOT_FOUND', { orderId: args.orderId });
      throw new ConflictError('ORDER_NOT_BY_CARRIER');
    }
    return { delivery, cart: await cartForDelivery(db, args.orderId) };
  });
  if (read.delivery.method !== 'carrier') throw new ConflictError('ORDER_NOT_BY_CARRIER');
  // an item without its weight or sizes: no box to price
  if (!read.cart.box) return { carriers: [] };

  const options = await carrierOptionsFor(
    {
      address: {
        country: read.delivery.country!,
        postalCode: read.delivery.postalCode,
        city: read.delivery.city!,
        street: read.delivery.street!,
        house: read.delivery.house!,
        apartment: read.delivery.apartment,
      },
      box: read.cart.box,
      lines: read.cart.lines,
      value: read.cart.itemsTotal,
    },
    log,
    { fresh: true },
  );
  return {
    carriers: options.map((one) => ({
      carrier: { name: one.carrierName, service: one.carrierService, connection: one.connection },
      label: one.label,
      days: one.days,
      price: one.price,
    })),
  };
}

const boxOfData = (box: BoxData): DeliveryBox => {
  if (
    box.weightGrams === null ||
    box.lengthMm === null ||
    box.widthMm === null ||
    box.heightMm === null
  ) {
    throw new BadRequestError('PARCEL_BOX_SIZES_REQUIRED');
  }
  return {
    weightGrams: box.weightGrams,
    lengthMm: box.lengthMm,
    widthMm: box.widthMm,
    heightMm: box.heightMm,
  };
};

// the tax number a parcel crossing customs goes with: of the country of the recipient, when the
// shop took the tax of that country on an item in it (the rule recipient at the confirmation), the
// number root wrote for the country. A country that has none now refuses the parcel
// (DELIVERY_TAX_NUMBER_MISSING): without it the buyer would pay the tax again at the border
function taxNumberOf(
  read: Pick<ParcelOrder, 'order'>,
  lines: readonly { line: { taxRule: string | null; taxCountry: string | null } }[],
): DeliveryTaxNumber | null {
  const country = read.order.delivery!.country!;
  if (!customsNeededFor(country)) return null;
  if (!lines.some(({ line }) => line.taxRule === 'recipient' && line.taxCountry === country)) {
    return null;
  }
  const record = shopCountry(country);
  if (!record?.taxNumber || !record.taxNumberKind) {
    throw new ConflictError('DELIVERY_TAX_NUMBER_MISSING', { country });
  }
  return { kind: record.taxNumberKind, number: record.taxNumber };
}

// the request of one parcel: the recipient, its boxes, what it holds and what that is worth, the
// lines of the declaration for a country with customs and the tax number it goes with
function parcelRequestOf(
  read: Pick<ParcelOrder, 'order' | 'lineOf'>,
  boxes: readonly BoxData[],
  number: number,
): DeliveryParcelRequest {
  const d = read.order.delivery!;
  const sender = senderAddressOf();
  if (!sender) throw new ConflictError('DELIVERY_SENDER_REQUIRED');

  const units = new Map<number, number>();
  for (const box of boxes) {
    for (const item of box.items) {
      units.set(item.orderItemId, (units.get(item.orderItemId) ?? 0) + item.quantity);
    }
  }
  const lines = [...units].map(([orderItemId, quantity]) => ({
    line: read.lineOf.get(orderItemId)!,
    quantity,
  }));

  const gross =
    lines.reduce(
      (sum, { line, quantity }) =>
        sum + Math.round(decimalToNumber(line.unitPrice) * 100) * quantity,
      0,
    ) / 100;
  const customs: DeliveryCustomsLine[] | null = customsNeededFor(d.country)
    ? lines.map(({ line, quantity }) => ({
        description: line.productName ?? line.product.name,
        quantity,
        unitValue: decimalToNumber(line.unitPrice),
        weightGrams: line.variant.weightGrams ?? 0,
        hsCode: line.product.hsCode ?? '',
        originCountry: line.product.originCountry ?? '',
        sku: line.variant.sku,
        // the tax of the line, for the units of this parcel
        tax: line.taxAmount
          ? Math.round((decimalToNumber(line.taxAmount) * 100 * quantity) / line.quantity) / 100
          : 0,
      }))
    : null;
  // the customs value: without the tax of the country of the recipient the shop took
  const declaredValue =
    Math.round((gross - (customs ?? []).reduce((sum, line) => sum + line.tax, 0)) * 100) / 100;

  return {
    reference: `${read.order.id}-${number}`,
    option: {
      carrierName: d.carrierName!,
      carrierService: d.carrierService!,
      connection: d.carrierConnection!,
    },
    from: sender,
    to: {
      name: `${d.recipientFirstName} ${d.recipientLastName}`.trim(),
      street: d.street!,
      house: d.house!,
      apartment: d.apartment,
      city: d.city!,
      postalCode: d.postalCode,
      country: d.country!,
      phone: d.recipientPhone,
      email: read.order.user.email,
    },
    boxes: boxes.map(boxOfData),
    contents: contentsOf(
      lines.map(({ line, quantity }) => ({
        name: line.productName ?? line.product.name,
        quantity,
      })),
    ),
    declaredValue,
    customs,
    taxNumber: taxNumberOf(read, lines),
  };
}

// the commercial invoice of a parcel with a tax number that is not of the import scheme: sent to
// the carrier with the parcel when it takes it electronically, else the admin prints it (GET
// .../customs-invoice); none for any other parcel. A carrier that refuses it electronically, or a
// provider that does not answer, leaves it to print: the parcel is kept all the same
async function customsInvoiceOf(
  read: Pick<ParcelOrder, 'order' | 'invoice'>,
  request: DeliveryParcelRequest,
  parcel: DeliveryParcel,
  log: FastifyBaseLogger,
): Promise<CustomsInvoiceMode | null> {
  if (request.taxNumber?.kind !== 'other') return null;
  try {
    if (!(await deliveryProvider.takesDocuments(request.option.carrierName))) return 'print';
    await deliveryProvider.customsInvoice(
      { ...request, parcelId: parcel.parcelId, invoice: invoiceOf(read, request) },
      true,
      log,
    );
    return 'electronic';
  } catch (err) {
    log.warn(
      { ...failureOf(err), orderId: read.order.id, parcelId: parcel.parcelId },
      'the commercial invoice of a parcel was not sent with it: the admin prints it',
    );
    return 'print';
  }
}

// the invoice a commercial invoice names: the invoice of the order, else the number of the parcel
// on the day the order was paid for (a shop that makes invoices on request)
const invoiceOf = (
  read: Pick<ParcelOrder, 'order' | 'invoice'>,
  request: Pick<DeliveryParcelRequest, 'reference'>,
): { number: string; date: Date } =>
  read.invoice?.series && read.invoice.number
    ? {
        number: taxDocumentNumberOf(read.invoice.series, read.invoice.number)!,
        date: read.invoice.createdAt,
      }
    : { number: request.reference, date: read.order.paidAt ?? new Date() };

// writes a parcel the provider made, with its boxes and its cost, in the name of the admin. The
// order may have changed while the provider made the parcel (a statement took units back or
// cancelled it, something holds it, its address or carrier was changed): it is read again under
// its lock, and a parcel that no longer suits it is not kept (the caller gives it up)
async function writeParcel(
  actor: Actor,
  orderId: number,
  parcel: DeliveryParcel & { customsInvoice: CustomsInvoiceMode | null },
  boxes: readonly BoxData[],
  carrierLabel: string,
  bulk: boolean,
  delivery: string,
  log: FastifyBaseLogger,
): Promise<number> {
  return tx(async (db) => {
    await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
    await db.$queryRaw`select id from cartlify.orders where id = ${orderId}::int for update`;
    const now = await parcelOrderOf(db, orderId);
    assertParcelsCanBeMade(now);
    if (JSON.stringify(now.order.delivery) !== delivery) {
      throw new ResourceBusyError({ reason: 'ORDER_DELIVERY_CHANGED_AT_PARCEL' });
    }
    assertBoxesFit(boxes, now.items);

    const labelUrl = fitting(parcel.labelUrl, 500);
    const trackingNumber = fitting(parcel.trackingNumber, 100);
    const trackingUrl = trackingNumber ? fitting(parcel.trackingUrl, 500) : null;
    if (
      labelUrl !== (parcel.labelUrl ?? null) ||
      trackingNumber !== (parcel.trackingNumber ?? null) ||
      trackingUrl !== (parcel.trackingUrl ?? null)
    ) {
      log.warn(
        { orderId, parcelId: parcel.parcelId },
        'a link or a number of a parcel of the provider does not fit and was left out',
      );
    }
    const created = await db.orderShipment.create({
      data: {
        orderId,
        carrier: carrierLabel,
        trackingNumber,
        trackingUrl,
        providerParcelId: parcel.parcelId,
        labelUrl,
        state: 'created',
        shippedAt: null,
        customsInvoice: parcel.customsInvoice,
      },
      select: { id: true },
    });
    await db.shipmentBox.createMany({
      data: boxes.map((box, i) => ({
        shipmentId: created.id,
        number: i + 1,
        ...box,
        items: box.items,
        trackingNumber: fitting(parcel.boxes[i]?.trackingNumber, 100),
        labelUrl: fitting(parcel.boxes[i]?.labelUrl, 500),
      })),
    });
    if (parcel.cost > 0) await recordShipmentCost(db, created.id, parcel.cost);
    await writeAdminAuditLog(db, {
      actorId: actor.actorId,
      actorRole: actor.actorRole,
      entityType: 'order',
      entityId: orderId,
      action: 'ORDER_SHIPMENT_CHANGE',
      event: bulk ? 'order.parcel_create_bulk' : 'order.parcel_create',
      changes: [
        {
          field: 'parcel',
          old: null,
          new: {
            id: created.id,
            providerParcelId: parcel.parcelId,
            boxes: boxes.length,
            cost: parcel.cost,
            customsInvoice: parcel.customsInvoice,
          },
        },
      ],
    });
    return created.id;
  });
}

// POST /api/orders/:orderId/parcels: the parcels as the body lays them out, or the draft
export async function createParcels(
  args: Actor & { orderId: number; body: ParcelsBodyDto | undefined; bulk?: boolean },
  log: FastifyBaseLogger,
): Promise<ParcelsResultDto> {
  assertStaff(args.actorRole);
  const lock = await takeRedisLock(lockKey(args.orderId), LOCK_MS);
  if (!lock) throw new ConflictError('PARCELS_BEING_MADE');

  try {
    const read = await tx(async (db) => {
      await setUserContext(db, { userId: args.actorId, role: args.actorRole });
      return parcelOrderOf(db, args.orderId);
    });
    assertParcelsCanBeMade(read);
    assertCustomsData(read);
    if (!deliveryProvider.isConfigured())
      throw new ConflictError('DELIVERY_PROVIDER_NOT_CONFIGURED');

    const laidOut: BoxData[][] = args.body?.parcels
      ? args.body.parcels.map((parcel) => parcel.boxes.map(boxDataOf))
      : draftOf(read.items);
    assertLaidOut(laidOut.flat(), read.items);
    // every request before the first is sent: a parcel that cannot be asked for (a box without its
    // sizes) is refused before any label is made
    const requests = laidOut.map((boxes, i) =>
      parcelRequestOf(read, boxes, read.providerParcels + i + 1),
    );
    const delivery = JSON.stringify(read.order.delivery);

    const made: number[] = [];
    let failed: ParcelsResultDto['failed'] = null;

    for (const [i, boxes] of laidOut.entries()) {
      const request = requests[i]!;
      try {
        // two minutes more for this parcel; the lock ran out: another request may make them now
        if (!(await lock.extend(LOCK_MS))) throw new ConflictError('PARCELS_BEING_MADE');
        // made before, its answer lost on the way: taken as it is when it is the parcel asked
        // for now (as many boxes, of the same weight); one laid out another way carries another
        // label: it is given up and the parcel is made anew
        let parcel = await deliveryProvider.findParcel(request.reference);
        if (parcel && !sameParcel(parcel, boxes)) {
          await giveUpParcel(parcel, request.option.carrierName, args.orderId, log);
          parcel = null;
        }
        parcel ??= await deliveryProvider.createParcel(request, log);
        const customsInvoice = await customsInvoiceOf(read, request, parcel, log);
        try {
          made.push(
            await writeParcel(
              args,
              args.orderId,
              { ...parcel, customsInvoice },
              boxes,
              request.option.carrierName,
              args.bulk === true,
              delivery,
              log,
            ),
          );
        } catch (err) {
          await giveUpParcel(parcel, request.option.carrierName, args.orderId, log);
          throw err;
        }
      } catch (err) {
        // nothing made yet: the refusal is the answer
        if (!made.length) throw err;
        failed = {
          parcel: i + 1,
          errorCode: isAppError(err) ? err.errorCode : 'INTERNAL_ERROR',
          message:
            isAppError(err) && err.errorCode === DELIVERY_PARCEL_REFUSED
              ? String((err.details as { message?: unknown } | undefined)?.message ?? '')
              : null,
        };
        // the reason of a carrier may repeat the recipient: the log names the failure only
        log.warn(
          { ...failureOf(err), orderId: args.orderId },
          'a parcel of the order was not made',
        );
        break;
      }
    }

    const order = await readAdminOrder(args, args.orderId);
    return { order, made, failed };
  } finally {
    await lock.release();
  }
}

// a parcel the provider has under the number of this one is the same parcel when it has as many
// boxes and, where the provider tells the weight, the same weight (to ten grams: the provider
// keeps kilograms)
const sameParcel = (found: DeliveryParcel, boxes: readonly BoxData[]): boolean =>
  found.boxes.length === boxes.length &&
  (found.weightGrams === null ||
    Math.abs(found.weightGrams - boxes.reduce((sum, box) => sum + (box.weightGrams ?? 0), 0)) <=
      10);

// a parcel the provider made that the shop could not keep (the order changed meanwhile): voided at
// the provider when its carrier can be asked, else the log names it for the admin to cancel in the
// dashboard of the carrier
async function giveUpParcel(
  parcel: DeliveryParcel,
  carrierName: string,
  orderId: number,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    if (
      (await deliveryProvider.voidParcel({ parcelId: parcel.parcelId, carrierName })) === 'voided'
    ) {
      log.warn(
        { orderId, parcelId: parcel.parcelId },
        'a parcel not kept was voided at the provider',
      );
      return;
    }
  } catch {
    // the error below names it
  }
  log.error(
    { orderId, parcelId: parcel.parcelId },
    'a parcel made at the provider was not kept: cancel it in the dashboard of the carrier',
  );
}

async function readAdminOrder(actor: Actor, orderId: number): Promise<OrderResponseDto> {
  return tx(async (db) => {
    await setUserContext(db, { userId: actor.actorId, role: actor.actorRole });
    const row = await readOrderResponse(db, orderId);
    if (!row) throw new NotFoundError('ORDER_NOT_FOUND', { orderId });
    return mapOrderRowToResponse(row, await orderContextOf(db, [row], 'admin'), 'admin');
  });
}

// GET /api/orders/:orderId/shipments/:shipmentId/customs-invoice: the commercial invoice of a parcel
// that carries the tax number of the shop on it, drawn again by the provider from the parcel as it
// was made (its boxes and what they hold); the carrier is not sent it again
export async function parcelCustomsInvoice(
  args: Actor & { orderId: number; shipmentId: number },
  log: FastifyBaseLogger,
): Promise<{ pdf: Buffer; fileName: string }> {
  assertStaff(args.actorRole);
  const read = await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    const shipment = await db.orderShipment.findFirst({
      where: { id: args.shipmentId, orderId: args.orderId, providerParcelId: { not: null } },
      select: { id: true, providerParcelId: true, customsInvoice: true, state: true },
    });
    if (!shipment) {
      throw new NotFoundError('ORDER_SHIPMENT_NOT_FOUND', {
        orderId: args.orderId,
        shipmentId: args.shipmentId,
      });
    }
    const order = await parcelOrderOf(db, args.orderId);
    const boxes = await db.shipmentBox.findMany({
      where: { shipmentId: shipment.id },
      orderBy: { number: 'asc' },
      select: { weightGrams: true, lengthMm: true, widthMm: true, heightMm: true, items: true },
    });
    // its number among the parcels of the provider of the order, as it was made with
    const number = await db.orderShipment.count({
      where: { orderId: args.orderId, providerParcelId: { not: null }, id: { lte: shipment.id } },
    });
    return { shipment, order, boxes, number };
  });

  const { shipment } = read;
  if (!shipment.customsInvoice) throw new ConflictError('CUSTOMS_INVOICE_NONE');
  if (shipment.state === 'void_pending' || shipment.state === 'voided') {
    throw new ConflictError('PARCEL_STATE_INVALID', { state: shipment.state });
  }
  if (!deliveryProvider.isConfigured()) throw new ConflictError('DELIVERY_PROVIDER_NOT_CONFIGURED');

  const request = parcelRequestOf(
    read.order,
    read.boxes.map((box) => ({ ...box, items: box.items as BoxItem[] })),
    read.number,
  );
  // the country of the recipient no longer has the number the parcel was made with
  if (!request.taxNumber) {
    throw new ConflictError('DELIVERY_TAX_NUMBER_MISSING', {
      country: read.order.order.delivery!.country,
    });
  }
  const pdf = await deliveryProvider.customsInvoice(
    {
      ...request,
      parcelId: shipment.providerParcelId!,
      invoice: invoiceOf(read.order, request),
    },
    false,
    log,
  );
  return { pdf, fileName: `customs-invoice-${request.reference}.pdf` };
}

// the routes of the parcels are of the staff
export const assertStaff = (role: Role) => {
  if (role !== 'ADMIN' && role !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');
};

// POST /api/orders/parcels: the parcels of many orders, each by its draft, each on its own: a
// refusal of one does not stop the others
export async function createParcelsOf(
  args: Actor & { orderIds: number[] },
  log: FastifyBaseLogger,
): Promise<ParcelsBulkResultDto> {
  assertStaff(args.actorRole);
  const results: ParcelsBulkResultDto['results'] = [];
  for (const orderId of args.orderIds) {
    try {
      const made = await createParcels({ ...args, orderId, body: undefined, bulk: true }, log);
      results.push({
        orderId,
        ok: made.failed === null,
        made: made.made,
        ...(made.failed ? { errorCode: made.failed.errorCode, message: made.failed.message } : {}),
      });
    } catch (err) {
      if (
        !isAppError(err) ||
        (err.statusCode >= 500 && err.errorCode !== 'DELIVERY_PROVIDER_UNAVAILABLE')
      ) {
        throw err;
      }
      results.push({
        orderId,
        ok: false,
        made: [],
        errorCode: err.errorCode,
        message:
          err.errorCode === DELIVERY_PARCEL_REFUSED
            ? String((err.details as { message?: unknown } | undefined)?.message ?? '')
            : null,
      });
    }
  }
  return { results };
}
