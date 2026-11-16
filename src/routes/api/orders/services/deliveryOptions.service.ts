import type { FastifyBaseLogger } from 'fastify';

import { shopSettings } from '@config/shopSettings.js';
import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { customsNeededFor, productsWithoutCustomsData } from '@helpers/customs.js';
import { carrierPriceFor, deliveryPriceOf, shopZoneOf } from '@helpers/deliveryPrice.js';
import { failureOf } from '@helpers/failureOf.js';
import { senderAddressOf } from '@helpers/parcelBox.js';
import { deliveryProvider } from '@providers/delivery/index.js';
import { shopCurrency } from '@providers/payments/index.js';
import { BadRequestError } from '@utils/errors.js';

import { buildAddressData } from './helpers/confirmOrder.helper.js';
import {
  carrierOptionsFor,
  cartForDelivery,
  isProviderDown,
} from './helpers/carrierQuotes.helper.js';

import type {
  DeliveryOptionDto,
  DeliveryOptionsBodyDto,
  DeliveryOptionsResponseDto,
} from 'types/dto/orders.dto.js';
import type { UserId } from 'types/ids.js';

const toCents = (amount: number) => Math.round(amount * 100);

// POST /api/orders/current/delivery-options: the ways the cart of the buyer goes to the address,
// with their prices: the manual delivery at the price of the zone of the country, the pickup, and
// the carriers of the delivery provider from the cheapest, free from the sum of the zone. Why no
// carrier is in the list: the shop has none (not_enabled), a variant has no weight or sizes
// (shipping_data_missing), the provider does not answer (provider_down; with nothing else to offer
// the answer is 503 DELIVERY_PROVIDER_UNAVAILABLE)
export async function deliveryOptions(args: {
  actorId: UserId;
  body: DeliveryOptionsBodyDto;
  log: FastifyBaseLogger;
}): Promise<DeliveryOptionsResponseDto> {
  // the address in the form it is kept in: a country of a zone, its postal code, the parts
  const address = buildAddressData(args.body.address);
  const zone = shopZoneOf(address.country)!;

  // the cart of the buyer: the last order not confirmed yet, the one GET /api/orders/current gives
  const cart = await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: 'USER' });
    const order = await db.order.findFirst({
      where: { userId: args.actorId as any, confirmed: false },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    return order ? cartForDelivery(db, order.id) : null;
  });
  if (!cart || !cart.lines.length) throw new BadRequestError('ORDER_ITEMS_REQUIRED');

  // a parcel over a border needs the customs data of every product, whatever the method to the
  // address (a pickup crosses no border)
  if (customsNeededFor(address.country)) {
    const products = productsWithoutCustomsData(cart.lines);
    if (products.length) throw new BadRequestError('DELIVERY_CUSTOMS_DATA_MISSING', { products });
  }

  const settings = shopSettings();
  const options: DeliveryOptionDto[] = [];

  if (settings.deliveryMethods.includes('manual') && zone.manualPrice !== null) {
    options.push({
      method: 'manual',
      price: deliveryPriceOf('manual', cart.itemsTotal, address.country),
      carrier: null,
      label: null,
      days: null,
    });
  }
  if (settings.deliveryMethods.includes('pickup')) {
    options.push({ method: 'pickup', price: 0, carrier: null, label: null, days: null });
  }

  let carriersUnavailable: DeliveryOptionsResponseDto['carriersUnavailable'] = null;
  if (
    !settings.deliveryMethods.includes('carrier') ||
    !deliveryProvider.isConfigured() ||
    !senderAddressOf()
  ) {
    carriersUnavailable = 'not_enabled';
  } else if (!cart.box) {
    carriersUnavailable = 'shipping_data_missing';
  } else {
    try {
      const carriers = await carrierOptionsFor(
        { address, box: cart.box, lines: cart.lines, value: cart.itemsTotal },
        args.log,
      );
      // the provider answered and prices no carrier for the parcel (its weight is in no range of
      // the tables, the address in no zone of them): the page says so, the owner reads the log
      if (!carriers.length) {
        carriersUnavailable = 'no_carrier_for_parcel';
        args.log.warn(
          { country: address.country, weightGrams: cart.box.weightGrams },
          'the delivery provider prices no carrier for a parcel',
        );
      }
      const cheapest = Math.min(...carriers.map((one) => one.price));
      for (const carrier of carriers) {
        options.push({
          method: 'carrier',
          price: carrierPriceFor(cart.itemsTotal, address.country, carrier.price, cheapest),
          carrier: {
            name: carrier.carrierName,
            service: carrier.carrierService,
            connection: carrier.connection,
          },
          label: carrier.label,
          days: carrier.days,
        });
      }
    } catch (err) {
      if (!isProviderDown(err)) throw err;
      // nothing else to offer: as a payment with the payment provider out of reach
      if (!options.length) throw err;
      args.log.warn(failureOf(err), 'delivery provider did not answer the prices');
      carriersUnavailable = 'provider_down';
    }
  }

  return {
    currency: shopCurrency(),
    zone: { name: zone.name, freeFrom: zone.freeFrom },
    remainingToFree:
      zone.freeFrom === null
        ? null
        : Math.max(0, toCents(zone.freeFrom) - toCents(cart.itemsTotal)) / 100,
    options,
    carriersUnavailable,
  };
}
