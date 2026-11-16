import env from '@config/env.js';

import type {
  DeliveryAddress,
  DeliveryBox,
  DeliveryCustomsLine,
  DeliveryQuoteRequest,
} from '../types.js';

// Our words in the units and the fields of ShippyPro: kilograms and centimetres, an address in
// two lines, the currency in upper case, and the four fields of the insurance and the cash on
// delivery it wants on every request (without them it mails the owner a warning about the call)

export const currency = (): string => env.SHOP_CURRENCY.toUpperCase();

// grams to kilograms, three decimals
export const kilograms = (grams: number): number => Math.round(grams) / 1000;

// millimetres to centimetres, up to the next tenth: a box is never declared smaller than it is
const centimetres = (mm: number): number => Math.ceil(mm) / 10;

// the street and the house in the first line (the carriers look the street up by its name), the
// apartment in the second; the phone in digits only
export function addressOf(address: DeliveryAddress): Record<string, string> {
  return {
    name: address.name,
    company: '',
    street1: `${address.street} ${address.house}`.trim(),
    street2: address.apartment ?? '',
    city: address.city,
    state: '',
    zip: address.postalCode ?? '',
    country: address.country.toUpperCase(),
    phone: address.phone.replace(/\D/g, ''),
    email: address.email ?? '',
  };
}

export function parcelsOf(boxes: readonly DeliveryBox[]): Record<string, number>[] {
  return boxes.map((box) => ({
    length: centimetres(box.lengthMm),
    width: centimetres(box.widthMm),
    height: centimetres(box.heightMm),
    weight: kilograms(box.weightGrams),
  }));
}

// a sum of money in the way TotalValue takes it: digits, a point and the currency ("12.50 EUR")
const moneyText = (amount: number): string => `${amount.toFixed(2)} ${currency()}`;

const crossesBorder = (request: DeliveryQuoteRequest): boolean =>
  request.from.country.toUpperCase() !== request.to.country.toUpperCase();

// what GetRates and Ship share: the addresses, the boxes, what is in them, no insurance and no cash
// on delivery, and the value of a parcel that crosses a border
export function shipmentOf(request: DeliveryQuoteRequest): Record<string, unknown> {
  return {
    from_address: addressOf(request.from),
    to_address: addressOf(request.to),
    parcels: parcelsOf(request.boxes),
    // ShippyPro does not take a backslash in it
    ContentDescription: request.contents.replaceAll('\\', '/').slice(0, 255),
    Insurance: 0,
    InsuranceCurrency: currency(),
    CashOnDelivery: 0,
    CashOnDeliveryCurrency: currency(),
    ...(crossesBorder(request) ? { TotalValue: moneyText(request.declaredValue) } : {}),
  };
}

// the lines of the customs declaration (CN22Info): the weight of one unit in kilograms
export function customsOf(lines: readonly DeliveryCustomsLine[]): Record<string, unknown>[] {
  return lines.map((line) => ({
    Description: line.description.replaceAll('\\', '/').slice(0, 255),
    Weight: kilograms(line.weightGrams),
    Quantity: line.quantity,
    UnitValue: line.unitValue,
    OriginCountry: line.originCountry.toUpperCase(),
    Currency: currency(),
    HSCode: line.hsCode,
    ...(line.sku ? { SKU: line.sku } : {}),
  }));
}
