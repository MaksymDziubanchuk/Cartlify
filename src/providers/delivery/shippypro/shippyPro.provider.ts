import { timingSafeEqual } from 'node:crypto';

import env from '@config/env.js';
import { ConflictError, ServiceUnavailableError } from '@utils/errors.js';

import {
  DELIVERY_PARCEL_REFUSED,
  DELIVERY_PROVIDER_UNAVAILABLE,
  type DeliveryLog,
  type DeliveryOption,
  type DeliveryParcel,
  type DeliveryProvider,
  type DeliveryQuoteRequest,
} from '../types.js';

import {
  callShippyPro,
  SHIPPYPRO_TIMEOUTS_MS,
  shippyProConfigured,
  type ShippyProBody,
} from './shippyProClient.js';
import { carrierTakesDocuments, carrierVoids } from './shippyProCapabilities.js';
import { readShippyProEvents } from './shippyProEvents.js';
import { crossBorderInvoiceOf, currency, customsOf, shipmentOf } from './shippyProShapes.js';

// ShippyPro (api.shippypro.com): one account of the owner with the carriers connected to it, each
// with its contract and the table of prices of the owner (zones and ranges of weight). The prices
// of all the carriers come in one list (GetRates), a parcel is made with one of them (Ship), the
// webhook reports the labels and what the carriers saw

// the header the webhook carries its secret in: ShippyPro signs no body, a header of our own set in
// its dashboard is how a request is told from ShippyPro
const SHIPPYPRO_SECRET_HEADER = 'x-webhook-secret';

// an event is a small json object
const WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;

// how far back findParcel looks for a parcel of our number: a repeat comes within minutes, three
// days hold a creation that failed on a weekend
const FIND_DAYS = 3;

const unavailable = (cause: unknown) =>
  new ServiceUnavailableError(DELIVERY_PROVIDER_UNAVAILABLE, undefined, cause);

const text = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const https = (value: unknown): string | null => {
  const url = text(value);
  return url && /^https:\/\//i.test(url) ? url : null;
};

const money = (value: number): number => Math.round(value * 100) / 100;

// the words ShippyPro answers a commercial invoice with when the carrier did not take it
// electronically ("Upload Paperless Failed with error: ...", checked with the test key)
const PAPERLESS_REFUSED = /^Upload Paperless Failed/i;

// the suggestions of the check of the fields: none must come (each is a mail to the owner); the
// field names only, never what they hold
function warnValidation(body: ShippyProBody, method: string, log: DeliveryLog): void {
  const found = body.ValidationErrors;
  if (found === undefined || found === null || found === '') return;
  const fields = String(typeof found === 'string' ? found : JSON.stringify(found))
    .match(/Params\.[A-Za-z_.[\]0-9]+/g)
    ?.slice(0, 10);
  log.warn({ method, fields: fields ?? [] }, 'delivery provider: validation suggestions');
}

type Rate = Record<string, unknown>;

// a line of the prices in our words; a price in another currency than the shop's is left out with
// a warning: the account of the provider must charge in the currency of the shop
function optionOf(rate: Rate, log: DeliveryLog): DeliveryOption | null {
  const carrierName = text(rate.carrier);
  const carrierService = text(rate.service);
  const connection = text(rate.carrier_id);
  const price = typeof rate.rate === 'number' ? rate.rate : Number(text(rate.rate));
  if (!carrierName || !carrierService || !connection || !Number.isFinite(price) || price < 0) {
    return null;
  }

  const rateCurrency = text(rate.currency);
  if (rateCurrency && rateCurrency.toUpperCase() !== currency()) {
    log.warn(
      { carrier: carrierName, currency: rateCurrency },
      'delivery provider: a price in another currency than the shop, the carrier is left out',
    );
    return null;
  }

  return {
    carrierName,
    carrierService,
    connection,
    price: money(price),
    days: text(rate.delivery_days),
    label: text(rate.carrier_label) ?? carrierName,
  };
}

async function rates(
  request: DeliveryQuoteRequest,
  log: DeliveryLog,
  only?: { carrierName: string; connection: string },
): Promise<{ options: DeliveryOption[]; errors: Rate[] }> {
  const body = await callShippyPro(
    'GetRates',
    {
      ...shipmentOf(request),
      ShippingService: 'Standard',
      ...(only ? { RateCarriers: [`${only.carrierName}|${only.connection}`] } : {}),
    },
    SHIPPYPRO_TIMEOUTS_MS.rates,
  );
  warnValidation(body, 'GetRates', log);

  if (!Array.isArray(body.Rates))
    throw unavailable({ method: 'GetRates', keys: Object.keys(body) });

  const options = (body.Rates as Rate[])
    .map((rate) => optionOf(rate, log))
    .filter((option): option is DeliveryOption => option !== null)
    // the cheapest first, as ShippyPro gives them; kept stable for the same price
    .map((option, i) => ({ option, i }))
    .sort((a, b) => a.option.price - b.option.price || a.i - b.i)
    .map(({ option }) => option);

  return { options, errors: Array.isArray(body.RatesErrors) ? (body.RatesErrors as Rate[]) : [] };
}

// LabelURL comes as a text, a list of texts, or an empty list when there is no label
function firstLabel(value: unknown): string | null {
  if (Array.isArray(value)) return value.map(https).find((url) => url !== null) ?? null;
  return https(value);
}

// the boxes of a parcel: a number of its own each when the carrier gives one, else none
function boxesOf(parcels: unknown, count: number): DeliveryParcel['boxes'] {
  const given = Array.isArray(parcels) ? (parcels as Record<string, unknown>[]) : [];
  return Array.from({ length: Math.max(count, given.length) }, (_, i) => ({
    trackingNumber: text(given[i]?.TrackingNumber),
    labelUrl: https(given[i]?.LabelURL),
  }));
}

// the number and the link of the carrier; the link only with a number (a failed creation of some
// carriers still gives the address of their tracking page)
function trackingOf(body: ShippyProBody): {
  trackingNumber: string | null;
  trackingUrl: string | null;
} {
  const trackingNumber = text(body.TrackingNumber);
  return { trackingNumber, trackingUrl: trackingNumber ? https(body.TrackingExternalLink) : null };
}

const secretMatches = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const shippyProProvider: DeliveryProvider = {
  name: 'shippypro',
  label: 'ShippyPro',

  isConfigured: shippyProConfigured,

  async quote(request, log) {
    return (await rates(request, log)).options;
  },

  async createParcel(request, log) {
    // the price of this carrier for these boxes is the cost of the send the shop records; asked
    // first, ShippyPro gives no price with the label
    const priced = await rates(request, log, request.option);
    const option = priced.options.find(
      (candidate) =>
        candidate.carrierName === request.option.carrierName &&
        candidate.carrierService === request.option.carrierService &&
        candidate.connection === request.option.connection,
    );

    if (!option) {
      const reason = priced.errors.find(
        (error) =>
          text(error.carrier) === request.option.carrierName ||
          text(error.carrier_id) === request.option.connection,
      );
      throw new ConflictError(DELIVERY_PARCEL_REFUSED, {
        message: text(reason?.error_message) ?? 'The carrier gives no price for this parcel.',
      });
    }

    const body = await callShippyPro(
      'Ship',
      {
        ...shipmentOf(request),
        TransactionID: request.reference,
        CarrierName: option.carrierName,
        CarrierService: option.carrierService,
        CarrierID: Number(option.connection),
        Async: false,
        // kept on the parcel at ShippyPro, findParcel reads it back
        ShipmentCost: option.price,
        ShipmentCostCurrency: currency(),
        ...(request.customs
          ? {
              CN22Info: customsOf(request.customs),
              CustomInfoContentsType: 'merchandise',
              Incoterm: 'DAP',
            }
          : {}),
        // the number of the import scheme of the shop goes with the parcel (any other number on the
        // commercial invoice, customsInvoice)
        ...(request.taxNumber?.kind === 'ioss'
          ? { Attributes: { sp_ioss: request.taxNumber.number } }
          : {}),
      },
      SHIPPYPRO_TIMEOUTS_MS.ship,
    );
    warnValidation(body, 'Ship', log);

    // Result is OK whatever came of it: Status tells, 1 a label, 2 a refusal of the carrier
    const status = text(body.Status);
    const parcelId = text(body.NewOrderID);

    if (status === '2') {
      throw new ConflictError(DELIVERY_PARCEL_REFUSED, {
        message: text(body.ErrorMessage) ?? 'The carrier did not make the parcel.',
      });
    }
    if (status !== '1' || !parcelId) {
      throw unavailable({ method: 'Ship', status, keys: Object.keys(body) });
    }

    return {
      parcelId,
      ...trackingOf(body),
      labelUrl: firstLabel(body.LabelURL),
      boxes: boxesOf(body.Parcels, request.boxes.length),
      weightGrams: request.boxes.reduce((sum, box) => sum + box.weightGrams, 0),
      cost: option.price,
    };
  },

  async findParcel(reference) {
    const now = Math.floor(Date.now() / 1000);
    const list = await callShippyPro('GetShippedOrders', {
      DateMin: now - FIND_DAYS * 86_400,
      DateMax: now + 86_400,
      TransactionID: reference,
    });

    // a voided parcel is no longer on the list; one with an error has status 2
    const found = (Array.isArray(list.Orders) ? (list.Orders as Record<string, unknown>[]) : [])
      .filter(
        (order) => text(order.transaction_id) === reference && text(order.order_status) === '1',
      )
      .map((order) => ({ order, id: Number(text(order.ordine_id)) }))
      .filter(({ id }) => Number.isSafeInteger(id) && id > 0)
      .sort((a, b) => b.id - a.id)[0];
    if (!found) return null;

    const body = await callShippyPro('GetOrder', { OrderID: found.id });
    const cost = Number(text(found.order.shipment_cost));
    const boxes = Array.isArray(found.order.parcels) ? found.order.parcels.length : 1;
    // the weights of its boxes, in kilograms; none told when a box has none
    const weights = (
      Array.isArray(found.order.parcels) ? (found.order.parcels as Record<string, unknown>[]) : []
    ).map((box) => Number(text(box?.weight)));
    const weightGrams =
      weights.length && weights.every((kg) => Number.isFinite(kg) && kg >= 0)
        ? Math.round(weights.reduce((sum, kg) => sum + kg, 0) * 1000)
        : null;

    return {
      parcelId: String(found.id),
      ...trackingOf(body),
      labelUrl: firstLabel(body.LabelURL) ?? https(found.order.label_pdf_url),
      boxes: boxesOf(null, Math.max(boxes, 1)),
      weightGrams,
      cost: Number.isFinite(cost) && cost >= 0 ? money(cost) : 0,
    };
  },

  async voidParcel({ parcelId, carrierName }) {
    if (!(await carrierVoids(carrierName))) return 'unsupported';

    // answers OK whatever it did: only a carrier that voids is asked
    await callShippyPro('VoidShipments', {
      OrderIDS: [Number(parcelId)],
      CarrierName: carrierName,
    });
    return 'voided';
  },

  takesDocuments: carrierTakesDocuments,

  async customsInvoice(request, electronic, log) {
    const body = await callShippyPro(
      'CreateCrossBorderInvoice',
      crossBorderInvoiceOf(request, electronic),
      SHIPPYPRO_TIMEOUTS_MS.ship,
      PAPERLESS_REFUSED,
    );
    warnValidation(body, 'CreateCrossBorderInvoice', log);

    // the field is CrossBorderInvoice (the documentation names it CrossborderInvoice)
    const pdf = text(body.CrossBorderInvoice) ?? text(body.CrossborderInvoice);
    const file = pdf ? Buffer.from(pdf, 'base64') : null;
    if (text(body.Result) !== 'OK' || !file || file.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw unavailable({ method: 'CreateCrossBorderInvoice', keys: Object.keys(body) });
    }
    return file;
  },

  webhook: {
    bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,

    headers: {
      type: 'object',
      additionalProperties: true,
      // not required here: a request without it is refused by the check, 401
      properties: {
        [SHIPPYPRO_SECRET_HEADER]: {
          type: 'string',
          minLength: 1,
          description:
            'The secret of the webhook (`SHIPPYPRO_WEBHOOK_SECRET`), set as a custom header of the webhook in the dashboard of ShippyPro.',
        },
      },
      examples: [{ [SHIPPYPRO_SECRET_HEADER]: 'the-secret-of-the-webhook' }],
    },

    description:
      'ShippyPro posts every event of a parcel of the account as one JSON object (API, Webhook in ' +
      'its dashboard; the events to tick are Order Shipped, Order Error and Tracking Update). It ' +
      'signs no body: the webhook is set with a custom header `X-Webhook-Secret` that holds ' +
      '`SHIPPYPRO_WEBHOOK_SECRET`, compared in constant time. Its events in the words of the shop: ' +
      '`ORDER_SHIPPED` the label was made, `ORDER_ERROR` it was not; `TRACKING_UPDATE` by its ' +
      '`extendedCode` (the same list for every carrier): 2000 to 4999 the carrier has the parcel, ' +
      '6000 and 6900 delivered, 5630 going back to the sender, 5640 back at the sender, 5330 lost; ' +
      'without `extendedCode` by `code`: 2, 3 and 4 the carrier has it, 6 delivered. Every other ' +
      'code is left alone. ShippyPro reports the last state it saw, so a delivery may come without ' +
      'the pickup. It waits for a 200 with a JSON body, and retries every 30 minutes otherwise.',

    check({ headers }) {
      const given = headers[SHIPPYPRO_SECRET_HEADER];
      const value = typeof given === 'string' ? given.trim() : '';
      if (!value) return { verdict: 'missing' };

      const expected = env.SHIPPYPRO_WEBHOOK_SECRET.trim();
      if (!expected) return { verdict: 'unavailable', reason: 'secret_missing' };

      return secretMatches(value, expected)
        ? { verdict: 'valid' }
        : { verdict: 'invalid', reason: 'secret_mismatch' };
    },

    readEvents: (body) => readShippyProEvents(body),

    answer: { received: true },
  },
};
