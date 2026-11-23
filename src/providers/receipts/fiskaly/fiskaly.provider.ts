import { createHash } from 'node:crypto';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { isEuCountry } from '@helpers/party.js';
import { AppError, ServiceUnavailableError } from '@utils/errors.js';

import {
  RECEIPT_PROVIDER_REFUSED,
  RECEIPT_PROVIDER_UNAVAILABLE,
  type ReceiptAnswer,
  type ReceiptLine,
  type ReceiptProvider,
  type ReceiptRequest,
} from '../types.js';

// fiskaly SIGN ES (Verifactu, Spain), REST without its SDK: the invoice of the shop is the receipt
// (a simplified invoice of a retail sale, our series and number; a return, and the money of a return
// that came back, a correcting invoice by differences that names the invoice of the sale). The key of
// the managed organization of the shop gives a token for a day; the taxpayer (the shop, its NIF) is
// made once and never changes (fiskaly: new data, a new managed organization), its signer and its
// client are made once under ids that follow from the key, so a new start finds the same ones. The
// law of Spain lives here only. What the pilot in TEST showed (22.11.2026) is in notes/fiskaly.md:
// the shapes below are the ones the tax authority of the test registered

const BASE = {
  test: 'https://test.es.sign.fiskaly.com/api/v1',
  live: 'https://live.es.sign.fiskaly.com/api/v1',
} as const;

const TIMEOUT_MS = 20_000;

// an id that follows from a text, in the form of a uuid
const uuidOf = (text: string) => {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

let token: { bearer: string; until: number } | null = null;
// the NIF the taxpayer, the signer and the client were checked for in this process
let readyFor: string | null = null;

const base = () => BASE[env.FISKALY_ENVIRONMENT === 'live' ? 'live' : 'test'];

// a refusal the data of the shop has to fix
const refused = (details: Record<string, unknown>): never => {
  throw new AppError({
    statusCode: 502,
    errorCode: RECEIPT_PROVIDER_REFUSED,
    message: 'Bad Gateway',
    details,
  });
};

async function call(method: string, path: string, body?: unknown, auth = true) {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${await bearer()}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new ServiceUnavailableError(RECEIPT_PROVIDER_UNAVAILABLE, undefined, err);
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function bearer(): Promise<string> {
  if (token && token.until > Date.now() + 60_000) return token.bearer;
  const res = await call(
    'POST',
    '/auth',
    { content: { api_key: env.FISKALY_API_KEY, api_secret: env.FISKALY_API_SECRET } },
    false,
  );
  const content = res.json?.content ?? res.json;
  if (res.status !== 200 || !content?.access_token?.bearer) failure(res);
  token = {
    bearer: content.access_token.bearer,
    until: Date.now() + Number(content.access_token.expires_in ?? 3600) * 1000,
  };
  return token.bearer;
}

// a service that does not answer or does not let the app in (a key to fix: the receipts wait), or a
// refusal of the document
function failure(res: { status: number; json: any }): never {
  const content = res.json?.content ?? res.json;
  const code = content?.code ?? null;
  if (res.status >= 500 || res.status === 429 || res.status === 401 || res.status === 403) {
    // a key turned off or a token cut short: the next call asks for a new token
    if (res.status === 401 || res.status === 403) token = null;
    throw new ServiceUnavailableError(RECEIPT_PROVIDER_UNAVAILABLE, { status: res.status, code });
  }
  return refused({
    status: res.status,
    code,
    message: typeof content?.message === 'string' ? content.message.slice(0, 300) : null,
  });
}

// the NIF of the shop as the tax authority writes it: no country prefix, no spaces
const nifOf = (taxId: string | null) =>
  (taxId ?? '')
    .toUpperCase()
    .replace(/[\s.-]/g, '')
    .replace(/^ES/, '');

// the taxpayer, its signer and its client, once a process (and again when the NIF of the shop
// changes: the taxpayer of the key keeps the one it was made with, which refuses every receipt
// until the shop has a new managed organization)
async function ensureReady(): Promise<string> {
  const client = uuidOf(`client:${env.FISKALY_API_KEY}`);
  const settings = shopSettings();
  const nif = nifOf(settings.sellerTaxId);
  if (readyFor === nif) return client;
  if (!nif || !settings.sellerLegalName) refused({ code: 'SELLER_TAX_DATA_REQUIRED' });

  const taxpayer = await call('GET', '/taxpayer');
  if (taxpayer.status === 404) {
    const made = await call('PUT', '/taxpayer', {
      content: {
        issuer: { legal_name: settings.sellerLegalName, tax_number: nif },
        territory: 'SPAIN_OTHER',
      },
    });
    if (made.status >= 300) failure(made);
  } else if (taxpayer.status >= 300) {
    failure(taxpayer);
  } else {
    const own = nifOf(taxpayer.json?.content?.issuer?.tax_number ?? null);
    if (own !== nif) refused({ code: 'TAXPAYER_MISMATCH' });
  }

  const signer = uuidOf(`signer:${env.FISKALY_API_KEY}`);
  // no content: the certificate is fiskaly's (notes/fiskaly.md)
  const s = await call('PUT', `/signers/${signer}`, {});
  if (s.status >= 300 && s.status !== 409) failure(s);
  const c = await call('PUT', `/clients/${client}`, { content: { signer_id: signer } });
  if (c.status >= 300 && c.status !== 409) failure(c);

  readyFor = nif;
  return client;
}

const amount = (n: number, places = 2) => n.toFixed(places);

// how the tax of a line is registered: the VAT of Spain at its rate; the VAT of another country of
// the EU (OSS: not taxed in Spain, the gross holds the tax of that country); an export out of the EU
// (exempt by article 21; the tax of the country of the buyer the shop took there too); no tax in
// another country of the EU by the rules of the place, or in Spain exempt by another cause
function systemOf(request: ReceiptRequest, line: ReceiptLine) {
  const country = request.taxCountry;
  if (request.taxRule === 'recipient') {
    if (country && !isEuCountry(country)) return { type: 'EXPORT', cause: 'TAXABLE_EXEMPT_2' };
    return { type: 'OSS_IOSS', category: { type: 'NO_VAT', cause: 'NON_TAXABLE_3' } };
  }
  if (request.taxRule === 'none' || request.taxRule === 'buyer_at_receipt') {
    if (country && country !== 'ES' && !isEuCountry(country)) {
      return { type: 'EXPORT', cause: 'TAXABLE_EXEMPT_2' };
    }
    if (country && country !== 'ES') {
      return { type: 'REGULAR', category: { type: 'NO_VAT', cause: 'NON_TAXABLE_2' } };
    }
    return { type: 'REGULAR', category: { type: 'NO_VAT', cause: 'TAXABLE_EXEMPT_6' } };
  }
  return line.rate === null
    ? { type: 'REGULAR', category: { type: 'NO_VAT', cause: 'TAXABLE_EXEMPT_6' } }
    : { type: 'REGULAR', category: { type: 'VAT', rate: String(line.rate) } };
}

// the sum a line is registered at: with the VAT of Spain, its gross; without it (another country of
// the EU, an export, an exemption), its net. The record of the tax authority holds the taxes of
// Spain only, its total is the sum of the bases and of those taxes (ImporteTotal; 2005 past 10 of
// difference): the tax of another country stays on the invoice of the buyer
const registeredOf = (system: ReturnType<typeof systemOf>, line: ReceiptLine) =>
  system.category?.type === 'VAT' ? line.gross : line.net;

// our document as a simplified invoice of fiskaly: a line of units at the net of a unit, a sum that
// is not units (the delivery, a part of a refund) as one unit of its net; the total is the sum of
// the lines as registered (in cents, no float left over)
function invoiceOf(request: ReceiptRequest) {
  const lines = request.lines.map((line) => {
    const system = systemOf(request, line);
    return { line, system, cents: Math.round(registeredOf(system, line) * 100) };
  });
  return {
    type: 'SIMPLIFIED',
    series: request.series,
    number: String(request.number),
    text: `${request.series}-${request.number}`,
    full_amount: amount(lines.reduce((sum, one) => sum + one.cents, 0) / 100),
    items: lines.map(({ line, system, cents }) => {
      const units = line.quantity ?? 1;
      return {
        text: line.name.slice(0, 250),
        quantity: String(units),
        unit_amount: amount(line.net / units, 8),
        full_amount: amount(cents / 100),
        ...(system.type === 'EXPORT' ? { concept: 'INTERNATIONAL_GOOD' } : {}),
        system,
      };
    }),
  };
}

// the image of the code to print: a png or a jpeg in base64 (a data url gives its data), of 150 KB at
// most; anything else is not kept (the receipt keeps its number and its link)
function codeImageOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const data = value.replace(/^data:image\/(png|jpeg);base64,/, '');
  if (data.length > 200_000 || !/^[A-Za-z0-9+/]+=*$/.test(data)) return null;
  const head = Buffer.from(data.slice(0, 16), 'base64');
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const jpeg = head[0] === 0xff && head[1] === 0xd8;
  return png || jpeg ? data : null;
}

function answerOf(content: any): ReceiptAnswer {
  const registration = content?.transmission?.registration;
  if (
    registration === 'REQUIRES_CORRECTION' ||
    registration === 'REQUIRES_INSPECTION' ||
    registration === 'INVALID'
  ) {
    const validations = Array.isArray(content?.validations) ? content.validations : [];
    refused({
      registration,
      validations: validations.slice(0, 3).map((v: any) => ({
        code: String(v?.code ?? ''),
        description: String(v?.description ?? '').slice(0, 200),
      })),
    });
  }
  const compliance = content?.compliance ?? {};
  const image = compliance.code?.image;
  return {
    state: registration === 'REGISTERED' ? 'registered' : 'pending',
    // the code of the registration at the tax authority, once there is one; till then the id of
    // the invoice at fiskaly
    number: content?.transmission?.registration_csv ?? content?.id ?? null,
    // the buyer is given the link: https only
    url:
      typeof compliance.url === 'string' && /^https:\/\/\S+$/.test(compliance.url)
        ? compliance.url
        : null,
    code: codeImageOf(typeof image === 'string' ? image : (image?.data ?? null)),
    // the words above the code and the mark below it ("QR tributario:|VERI*FACTU"), a line each
    text: typeof compliance.text === 'string' ? compliance.text.split('|').join('\n') : null,
  };
}

async function issue(request: ReceiptRequest): Promise<ReceiptAnswer> {
  if (request.currency !== 'EUR') refused({ code: 'CURRENCY_NOT_SUPPORTED' });
  const client = await ensureReady();
  const id = uuidOf(request.key);
  const content =
    request.kind === 'sale'
      ? invoiceOf(request)
      : {
          type: 'CORRECTING',
          id: uuidOf(request.correctsKey ?? ''),
          method: 'DIFFERENCES',
          code: 'CORRECTION_1',
          reference_original_id: true,
          invoice: invoiceOf(request),
        };

  const res = await call('PUT', `/clients/${client}/invoices/${id}`, { content });
  if (res.status === 409) {
    // the same document asked again (a try after a time-out): what the service has of it; none
    // when another invoice holds the number in its series
    return (await stateOf(client, request)) ?? refused({ code: 'NUMBER_TAKEN' });
  }
  if (res.status >= 300) failure(res);
  return answerOf(res.json?.content);
}

// what the service has of a receipt, null when it has none
async function stateOf(client: string, request: ReceiptRequest): Promise<ReceiptAnswer | null> {
  const res = await call('GET', `/clients/${client}/invoices/${uuidOf(request.key)}`);
  if (res.status === 404) return null;
  if (res.status >= 300) failure(res);
  return answerOf(res.json?.content);
}

// the service does not have it: it was never taken, it is sent now
async function status(request: ReceiptRequest): Promise<ReceiptAnswer> {
  const client = await ensureReady();
  return (await stateOf(client, request)) ?? issue(request);
}

export const fiskalyReceiptProvider: ReceiptProvider = {
  name: 'fiskaly',
  label: 'fiskaly SIGN ES',
  makesReceipts: () => true,
  isConfigured: () => Boolean(env.FISKALY_API_KEY && env.FISKALY_API_SECRET),
  // a taxpayer of Spain; the invoice is the receipt, registered when it is made (at the payment)
  sellerCountries: () => ['ES'],
  fixedMoment: () => 'payment',
  issue,
  status,
};
