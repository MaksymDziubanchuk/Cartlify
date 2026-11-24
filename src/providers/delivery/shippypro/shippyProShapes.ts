import env from '@config/env.js';

import type {
  DeliveryAddress,
  DeliveryBox,
  DeliveryCustomsInvoiceRequest,
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

// the lines of the customs declaration (CN22Info): the weight of one unit in kilograms, the value of
// one unit without the tax of the destination the shop took
export function customsOf(lines: readonly DeliveryCustomsLine[]): Record<string, unknown>[] {
  return lines.map((line) => ({
    Description: line.description.replaceAll('\\', '/').slice(0, 255),
    Weight: kilograms(line.weightGrams),
    Quantity: line.quantity,
    UnitValue:
      Math.round(((line.unitValue * line.quantity - line.tax) / line.quantity) * 100) / 100,
    OriginCountry: line.originCountry.toUpperCase(),
    Currency: currency(),
    HSCode: line.hsCode,
    ...(line.sku ? { SKU: line.sku } : {}),
  }));
}

const cents = (amount: number): number => Math.round(amount * 100) / 100;

// a day the way the invoice takes it (YYYY-MM-DD)
const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

// a party of the commercial invoice: the street and the house in one line, the phone in digits
const partyOf = (address: DeliveryAddress): Record<string, string> => ({
  Name: address.name,
  Address: [`${address.street} ${address.house}`.trim(), address.apartment ?? '']
    .filter(Boolean)
    .join(', '),
  Zipcode: address.postalCode ?? '',
  City: address.city,
  Country: address.country.toUpperCase(),
  Telephone: address.phone.replace(/\D/g, ''),
});

// CreateCrossBorderInvoice: the commercial invoice of a parcel made (OrderId its id at ShippyPro),
// the tax number of the shop as the VAT number of the exporter. The values of the goods are without
// the tax, the tax paid apart: the invoice adds them up (checked with the test key, 22.11.2026);
// the weight of a line is of all its units. UploadETD sends it to the carrier with the parcel: any
// value of it does (even "false"), so it is there only when the invoice goes electronically
export function crossBorderInvoiceOf(
  request: DeliveryCustomsInvoiceRequest,
  electronic: boolean,
): Record<string, unknown> {
  const lines = request.customs ?? [];
  const goods = lines.map((line) => {
    const net = cents(line.unitValue * line.quantity - line.tax);
    return {
      ParcelCount: request.boxes.length,
      Description: line.description.replaceAll('\\', '/').slice(0, 255),
      HsCode: line.hsCode,
      CountryOfOrigin: line.originCountry.toUpperCase(),
      Quantity: line.quantity,
      Weight: kilograms(line.weightGrams * line.quantity),
      UnitValue: cents(net / line.quantity),
      GstPaid: cents(line.tax),
      SubTotalValue: net,
    };
  });
  const day = dayOf(request.invoice.date);

  return {
    Incoterm: 'DAP',
    TypeOfExport: 'merchandise',
    Currency: currency(),
    NumberOfParcels: request.boxes.length,
    OrderId: request.parcelId,
    OrderReference: request.reference,
    TotalLineItems: goods.length,
    TotalWeight: kilograms(request.boxes.reduce((sum, box) => sum + box.weightGrams, 0)),
    TotalAmount: cents(goods.reduce((sum, line) => sum + line.SubTotalValue, 0)),
    TotalGst: cents(goods.reduce((sum, line) => sum + line.GstPaid, 0)),
    InvoiceType: 'Commercial',
    InvoiceNumber: request.invoice.number,
    CountryOfExportDestination: request.to.country.toUpperCase(),
    DateOfExportation: dayOf(new Date()),
    SignatureDate: day,
    DeclarationNotes: 'The tax of the country of destination was collected at the point of sale.',
    ShipperExporter: { ...partyOf(request.from), VatNumber: request.taxNumber?.number ?? '' },
    Consignee: partyOf(request.to),
    Goods: goods,
    ...(electronic ? { UploadETD: 'true' } : {}),
  };
}
