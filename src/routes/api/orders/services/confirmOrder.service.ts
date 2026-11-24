import { shopSettings } from '@config/shopSettings.js';
import {
  noteTaxRefusal,
  quoteOrder,
  refusalOf,
  taxArgOf,
  taxCountryOf,
  taxLinesOf,
  type CarrierPrice,
} from './helpers/orderTax.helper.js';
import { shopCountry } from '@config/shopCountries.js';
import type { DeliveryMethodName } from '@config/deliveryMethods.js';
import { expiredUnitsOf } from '@db/expiredStock.helper.js';
import { Prisma } from '@prisma/client';
import { getPgMessage, prisma, tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  assertAcceptedForOrder,
  recordConsents,
} from '@routes/api/legal/services/helpers/legalDocuments.helper.js';
import { sendsToAddress } from '@config/deliveryMethods.js';
import { customsNeededFor, productsWithoutCustomsData } from '@helpers/customs.js';
import { carrierPriceFor, deliveryPriceOf, deliveryRuleOf } from '@helpers/deliveryPrice.js';
import { currentPrice } from '@helpers/productSale.js';
import { assertRedisReady } from '@redis/client.js';
import { lowestMinimumTotal, shopCurrency } from '@providers/payments/index.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import {
  buildDeliveryData,
  assertDeliveryOfShop,
  findUnavailableItems,
  mapOrderRowToResponse,
  orderContextOf,
  readOrderResponse,
  scheduleOrderReservationExpiry,
} from './helpers/index.js';
import {
  cartForDelivery,
  carrierOptionsFor,
  linesWithoutShippingData,
  optionOf,
} from './helpers/carrierQuotes.helper.js';

import type { FastifyBaseLogger } from 'fastify';
import type { DeliveryWriteData } from './helpers/confirmOrder.helper.js';
import type { ConfirmCurrentOrderDto, OrderResponseDto } from 'types/dto/orders.dto.js';
import type { UserId } from 'types/ids.js';

// what the check of the items reads of a variant: whether it is for sale, its free units, and
// whether it shows a picture (one is enough to tell)
const UNAVAILABLE_VARIANT_SELECT = {
  select: {
    deletedAt: true,
    stock: true,
    reservedStock: true,
    price: true,
    salePrice: true,
    saleEndsAt: true,
    images: { select: { imageId: true }, take: 1 },
  },
} as const;

// the items of an unconfirmed order of the user the order cannot be confirmed with now
async function unavailableItemsOf(actorId: UserId, orderId: number) {
  return prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: actorId, role: 'USER' });
    const items = await db.orderItem.findMany({
      where: { orderId, order: { userId: actorId as any, confirmed: false } },
      select: {
        id: true,
        variantId: true,
        quantity: true,
        product: { select: { deletedAt: true } },
        variant: UNAVAILABLE_VARIANT_SELECT,
      },
      orderBy: { id: 'asc' },
    });
    return findUnavailableItems(
      items,
      await expiredUnitsOf(
        db,
        items.map((item) => item.variantId),
      ),
    );
  });
}

// the items of an unconfirmed order of the user whose price is not the one their variant sells at
// now (the sale price while a sale lasts), from a fresh read: the refusal of a confirmation names them
async function changedPricesOf(actorId: UserId, orderId: number) {
  return prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: actorId, role: 'USER' });
    const items = await db.orderItem.findMany({
      where: { orderId, order: { userId: actorId as any, confirmed: false } },
      select: {
        id: true,
        variantId: true,
        unitPrice: true,
        variant: { select: { price: true, salePrice: true, saleEndsAt: true } },
      },
      orderBy: { id: 'asc' },
    });

    return items.flatMap((item) => {
      const price = currentPrice(item.variant);
      const unitPrice = Number(item.unitPrice);
      return unitPrice === price
        ? []
        : [{ itemId: item.id, variantId: item.variantId, unitPrice, price }];
    });
  });
}

// The checks of a delivery to an address made before the transaction, and the price of a carrier:
// a country with customs needs the customs data of every product (DELIVERY_CUSTOMS_DATA_MISSING); a
// carrier needs the weight and the sizes of every variant (ORDER_ITEMS_NOT_DELIVERABLE), and its
// price now from the delivery provider, which is outside the transaction (the five minutes of the
// prices the page showed, else asked again): the carrier the buyer picked must still be among them
// (DELIVERY_SERVICE_UNAVAILABLE), a provider that does not answer is 503. Nothing is read of an
// order that is not a cart of the user: confirm_order says so. The checks see the cart and the
// delivery of this moment (checked): the confirmation compares them with what it confirmed
const WRITTEN_DELIVERY_SELECT = {
  method: true,
  country: true,
  postalCode: true,
  city: true,
  street: true,
  house: true,
  apartment: true,
  carrierName: true,
  carrierService: true,
  carrierConnection: true,
} as const;

// what the checks of a delivery depend on, as one text: the lines of the cart with what a carrier
// and the customs read of them (not the name: the confirmation writes the one of the variant; nor
// the unit price: the confirmation writes the one the tax rule leaves, and confirm_order compares
// the prices with the catalog itself), and the delivery the order has when none is sent
const checkedOf = (
  cart: { lines: readonly { name: string; unitPrice: number }[] },
  written: unknown,
): string =>
  JSON.stringify({
    lines: cart.lines.map(({ name: _name, unitPrice: _price, ...line }) => line),
    written,
  });

async function checkDeliveryOfCart(
  actorId: UserId,
  orderId: number,
  sent: DeliveryWriteData | null,
  log: FastifyBaseLogger,
): Promise<{ carrier: CarrierPrice | null; checked: string | null }> {
  const read = await tx(async (db) => {
    await setUserContext(db, { userId: actorId, role: 'USER' });
    const order = await db.order.findFirst({
      where: { id: orderId, userId: actorId as any, confirmed: false },
      select: { id: true },
    });
    if (!order) return null;

    const written = sent
      ? null
      : await db.orderDelivery.findUnique({
          where: { orderId },
          select: WRITTEN_DELIVERY_SELECT,
        });
    return { cart: await cartForDelivery(db, order.id), written };
  });
  if (!read) return { carrier: null, checked: null };

  const checked = checkedOf(read.cart, read.written);
  const delivery = sent ?? read.written;
  if (!delivery || !sendsToAddress(delivery.method) || !delivery.country) {
    return { carrier: null, checked };
  }

  if (customsNeededFor(delivery.country)) {
    const products = productsWithoutCustomsData(read.cart.lines);
    if (products.length) throw new BadRequestError('DELIVERY_CUSTOMS_DATA_MISSING', { products });
  }

  if (delivery.method !== 'carrier') return { carrier: null, checked };

  const items = linesWithoutShippingData(read.cart);
  if (items.length) throw new ConflictError('ORDER_ITEMS_NOT_DELIVERABLE', { items });
  if (!read.cart.box) return { carrier: null, checked };

  const options = await carrierOptionsFor(
    {
      address: {
        country: delivery.country,
        postalCode: delivery.postalCode,
        city: delivery.city!,
        street: delivery.street!,
        house: delivery.house!,
        apartment: delivery.apartment,
      },
      box: read.cart.box,
      lines: read.cart.lines,
      value: read.cart.itemsTotal,
    },
    log,
  );
  const option = optionOf(options, {
    carrierName: delivery.carrierName ?? '',
    carrierService: delivery.carrierService ?? '',
    connection: delivery.carrierConnection ?? '',
  });
  if (!option) throw new ConflictError('DELIVERY_SERVICE_UNAVAILABLE');

  // what the buyer pays for it: free from the free-from sum only when it is the cheapest, the sum of
  // the items at the prices the tax rule leaves (quoteOrder)
  return {
    carrier: { price: option.price, cheapest: Math.min(...options.map((one) => one.price)) },
    checked,
  };
}

// what the delivery of an unconfirmed order of the user costs now, by the items it has: the price
// a confirmation that the buyer saw another price for names. The method is the one sent with the
// confirmation, else the one the order has
async function deliveryPriceNowOf(
  actorId: UserId,
  orderId: number,
  method: DeliveryMethodName | undefined,
  country: string | null | undefined,
  carrier: CarrierPrice | null,
): Promise<number> {
  return prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: actorId, role: 'USER' });
    const order = await db.order.findFirst({
      where: { id: orderId, userId: actorId as any, confirmed: false },
      select: {
        delivery: { select: { method: true, country: true } },
        items: { select: { totalPrice: true } },
      },
    });

    const chosen = method ?? order?.delivery?.method;
    if (!order || !chosen) return 0;

    // the price the next confirmation takes: by the tax rule of the country (docs/taxes.md)
    const quote = await quoteOrder(db, {
      lines: await taxLinesOf(db, orderId),
      method: chosen,
      country: country ?? order.delivery?.country ?? null,
      carrier,
    });
    if (quote) return quote.delivery?.price ?? 0;
    const carrierPrice = carrier
      ? carrierPriceFor(
          order.items.reduce((sum, item) => sum + Number(item.totalPrice), 0),
          country ?? order.delivery?.country ?? null,
          carrier.price,
          carrier.cheapest,
        )
      : null;

    const itemsCents = order.items.reduce(
      (sum, item) => sum + Math.round(Number(item.totalPrice) * 100),
      0,
    );
    return deliveryPriceOf(
      chosen,
      itemsCents / 100,
      country ?? order.delivery?.country ?? null,
      carrierPrice,
    );
  });
}

export async function confirmOrder({
  actorId,
  actorRole,
  orderId,
  delivery,
  expectedDeliveryPrice,
  invoice,
  log,
}: ConfirmCurrentOrderDto): Promise<OrderResponseDto> {
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  // check the delivery before anything is written; a delivery that is not sent leaves the one the
  // order already has
  const deliveryData = delivery ? buildDeliveryData(delivery) : null;

  // refuse early so nothing is confirmed in db while redis is down
  assertRedisReady();

  const { carrier, checked } = await checkDeliveryOfCart(
    actorId,
    Number(orderId),
    deliveryData,
    log,
  );

  try {
    const result = await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // only a customer who accepted the versions of the terms and of the contract in force
        // confirms an order; the order keeps them for the mail after the payment
        const legalVersions = await assertAcceptedForOrder(db, Number(actorId));

        // write where the order goes before the confirmation, the database refuses to confirm an
        // order without it; rls lets the owner write it only for an own unconfirmed order, any
        // other case is reported by confirm_order
        if (deliveryData) {
          const cart = await db.order.findFirst({
            where: { id: Number(orderId), userId: actorId as any, confirmed: false },
            select: { id: true },
          });
          if (cart) {
            await db.orderDelivery.upsert({
              where: { orderId: cart.id },
              create: { orderId: cart.id, ...deliveryData },
              update: deliveryData,
            });
          }
        } else {
          // no delivery sent: the one the order has, written before, goes on if the shop still
          // offers it
          const written = await db.orderDelivery.findFirst({
            where: {
              orderId: Number(orderId),
              order: { userId: actorId as any, confirmed: false },
            },
            select: { method: true, country: true },
          });
          if (written) assertDeliveryOfShop(written.method, written.country);
        }

        // name every item the order cannot be confirmed with, a variant a buyer does not see (taken
        // out of sale, its product removed, no picture) or not enough free stock: the page shows
        // them, the owner changes the order and confirms again. The database refuses such an order
        // on its own, this only says which items.
        // A confirmed order is left to confirm_order, its own reservation is in the stock numbers
        const items = await db.orderItem.findMany({
          where: { orderId: Number(orderId), order: { userId: actorId as any, confirmed: false } },
          select: {
            id: true,
            variantId: true,
            quantity: true,
            product: { select: { deletedAt: true } },
            variant: UNAVAILABLE_VARIANT_SELECT,
          },
          orderBy: { id: 'asc' },
        });

        const unavailable = findUnavailableItems(
          items,
          await expiredUnitsOf(
            db,
            items.map((item) => item.variantId),
          ),
        );
        if (unavailable.length) {
          throw new ConflictError('ORDER_ITEMS_UNAVAILABLE', { items: unavailable });
        }

        // no payment provider takes a smaller payment: refused before the stock is held, the page
        // tells the buyer the smallest total. The buyer picks the provider after this, so only a
        // total below the minimum of every one of them is refused here; the payment page checks the
        // one picked. The total is what the buyer pays: the items at the prices the variants sell
        // at now (the sale price while a sale lasts), the ones confirm_order takes, and the
        // delivery by the settings of the shop. An empty order is left to confirm_order
        // (ORDER_ITEMS_REQUIRED), an order without a delivery too (ORDER_DELIVERY_REQUIRED)
        const minimum = lowestMinimumTotal();
        const itemsCents = items.reduce(
          (sum, item) => sum + Math.round(currentPrice(item.variant) * 100) * item.quantity,
          0,
        );
        const written = deliveryData
          ? null
          : await db.orderDelivery.findUnique({
              where: { orderId: Number(orderId) },
              select: { method: true, country: true },
            });
        const method = deliveryData?.method ?? written?.method;
        const country = deliveryData ? deliveryData.country : (written?.country ?? null);

        // the tax of the order by the rule of the country it is taxed in (docs/taxes.md), counted
        // under the lock of its threshold: the items at the prices the rule leaves, the delivery
        // priced with them
        const quote = method
          ? await quoteOrder(db, {
              lines: await taxLinesOf(db, Number(orderId)),
              method,
              country,
              carrier,
              lock: true,
            })
          : null;

        const carrierPrice = carrier
          ? carrierPriceFor(itemsCents / 100, country, carrier.price, carrier.cheapest)
          : null;
        const deliveryCents = method
          ? Math.round(deliveryPriceOf(method, itemsCents / 100, country, carrierPrice) * 100)
          : 0;
        const totalCents = quote ? Math.round(quote.total * 100) : itemsCents + deliveryCents;
        if (items.length > 0 && totalCents < Math.round(minimum * 100)) {
          throw new BadRequestError('ORDER_TOTAL_BELOW_MINIMUM', {
            minimum,
            currency: shopCurrency(),
          });
        }

        // the tax of a country where the shop is not registered, and the largest total of the shop
        const refusal = refusalOf(quote, totalCents / 100);
        if (refusal) {
          // root is told of the sales a threshold stopped and of the parcels refused
          if (method) await noteTaxRefusal(quote, method, country);
          throw refusal;
        }

        // confirm in db; the order holds its units reservationMinutes (15 unless root set one)
        // and its delivery is priced by the rule of the zone of its country
        const settings = shopSettings();
        const rule = quote?.delivery
          ? { price: quote.delivery.flat, freeFrom: quote.delivery.freeFrom }
          : method
            ? deliveryRuleOf(method, country, carrierPrice)
            : { price: null, freeFrom: null };
        const tax = taxArgOf(quote);
        await db.$executeRaw`select cartlify.confirm_order(
          ${Number(orderId)}::int,
          ${`${settings.reservationMinutes} minutes`}::interval,
          ${rule.price}::numeric,
          ${rule.freeFrom}::numeric,
          ${expectedDeliveryPrice}::numeric,
          ${tax === null ? null : JSON.stringify(tax)}::jsonb,
          ${invoice === true}::boolean
        )`;
        // the sales of the last 12 months passed the threshold with this order: the tax of the
        // recipient holds from now on, until root goes back to the first rule (the database counts
        // the sales itself)
        const taxCountry = method ? taxCountryOf(method, country) : null;
        if (
          quote?.threshold &&
          taxCountry &&
          shopCountry(taxCountry)?.threshold?.period === 'rolling_12'
        ) {
          await db.$queryRaw`select cartlify.hold_tax_threshold(${taxCountry}::text) as held`;
        }

        // the price of the carrier and the checks of the delivery were made before this
        // transaction, outside it (the provider is asked there): a cart or a delivery that changed
        // meanwhile was confirmed with what the other one cost and allowed. The confirmation holds
        // the order now, so what it confirmed is compared with what was checked; another one is
        // not confirmed, the buyer confirms again and the checks see it
        if (checked !== null) {
          const now = checkedOf(
            await cartForDelivery(db, Number(orderId)),
            deliveryData
              ? null
              : await db.orderDelivery.findUnique({
                  where: { orderId: Number(orderId) },
                  select: WRITTEN_DELIVERY_SELECT,
                }),
          );
          if (now !== checked) throw new ResourceBusyError({ reason: 'CART_CHANGED_AT_CONFIRM' });
        }

        const order = await readOrderResponse(db, orderId);

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_CONFIRM' });

        await recordConsents(db, Number(actorId), legalVersions, 'consent.order', order.id);

        const response = mapOrderRowToResponse(order, await orderContextOf(db, [order]));

        // schedule expiry before commit so a redis failure rolls the confirmation back
        await scheduleOrderReservationExpiry(response.id, order.reservationExpiresAt);

        return response;
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );

    return result;
  } catch (err) {
    if (isAppError(err)) throw err;

    if (isRetryableTxError(err)) {
      throw new ResourceBusyError();
    }

    // db function errors come as P2010
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
      const msg = String(getPgMessage(err) ?? err.message);

      if (msg.includes('ORDER_NOT_FOUND')) throw new NotFoundError('ORDER_NOT_FOUND');
      if (msg.includes('ORDER_CONFIRM_FORBIDDEN'))
        throw new ForbiddenError('ORDER_CONFIRM_FORBIDDEN');
      if (msg.includes('ORDER_ALREADY_CONFIRMED'))
        throw new ConflictError('ORDER_ALREADY_CONFIRMED');
      if (msg.includes('ORDER_STATUS_NOT_ALLOWED'))
        throw new ConflictError('ORDER_STATUS_NOT_ALLOWED');
      if (msg.includes('ORDER_ITEMS_REQUIRED')) throw new BadRequestError('ORDER_ITEMS_REQUIRED');

      // the order has no delivery and the request did not bring one
      if (msg.includes('ORDER_DELIVERY_REQUIRED')) throw new BadRequestError('DELIVERY_REQUIRED');

      // a carrier with no price: the cart got its items while the delivery was checked, so the
      // provider was never asked; the buyer confirms again
      if (msg.includes('ORDER_DELIVERY_PRICE_REQUIRED')) {
        throw new ResourceBusyError({ reason: 'CARRIER_PRICE_MISSING_AT_CONFIRM' });
      }

      // the price of the delivery the buyer saw is not the one the shop asks now: the buyer sees
      // the new one and confirms again
      if (msg.includes('ORDER_DELIVERY_PRICE_CHANGED')) {
        throw new ConflictError('DELIVERY_PRICE_CHANGED', {
          price: await deliveryPriceNowOf(
            actorId,
            Number(orderId),
            delivery?.method,
            delivery?.address?.country,
            carrier,
          ),
        });
      }

      // some item price differs from current variant price: nothing is reserved; the items are named
      // (details.items), the client reloads the order to get fresh prices and confirms again
      if (msg.includes('ORDER_PRICES_CHANGED')) {
        throw new ConflictError('ORDER_PRICES_CHANGED', {
          items: await changedPricesOf(actorId, Number(orderId)),
        });
      }
      // another buyer took the last free units between the check and the reserve: the items are
      // named the way the check names them, from a fresh read
      if (msg.includes('INSUFFICIENT_AVAILABLE_STOCK')) {
        throw new ConflictError('ORDER_ITEMS_UNAVAILABLE', {
          items: await unavailableItemsOf(actorId, Number(orderId)),
        });
      }
      // a variant the items hold is gone between the check and the reserve: named like the check does
      if (msg.includes('VARIANT_NOT_FOUND')) {
        throw new ConflictError('ORDER_ITEMS_UNAVAILABLE', {
          items: await unavailableItemsOf(actorId, Number(orderId)),
        });
      }
      if (msg.includes('ORDER_RESERVATION_DURATION_INVALID'))
        throw new BadRequestError('ORDER_RESERVATION_DURATION_INVALID');
    }

    throw new InternalError({ reason: 'ORDERS_CURRENT_CONFIRM_UNEXPECTED' }, err);
  }
}
