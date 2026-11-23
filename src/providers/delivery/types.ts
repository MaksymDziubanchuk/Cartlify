import type { FastifyBaseLogger } from 'fastify';

import type { Provider } from '../provider.js';

import type { DeliveryProviderName } from './names.js';

// A delivery provider is an aggregator of carriers: the owner connects the contracts of the
// carriers and their tables of prices in its own dashboard, the app knows only the provider. Every
// price is in the currency of the shop (SHOP_CURRENCY): the account of the provider charges in it,
// the app converts nothing

// where a parcel goes from or to: a person at an address; the phone in the international form
export type DeliveryAddress = {
  name: string;
  street: string;
  house: string;
  apartment: string | null;
  city: string;
  // empty in a country that has none
  postalCode: string | null;
  // two letters, upper case
  country: string;
  phone: string;
  // the carriers tell the recipient of the delivery by mail; none for an account without one
  email: string | null;
};

// one box of a parcel, its weight and its sides
export type DeliveryBox = {
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
};

// a line of the customs declaration of a parcel that crosses a border: one item of the order
export type DeliveryCustomsLine = {
  description: string;
  quantity: number;
  // the price of one unit, in the currency of the shop
  unitValue: number;
  // of one unit
  weightGrams: number;
  hsCode: string;
  // two letters, upper case
  originCountry: string;
  sku: string | null;
  // the tax the units of the line hold together in their price (the tax of the country of the
  // recipient the shop took), 0 when none: the customs are given the value without it
  tax: number;
};

// the tax number of the shop in the country of the recipient, given with a parcel that crosses
// customs when the shop took the tax of that country on its items: ioss, the number of the import
// scheme, goes with the parcel; other, any other number, goes on a commercial invoice made after
// the parcel (customsInvoice)
export type DeliveryTaxNumber = { kind: 'ioss' | 'other'; number: string };

// what the prices of the carriers are asked for: the boxes of one parcel from the sender to the
// recipient, what is in it and what it is worth (in the currency of the shop)
export type DeliveryQuoteRequest = {
  from: DeliveryAddress;
  to: DeliveryAddress;
  boxes: DeliveryBox[];
  contents: string;
  // the value of what is in it; of a parcel that crosses customs, without the tax of the country of
  // the recipient the shop took (the customs value)
  declaredValue: number;
};

// a carrier and its service, as the provider knows them: the three fields of a line of the prices,
// kept on the delivery of an order the buyer picked it for
export type DeliveryCarrierChoice = {
  carrierName: string;
  carrierService: string;
  // the connection of the carrier in the account of the provider (one carrier may be connected
  // more than once, each with its contract)
  connection: string;
};

// one line of the prices: a carrier the buyer can pick, with its price in the currency of the shop
export type DeliveryOption = DeliveryCarrierChoice & {
  price: number;
  // how long the delivery takes, the way the table of the owner says it ("1-3"); null when it
  // says nothing
  days: string | null;
  // the name the owner gave the connection, for the buyer
  label: string;
};

export type DeliveryParcelRequest = DeliveryQuoteRequest & {
  // our number of the parcel (orderId-number); the provider keeps it, findParcel finds a parcel by it
  reference: string;
  option: DeliveryCarrierChoice;
  // the lines of the declaration when the parcel crosses a border, null when it does not
  customs: DeliveryCustomsLine[] | null;
  taxNumber: DeliveryTaxNumber | null;
};

// a commercial invoice of a parcel made: the parcel as it was asked for, its id at the provider and
// the invoice it names (the number of the invoice of the order, else the number of the parcel, and
// the day it was made)
export type DeliveryCustomsInvoiceRequest = DeliveryParcelRequest & {
  parcelId: string;
  invoice: { number: string; date: Date };
};

// a parcel the provider made, with its label
export type DeliveryParcel = {
  // its id at the provider, the events name it by
  parcelId: string;
  trackingNumber: string | null;
  // https, on the site of the carrier
  trackingUrl: string | null;
  // the label to print: a pdf with the addresses and the phone of the recipient, never logged
  labelUrl: string | null;
  // the boxes in the order they were given, with a number and a label of their own when the
  // carrier gives one a box
  boxes: { trackingNumber: string | null; labelUrl: string | null }[];
  // what its boxes weigh together, when the provider tells it: a parcel found again is the one
  // asked for only with as many boxes of the same weight
  weightGrams: number | null;
  // what the provider priced the parcel at, in the currency of the shop: the cost of the send the
  // shop records
  cost: number;
};

// What the provider reports about a parcel, in our words; every other event of the provider is
// dropped by it:
// created - the label was made (it repeats what the creation answered);
// failed - the label was not made;
// collected - the carrier has the parcel (picked it up, or it is on its way);
// delivered - the recipient got it;
// returning - it goes back to the sender;
// returned - the sender has it back;
// lost - the carrier lost it.
// A provider reports the last state it saw: delivered may come without collected
export type DeliveryEventKind =
  'created' | 'failed' | 'collected' | 'delivered' | 'returning' | 'returned' | 'lost';

export type DeliveryEvent = {
  parcelId: string;
  // our number of the parcel, as the provider gives it back; null when it gives none
  reference: string | null;
  kind: DeliveryEventKind;
  // when it happened, as the provider says; the time it came when the provider says nothing
  at: Date;
  trackingNumber: string | null;
  // the parcel goes back because the recipient refused it, as the provider tells it (returning
  // only; a provider that cannot tell it says false)
  refused: boolean;
};

// What a request to the webhook of the provider is, checked before its body is read:
// valid - the provider sent it;
// missing - it carries nothing to tell it by;
// unavailable - the server has no secret to check it with (a fault of the server: nothing is taken);
// invalid - what it carries does not hold.
export type DeliveryWebhookCheck =
  | { verdict: 'valid' }
  | { verdict: 'missing' }
  | { verdict: 'unavailable'; reason: string }
  | { verdict: 'invalid'; reason: string };

// the webhook the provider reports the parcels to, /api/delivery/<name>/webhook
export type DeliveryWebhook = {
  // the biggest body of an event, in bytes
  bodyLimit: number;
  // the headers of a request: an inline json schema of the ones it reads (none required there: the
  // check refuses a request without its secret, 401)
  headers: Readonly<Record<string, unknown>>;
  // how the provider posts and how it is told, for the description of the route
  description: string;
  check(request: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
  }): DeliveryWebhookCheck;
  // the events of a body that was checked and is json, in our words (none for an event the app does
  // not take); null when it is no event of the provider
  readEvents(body: unknown): DeliveryEvent[] | null;
  // the json body of the answer 200 the provider waits for
  answer: Readonly<Record<string, unknown>>;
};

// a warning of the provider goes to the log of the request: no data of the buyer in it
export type DeliveryLog = Pick<FastifyBaseLogger, 'warn'>;

// The errors of the kind:
// DELIVERY_PROVIDER_UNAVAILABLE - the provider did not answer, or not the way it should (503): what
//   it answered stays in the cause, for the log;
// DELIVERY_PARCEL_REFUSED - the carrier did not make the parcel (409), details.message is its
//   reason in its words, for the admin to fix the order and try again;
// DELIVERY_PROVIDER_NOT_CONFIGURED - the server has no key of the provider (a server error).
export const DELIVERY_PROVIDER_UNAVAILABLE = 'DELIVERY_PROVIDER_UNAVAILABLE';
export const DELIVERY_PARCEL_REFUSED = 'DELIVERY_PARCEL_REFUSED';
export const DELIVERY_PROVIDER_NOT_CONFIGURED = 'DELIVERY_PROVIDER_NOT_CONFIGURED';

// what the rest of the app asks of the delivery provider. How it does it is its own: its requests,
// its units, its carriers and the words of its events stay in its folder
export interface DeliveryProvider extends Provider<DeliveryProviderName> {
  // the server has its key: without it the method carrier cannot be switched on
  isConfigured(): boolean;
  // the carriers that take the parcel and their prices, the cheapest first. A carrier that gives
  // no price (a weight its table has no range for) or a price in another currency is left out
  quote(request: DeliveryQuoteRequest, log: DeliveryLog): Promise<DeliveryOption[]>;
  // makes the parcel with the carrier the option names, synchronously: the label, the number
  createParcel(request: DeliveryParcelRequest, log: DeliveryLog): Promise<DeliveryParcel>;
  // the live parcel made for our number, the latest when there is more than one; null when there is
  // none. Asked before a creation is repeated, so that no answer lost on the way makes two parcels
  findParcel(reference: string): Promise<DeliveryParcel | null>;
  // cancels a parcel the carrier has not taken: voided, or unsupported when the carrier cannot be
  // asked to (or the provider cannot tell): the shop cancels it in the dashboard of the carrier.
  // The parcel as the shop keeps it: its number at the provider and the name of its carrier
  voidParcel(parcel: { parcelId: string; carrierName: string }): Promise<'voided' | 'unsupported'>;
  // whether the carrier takes the customs papers of a parcel electronically (ETD); false when the
  // provider cannot tell
  takesDocuments(carrierName: string): Promise<boolean>;
  // the commercial invoice of a parcel made, with the tax number of the shop the request carries, a
  // pdf; electronic: the carrier is sent it with the parcel too. A carrier that does not take it
  // refuses with DELIVERY_PARCEL_REFUSED
  customsInvoice(
    request: DeliveryCustomsInvoiceRequest,
    electronic: boolean,
    log: DeliveryLog,
  ): Promise<Buffer>;
  webhook: DeliveryWebhook;
}
