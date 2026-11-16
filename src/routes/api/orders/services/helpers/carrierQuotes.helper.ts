import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { boxOf, hasShippingData, senderAddressOf } from '@helpers/parcelBox.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import {
  DELIVERY_PROVIDER_UNAVAILABLE,
  deliveryProvider,
  type DeliveryBox,
  type DeliveryCarrierChoice,
  type DeliveryLog,
  type DeliveryOption,
} from '@providers/delivery/index.js';
import { getRedis, isRedisReady } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';
import { isAppError } from '@utils/errors.js';

// The cart as the carriers of the delivery provider need it, and their prices for it: one box of
// the items (decision 8), the prices kept five minutes in redis for the address and the box, so a
// buyer who looks at the prices and confirms asks the provider once (it takes 20 requests in 10
// seconds for the whole account)

const QUOTE_TTL_SECONDS = 5 * 60;

export type CartLine = {
  itemId: number;
  variantId: number;
  productId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  sku: string | null;
  hsCode: string | null;
  originCountry: string | null;
};

export type CartForDelivery = {
  orderId: number;
  itemsTotal: number;
  lines: CartLine[];
  // null when a variant has no weight or sizes, or the cart is empty
  box: DeliveryBox | null;
};

// the address of the parcel as the buyer wrote it
export type ParcelAddress = {
  country: string;
  postalCode: string | null;
  city: string;
  street: string;
  house: string;
  apartment: string | null;
};

// the items of an order with what the carriers and customs need, under the context of the caller
export async function cartForDelivery(
  db: Prisma.TransactionClient,
  orderId: number,
): Promise<CartForDelivery> {
  const items = await db.orderItem.findMany({
    where: { orderId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      variantId: true,
      productId: true,
      productName: true,
      quantity: true,
      unitPrice: true,
      totalPrice: true,
      variant: {
        select: { weightGrams: true, lengthMm: true, widthMm: true, heightMm: true, sku: true },
      },
      product: { select: { name: true, hsCode: true, originCountry: true } },
    },
  });

  const lines = items.map((item) => ({
    itemId: item.id,
    variantId: item.variantId,
    productId: item.productId,
    name: item.productName ?? item.product.name,
    quantity: item.quantity,
    unitPrice: decimalToNumber(item.unitPrice),
    weightGrams: item.variant.weightGrams,
    lengthMm: item.variant.lengthMm,
    widthMm: item.variant.widthMm,
    heightMm: item.variant.heightMm,
    sku: item.variant.sku,
    hsCode: item.product.hsCode,
    originCountry: item.product.originCountry,
  }));

  const itemsCents = items.reduce(
    (sum, item) => sum + Math.round(decimalToNumber(item.totalPrice) * 100),
    0,
  );

  return {
    orderId,
    itemsTotal: itemsCents / 100,
    lines,
    box: boxOf(lines.map((line) => ({ variant: line, quantity: line.quantity }))),
  };
}

// the lines a carrier cannot price: a variant without its weight or sizes
export const linesWithoutShippingData = (cart: CartForDelivery) =>
  cart.lines
    .filter((line) => !hasShippingData(line))
    .map((line) => ({ itemId: line.itemId, variantId: line.variantId }));

// what the parcel holds, for the label and the declaration: the names of the items
export const contentsOf = (lines: readonly { name: string; quantity: number }[]): string =>
  lines
    .map((line) => (line.quantity > 1 ? `${line.quantity} x ${line.name}` : line.name))
    .join(', ')
    .slice(0, 255);

const keyOf = (address: ParcelAddress, box: DeliveryBox, value: number): string =>
  redisKeys.deliveryQuotePrefix +
  createHash('sha256').update(JSON.stringify({ address, box, value })).digest('hex');

// the carriers and their prices for the cart to the address, the cheapest first: from the five
// minutes of redis, else asked of the provider. The recipient of a price is nobody yet: no data of
// the buyer goes to the provider before an order is made (the name and the phone the provider wants
// are of the shop). DELIVERY_PROVIDER_UNAVAILABLE when it does not answer
export async function carrierOptionsFor(
  args: { address: ParcelAddress; box: DeliveryBox; lines: readonly CartLine[]; value: number },
  log: DeliveryLog,
  opts: { fresh?: boolean } = {},
): Promise<DeliveryOption[]> {
  const sender = senderAddressOf();
  if (!sender) return [];

  // an admin who picks another carrier gets the prices of now, the five minutes are the buyer's
  const key = keyOf(args.address, args.box, args.value);
  if (isRedisReady() && !opts.fresh) {
    try {
      const cached = await (await getRedis()).get(key);
      if (cached) return JSON.parse(cached) as DeliveryOption[];
    } catch (err) {
      log.warn({ err }, 'delivery quote cache read failed');
    }
  }

  const options = await deliveryProvider.quote(
    {
      from: sender,
      to: { ...args.address, name: 'Recipient', phone: sender.phone, email: null },
      boxes: [args.box],
      contents: contentsOf(args.lines),
      declaredValue: args.value,
    },
    log,
  );

  if (isRedisReady()) {
    try {
      await (await getRedis()).set(key, JSON.stringify(options), { EX: QUOTE_TTL_SECONDS });
    } catch (err) {
      log.warn({ err }, 'delivery quote cache write failed');
    }
  }

  return options;
}

// the line of the prices of the carrier the buyer picked, null when the provider has it no more
export const optionOf = (options: readonly DeliveryOption[], choice: DeliveryCarrierChoice) =>
  options.find(
    (option) =>
      option.carrierName === choice.carrierName &&
      option.carrierService === choice.carrierService &&
      option.connection === choice.connection,
  ) ?? null;

// a provider that did not answer, told from any other error
export const isProviderDown = (err: unknown): boolean =>
  isAppError(err) && err.errorCode === DELIVERY_PROVIDER_UNAVAILABLE;
