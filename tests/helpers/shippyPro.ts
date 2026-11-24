import { createClient } from 'redis';

// no import of @config/env.js here: tests/setup/integration.setup.ts imports this file before it puts
// the env of the tests in place, and env.ts would take the values of .env
import { isRealService } from './services.js';

// ShippyPro in the integration tests (tests/setup/integration.shippypro.ts puts it in place for every
// file): a mock of its api at the level of http, the way it answered for real (15.11.2026,
// notes/delivery-shippypro.md): the errors come with 200 (Status "2", Error, RatesErrors), LabelURL is
// a text, a list or an empty list, Parcels is null or a list, VoidShipments always answers OK and a
// voided parcel only leaves GetShippedOrders, a request without the four fields of the insurance and
// the cash on delivery gets ValidationErrors.
// Without service:shippypro nothing reaches the service: every request is answered here, the key is
// made up. With it (npm test -- service:shippypro) every test asks the real account whatever it can
// without a label: the prices of its carriers (REAL_CARRIERS), the parcels and the voids of the parcels
// it made, the catalog of the carriers. A label never: every parcel is made by the mock in both
// modes (each real Ship takes a label of the account, which has no sandbox). What the real account cannot be made to do answers from the mock in both modes: a
// carrier that voids and numbers each box (MockExpress), a carrier list a test sets, every way the
// service does not answer, a refusal of the carrier, the events of the webhook. The requests of a
// real run go one at a time at the pace the account takes (inTurn, askReal: any plan, the trial
// one too), and the account needs the carrier Generic as MOCK_CARRIERS has it

export const SHIPPYPRO_ORIGIN = 'https://api.shippypro.com';

export const realShippyPro = isRealService('shippypro');

// a carrier connected to the account of the mock: its table of prices by the total weight, in
// kilograms (a weight no range holds gets no price), what it gives with a label and whether it voids
export type MockCarrier = {
  name: string;
  id: number;
  service: string;
  label: string;
  slug: string;
  currency: string;
  days: string;
  ranges: { upToKg: number; price: number }[];
  // a number of the carrier, and one a box
  tracking: boolean;
  multiTracking: boolean;
  labelAs: 'text' | 'list';
  voids: boolean;
  // takes a commercial invoice electronically with the parcel (the service etd)
  etd: boolean;
};

// Generic is the carrier of ShippyPro for tests, as the real account has it (0-5 kg 4 EUR, up to
// 500 kg 10 EUR, no number, no void and no etd in its capabilities); the other one is a made-up
// carrier with a number a box, a label in a list, a void and the commercial invoice electronically
export const MOCK_CARRIERS: readonly MockCarrier[] = [
  {
    name: 'Generic',
    id: 6001,
    service: 'Standard',
    label: 'Generic test',
    slug: 'generic',
    currency: 'EUR',
    days: '1-10',
    ranges: [
      { upToKg: 5, price: 4 },
      { upToKg: 500, price: 10 },
    ],
    tracking: false,
    multiTracking: false,
    labelAs: 'text',
    voids: false,
    etd: false,
  },
  {
    name: 'MockExpress',
    id: 7001,
    service: 'Express',
    label: 'Mock express',
    slug: 'mockexpress',
    currency: 'EUR',
    days: '1-2',
    ranges: [
      { upToKg: 2, price: 6.5 },
      { upToKg: 30, price: 12 },
    ],
    tracking: true,
    multiTracking: true,
    labelAs: 'list',
    voids: true,
    etd: true,
  },
];

type MockOrder = {
  id: number;
  transactionId: string;
  carrier: MockCarrier;
  status: '1' | '2';
  cost: number;
  createdAt: number;
  boxes: number;
  // what its boxes weigh together
  kg: number;
  trackingNumber: string;
  labelUrl: string;
  voided: boolean;
  // the number of the import scheme it was made with (Attributes.sp_ioss)
  ioss: string | null;
  // the commercial invoices made of it, each with whether it went to the carrier (UploadETD)
  invoices: { electronic: boolean; params: Record<string, unknown> }[];
};

export type ShippyProCall = { method: string; params: Record<string, unknown> };

// the ways ShippyPro does not answer: its limit of requests, nothing at all, no answer until the app
// gives up, an error of the request as a whole, a page that is no json, json that is no object
export type ShippyProOutage = '429' | 'unreachable' | 'hangs' | 'error' | 'html' | 'list';

let carriers: MockCarrier[] = [...MOCK_CARRIERS];
const orders: MockOrder[] = [];
// the ids of the parcels of the mock: of this process and this moment, so the parcels of every file
// of a run (and of the runs before it, on a database kept) never meet
let nextId =
  Number(`${process.pid % 100_000}${String(Date.now() % 1_000_000).padStart(6, '0')}`) * 1000;
let outage: ShippyProOutage | null = null;
let refusals: (string | null)[] = [];
const watchers = new Set<ShippyProCall[]>();
// what a test does while a request of a method is on its way, once
const meanwhile = new Map<string, () => Promise<void>>();
// how many requests reached the real service
let realRequests = 0;

// the carriers of the real account the tests ask in the real mode; any other carrier the account has
// is left out of its answers, so a test never sees, nor makes a label of, one the tests do not know
const REAL_CARRIERS = ['Generic'];
// the pace of v1 for the processes of a run (inTurn): one request at a time, the next once the one
// before was answered this long ago. It starts at the limit of the documentation (20 requests in 10
// seconds) and doubles, for the rest of the run, every time the account is closed by a 429: the
// limit of an account is of its plan (the trial one took 10 at once and then about one in 2 to 3
// seconds, 23.11.2026), so any account ends at the pace it takes
const V1_FIRST_SPACING_MS = 550;
const V1_MAX_SPACING_MS = 8_000;
// a request the account answered 429 waits as long as it said (Retry-After, 60 seconds without it)
// and goes again, this many times at most before the test gets the 429
const V1_TRIES = 6;
// the time of a real request once its turn came, the one the app gives it
// (SHIPPYPRO_TIMEOUTS_MS of src/providers/delivery/shippypro/shippyProClient.ts): the wait for the
// turn is no time of the app's, which the mock checks (an outage of the kind timeout)
const realTimeoutOf = (method: string): number => (method === 'GetRates' ? 8_000 : 10_000);

// the limit of a test in the real mode: its requests wait for their turns at the account, one at a
// time for the whole run and longer while the account is closed (tests/setup/integration.shippypro.ts)
export const shippyProWait: number | undefined = realShippyPro ? 300_000 : undefined;

// what the real account said of its carriers: their own id, service, words and days
type RealCarrier = Pick<MockCarrier, 'id' | 'service' | 'label' | 'days'>;
const learned = new Map<string, RealCarrier>();

// a carrier of the list as no test changed it answers from the real service in the real mode
const realBacked = (carrier: MockCarrier): boolean =>
  realShippyPro && REAL_CARRIERS.includes(carrier.name) && MOCK_CARRIERS.includes(carrier);

// a carrier as the mock tells it: with the id and the words of the real account once it gave them
const viewOf = (carrier: MockCarrier): MockCarrier => {
  const real = MOCK_CARRIERS.includes(carrier) ? learned.get(carrier.name) : undefined;
  return real ? { ...carrier, ...real } : carrier;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const abortError = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

function outageAnswer(kind: ShippyProOutage, init: RequestInit | undefined): Promise<Response> {
  switch (kind) {
    case '429':
      return Promise.resolve(json({ message: 'Too Many Requests' }, 429));
    case 'unreachable':
      return Promise.reject(new TypeError('fetch failed'));
    case 'error':
      return Promise.resolve(json({ Error: 'Internal error, try again later' }));
    case 'html':
      return Promise.resolve(
        new Response('<html><body>Bad gateway</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );
    case 'list':
      return Promise.resolve(json([]));
    case 'hangs':
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener('abort', () => reject(abortError()));
      });
  }
}

const MONEY_FIELDS = ['Insurance', 'InsuranceCurrency', 'CashOnDelivery', 'CashOnDeliveryCurrency'];

// what ShippyPro suggests about the fields it checks without blocking the request
function validationOf(params: Record<string, unknown>): string | null {
  const missing = MONEY_FIELDS.filter((field) => params[field] === undefined);
  return missing.length
    ? missing.map((field) => `Params.${field}: The property ${field} is required`).join(', ')
    : null;
}

type Box = { length?: unknown; width?: unknown; height?: unknown; weight?: unknown };

const totalKg = (parcels: unknown): number =>
  (Array.isArray(parcels) ? (parcels as Box[]) : []).reduce(
    (sum, box) => sum + Number(box.weight ?? 0),
    0,
  );

const priceOf = (carrier: MockCarrier, kg: number): number | null =>
  carrier.ranges.find((range) => kg <= range.upToKg)?.price ?? null;

function ratesOf(params: Record<string, unknown>, list: MockCarrier[] = carriers) {
  const only = Array.isArray(params.RateCarriers) ? (params.RateCarriers as string[]) : null;
  const kg = totalKg(params.parcels);
  const asked = list.map(viewOf).filter((c) => !only || only.includes(`${c.name}|${c.id}`));

  const rates = asked
    .map((carrier) => ({ carrier, price: priceOf(carrier, kg) }))
    .filter((entry) => entry.price !== null)
    .sort((a, b) => a.price! - b.price!)
    .map(({ carrier, price }) => ({
      carrier: carrier.name,
      carrier_id: String(carrier.id),
      carrier_label: carrier.label,
      order_id: '',
      rate: price,
      rate_id: String(17_947_000_000_000 + carrier.id),
      delivery_days: carrier.days,
      service: carrier.service,
      currency: carrier.currency,
      zone_name: 'Globo',
      weight_range: '0-500',
      detailed_pricing: [{ type: 'tariff', price, desc: 'Tariff' }],
    }));

  const errors = asked
    .filter((carrier) => priceOf(carrier, kg) === null)
    .map((carrier) => ({
      carrier: carrier.name,
      carrier_id: String(carrier.id),
      error_message: `There were no weight ranges matching ${kg} kg for this carrier`,
      error_level: 1,
    }));

  return { Rates: rates, RatesErrors: errors };
}

// the carrier of the list a parcel names, as the mock tells it
const shipCarrierOf = (params: Record<string, unknown>): MockCarrier | undefined =>
  carriers.find((raw) => {
    const c = viewOf(raw);
    return (
      c.name === params.CarrierName &&
      c.service === params.CarrierService &&
      c.id === params.CarrierID
    );
  });

function ship(params: Record<string, unknown>) {
  const named = shipCarrierOf(params);
  const carrier = named && viewOf(named);
  const id = nextId++;
  const transactionId = String(params.TransactionID ?? '');
  const boxes = Array.isArray(params.parcels) ? params.parcels.length : 0;
  const refusal = refusals.shift() ?? (carrier ? null : 'Carrier not found');

  if (refusal) {
    orders.push({
      id,
      transactionId,
      carrier: carrier ?? carriers[0]!,
      status: '2',
      cost: 0,
      createdAt: Math.floor(Date.now() / 1000),
      boxes,
      kg: totalKg(params.parcels),
      trackingNumber: '',
      labelUrl: '',
      voided: false,
      ioss: null,
      invoices: [],
    });
    return {
      Result: 'OK',
      NewOrderID: String(id),
      Parcels: null,
      LabelURL: [],
      PDF: '',
      ZPL: '',
      TrackingCarrier: String(params.CarrierName ?? ''),
      TrackingNumber: '',
      TrackingExternalLink: 'https://track.example.com/',
      AdditionalTrackingNumbers: [],
      DeliveryCarrier: null,
      Status: '2',
      ErrorMessage: refusal,
      ErrorType: {},
      ErrorSuggestion: {},
    };
  }

  const c = carrier!;
  const trackingNumber = c.tracking ? `MX${id}` : '';
  const labelUrl = `https://cdn.shippypro.example/labels/label-${id}.pdf`;
  orders.push({
    id,
    transactionId,
    carrier: c,
    status: '1',
    cost: Number(params.ShipmentCost ?? 0),
    createdAt: Math.floor(Date.now() / 1000),
    boxes,
    kg: totalKg(params.parcels),
    trackingNumber,
    labelUrl,
    voided: false,
    ioss: iossOf(params),
    invoices: [],
  });

  return {
    Result: 'OK',
    NewOrderID: String(id),
    Parcels: c.multiTracking
      ? Array.from({ length: boxes }, (_, i) => ({
          TrackingNumber: `${trackingNumber}-${i + 1}`,
          PDF: 'JVBERi0xLjQK',
        }))
      : null,
    LabelURL: c.labelAs === 'text' ? labelUrl : [labelUrl],
    PDF: ['JVBERi0xLjQK'],
    ZPL: [],
    TrackingCarrier: c.name,
    TrackingNumber: trackingNumber,
    TrackingExternalLink: trackingNumber ? `https://track.example.com/${trackingNumber}` : '',
    AdditionalTrackingNumbers: [],
    DeliveryCarrier: null,
    Status: '1',
  };
}

const iossOf = (params: Record<string, unknown>): string | null => {
  const attributes = params.Attributes as Record<string, unknown> | undefined;
  return typeof attributes?.sp_ioss === 'string' ? attributes.sp_ioss : null;
};

// a pdf of one empty page, the way ShippyPro gives a commercial invoice (base64)
const INVOICE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
).toString('base64');

// the fields CreateCrossBorderInvoice requires (the specification of v1), of the invoice, of a party
// and of a line of the goods
const INVOICE_FIELDS = [
  'Incoterm',
  'TypeOfExport',
  'OrderId',
  'InvoiceNumber',
  'DateOfExportation',
  'ShipperExporter',
  'Consignee',
  'Goods',
];
const PARTY_FIELDS = ['Name', 'Address', 'Zipcode', 'City', 'Country', 'Telephone'];
const GOODS_FIELDS = ['ParcelCount', 'Description', 'HsCode', 'Quantity', 'Weight', 'UnitValue'];

const missingOf = (value: unknown, fields: readonly string[]): string[] =>
  fields.filter((field) => {
    const v = (value as Record<string, unknown> | undefined)?.[field];
    return v === undefined || v === null;
  });

// a commercial invoice of a live parcel of the mock: its pdf, and sent to the carrier when UploadETD
// is there (any value) and the carrier takes it; refused in the words of ShippyPro when it does not
function crossBorderInvoice(params: Record<string, unknown>) {
  const goods = Array.isArray(params.Goods) ? (params.Goods as unknown[]) : [];
  const missing = [
    ...missingOf(params, INVOICE_FIELDS),
    ...missingOf(params.ShipperExporter, PARTY_FIELDS).map((f) => `ShipperExporter.${f}`),
    ...missingOf(params.Consignee, PARTY_FIELDS).map((f) => `Consignee.${f}`),
    ...goods.flatMap((line, i) => missingOf(line, GOODS_FIELDS).map((f) => `Goods[${i}].${f}`)),
    ...(goods.length ? [] : ['Goods[0]']),
  ];
  if (missing.length) return { Error: `Missing required fields: ${missing.join(', ')}` };

  const order = orders.find(
    (candidate) =>
      String(candidate.id) === String(params.OrderId) &&
      candidate.status === '1' &&
      !candidate.voided,
  );
  if (!order) return { Error: 'Order not found' };

  const electronic = params.UploadETD !== undefined;
  if (electronic && !order.carrier.etd) {
    return {
      Error:
        'Upload Paperless Failed with error: The selected order is not valid for this operation',
    };
  }
  order.invoices.push({ electronic, params });
  return { Result: 'OK', CrossBorderInvoice: INVOICE_PDF };
}

function shippedOrders(params: Record<string, unknown>) {
  const min = Number(params.DateMin ?? 0);
  const max = Number(params.DateMax ?? Number.MAX_SAFE_INTEGER);
  const tx = params.TransactionID === undefined ? null : String(params.TransactionID);
  const found = orders.filter(
    (order) =>
      !order.voided &&
      order.createdAt >= min &&
      order.createdAt <= max &&
      (tx === null || order.transactionId === tx),
  );

  return {
    Result: 'OK',
    Total: found.length,
    Orders: found.map((order) => ({
      ordine_id: String(order.id),
      transaction_id: order.transactionId,
      order_status: order.status,
      order_error_message: order.status === '2' ? 'refused' : '',
      carrier_name: order.carrier.name,
      carrier_id: String(order.carrier.id),
      tracking_code: order.trackingNumber,
      label_pdf_url: order.labelUrl,
      shipment_cost: String(order.cost),
      shipment_cost_currency: order.carrier.currency,
      created_at: String(order.createdAt),
      archived: '0',
      parcels: Array.from({ length: order.boxes }, () => ({
        length: 30,
        width: 20,
        height: 10,
        weight: order.kg / order.boxes,
      })),
      items: [],
    })),
  };
}

function orderOf(params: Record<string, unknown>) {
  const order = orders.find((candidate) => candidate.id === params.OrderID);
  if (!order) return { Error: 'Order not found' };

  return {
    Result: 'OK',
    OrderID: String(order.id),
    TransactionID: order.transactionId,
    CarrierID: String(order.carrier.id),
    TrackingCarrier: order.carrier.name,
    TrackingNumber: order.trackingNumber,
    TrackingExternalLink: order.trackingNumber
      ? `https://track.example.com/${order.trackingNumber}`
      : '',
    AdditionalTrackingNumbers: [],
    Status: order.status,
    LabelURL: order.labelUrl ? [order.labelUrl] : [],
  };
}

function voidShipments(params: Record<string, unknown>) {
  const ids = Array.isArray(params.OrderIDS) ? (params.OrderIDS as unknown[]) : [];
  if (ids.some((id) => typeof id !== 'number')) {
    return {
      Result: 'OK',
      ValidationErrors: 'Params.OrderIDS[0]: String value found, but an integer is required',
    };
  }
  for (const order of orders) if (ids.includes(order.id)) order.voided = true;
  return { Result: 'OK' };
}

function answerV1(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'Ping':
      return { Result: true };
    case 'GetCarriers':
      return {
        Carriers: Object.fromEntries(
          carriers.map(viewOf).map((c) => [
            c.name,
            [
              {
                CarrierID: String(c.id),
                CarrierService: c.service,
                ServicesList: c.service,
                Label: c.label,
              },
            ],
          ]),
        ),
      };
    case 'GetRates': {
      const validation = validationOf(params);
      return { ...ratesOf(params), ...(validation ? { ValidationErrors: validation } : {}) };
    }
    case 'Ship': {
      const validation = validationOf(params);
      return { ...ship(params), ...(validation ? { ValidationErrors: validation } : {}) };
    }
    case 'GetShippedOrders':
      return shippedOrders(params);
    case 'GetOrder':
      return orderOf(params);
    case 'VoidShipments':
      return voidShipments(params);
    case 'CreateCrossBorderInvoice':
      return crossBorderInvoice(params);
    default:
      return { Error: `Method ${method} not found` };
  }
}

// the catalog of the carriers the way ShippyPro lists them, of the carriers given
function catalogOf(list: MockCarrier[]) {
  return [
    ...list.map((c) => ({
      slug: c.slug,
      name: c.name,
      version: 'V1',
      supportedCountries: ['ALL'],
      authType: 'none',
      isLegacy: false,
      status: 'ACTIVE',
      replacedBy: null,
    })),
    // an old entry of the same name, the way the catalog keeps the carriers it replaced
    ...(list.some((c) => c.name === 'MockExpress')
      ? [
          {
            slug: 'mockexpress-legacy',
            name: 'MockExpress',
            version: 'V1',
            supportedCountries: ['ALL'],
            authType: 'none',
            isLegacy: true,
            status: 'DEPRECATED',
            replacedBy: 'mockexpress',
          },
        ]
      : []),
  ];
}

function answerV2(path: string): Response {
  if (path === '/v2/carriers') {
    const data = catalogOf(carriers);
    return json({ data, pagination: { pageSize: data.length, hasMore: false } });
  }

  const slug = /^\/v2\/carriers\/([^/]+)\/capabilities$/.exec(path)?.[1];
  const carrier = carriers.find((c) => c.slug === slug);
  if (!carrier) return json({ error: { code: 'NOT_FOUND', message: 'Carrier not found' } }, 404);

  const service = (available: boolean) => ({
    available,
    ...(available ? {} : { reason: 'This service is not available for this carrier.' }),
    authType: null,
    serviceTypes: [],
    labelTypes: [],
    features: {},
  });
  return json({
    slug: carrier.slug,
    status: 'ACTIVE',
    replacedBy: null,
    services: {
      shipment: service(true),
      tracking: service(carrier.tracking),
      voidShipment: service(carrier.voids),
      etd: service(carrier.etd),
    },
  });
}

// in place for the whole test file, by assignment and not jest.spyOn: restoreAllMocks of a test must
// not take it away. Every other request passes untouched
export function installShippyPro(): void {
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== SHIPPYPRO_ORIGIN) return realFetch(input, init);

    let method = url.pathname;
    let params: Record<string, unknown> = {};
    if (url.pathname.startsWith('/v1/')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { Params?: Record<string, unknown> };
      method = url.pathname.slice('/v1/'.length);
      params = body.Params ?? {};
    }
    watchers.forEach((calls) => calls.push({ method, params }));

    const act = meanwhile.get(method);
    if (act) {
      meanwhile.delete(method);
      await act();
    }

    if (outage) return outageAnswer(outage, init);

    if (realShippyPro) {
      // the signal of the app is left out: a request that waited for its turn would be past the
      // time the app gives it; once it goes it has that time of its own
      const answer = await realAnswer(method, params, url.pathname, () =>
        askReal(url.pathname, () =>
          realFetch(input, { ...init, signal: AbortSignal.timeout(realTimeoutOf(method)) }),
        ),
      );
      if (answer) return answer;
    }

    return url.pathname.startsWith('/v1/')
      ? json(answerV1(method, params))
      : answerV2(url.pathname);
  }) as typeof fetch;
}

// the client of the redis of the tests that keeps the processes of a real run below the limit of
// the requests of the account
let limits: ReturnType<typeof createClient> | null = null;

async function limitsClient() {
  // the redis of the tests (tests/setup/integration.setup.ts), read when the first request goes
  limits ??= createClient({ url: process.env.REDIS_URL });
  if (!limits.isOpen) await limits.connect();
  return limits;
}

// the real time: a test may move the clock of the app (Date.now), the windows of the limit are of
// every process of the run
const realNow = () => Math.floor(performance.timeOrigin + performance.now());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// the requests of v1 of every process of the run, in one sorted set: at the moment one went and,
// once answered, at the moment of its answer (the service counts it between the two); the pace
// (the spacing of now) and the moment the account opens again after a 429
const V1_KEY = 'test:shippypro:v1';
const V1_SPACING_KEY = 'test:shippypro:v1:spacing';
const V1_CLOSED_KEY = 'test:shippypro:v1:closed';

// a request of v1 waits for its turn: while the account is closed, and until no other request went
// or was answered within the spacing
async function inTurn(): Promise<string> {
  const redis = await limitsClient();
  for (;;) {
    const now = realNow();
    const closedUntil = Number((await redis.get(V1_CLOSED_KEY)) ?? 0);
    if (closedUntil > now) {
      await sleep(closedUntil - now + 50);
      continue;
    }
    const spacing = Number((await redis.get(V1_SPACING_KEY)) ?? V1_FIRST_SPACING_MS);
    await redis.zRemRangeByScore(V1_KEY, 0, now - spacing);
    const member = `${now}-${process.pid}-${Math.random()}`;
    await redis.zAdd(V1_KEY, { score: now, value: member });
    await redis.expire(V1_KEY, 60);
    // the first of the spacing: no other request in it
    if ((await redis.zRank(V1_KEY, member)) === 0) return member;
    await redis.zRem(V1_KEY, member);
    const [oldest] = await redis.zRangeWithScores(V1_KEY, 0, 0);
    const wait = (oldest ? oldest.score + spacing - now : 100) + 20;
    await sleep(Math.min(Math.max(wait, 20), V1_MAX_SPACING_MS));
  }
}

// a request of v1 counted from the moment of its answer (or of its failure)
async function answered(member: string): Promise<void> {
  const redis = await limitsClient();
  await redis.zAdd(V1_KEY, { score: realNow(), value: member });
  await redis.expire(V1_KEY, 60);
}

// the account answered 429: closed for every process as long as it said, and, the first 429 of a
// close, the pace halved for the rest of the run
async function closedFor(retryAfter: string | null): Promise<void> {
  const redis = await limitsClient();
  const now = realNow();
  const seconds = Number(retryAfter);
  const until = now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
  const before = Number((await redis.get(V1_CLOSED_KEY)) ?? 0);
  if (until > before) await redis.set(V1_CLOSED_KEY, String(until), { PX: until - now + 1000 });
  if (before <= now) {
    const spacing = Number((await redis.get(V1_SPACING_KEY)) ?? V1_FIRST_SPACING_MS);
    await redis.set(V1_SPACING_KEY, String(Math.min(spacing * 2, V1_MAX_SPACING_MS)), {
      EX: 3600,
    });
  }
}

// a request the account did not answer in its time goes again after a pause, this many times at
// most: a slow answer now and then, even twice in a row (23.11.2026), is of the service, not of the
// app (the mock checks the app past its time: an outage of the kind timeout)
const timedOut = (err: unknown) => err instanceof Error && err.name === 'TimeoutError';
const SLOW_TRIES = 3;
const SLOW_PAUSE_MS = 3_000;

async function askReal(path: string, ask: () => Promise<Response>): Promise<Response> {
  if (!path.startsWith('/v1/')) {
    for (let slow = 1; ; slow += 1) {
      realRequests += 1;
      try {
        return await ask();
      } catch (err) {
        if (!timedOut(err) || slow === SLOW_TRIES) throw err;
      }
      await sleep(SLOW_PAUSE_MS);
    }
  }
  let slow = 0;
  for (let tries = 1; ; tries += 1) {
    const member = await inTurn();
    realRequests += 1;
    let answer: Response;
    try {
      answer = await ask();
    } catch (err) {
      slow += 1;
      if (!timedOut(err) || slow === SLOW_TRIES) throw err;
      await sleep(SLOW_PAUSE_MS);
      continue;
    } finally {
      await answered(member);
    }
    if (answer.status !== 429 || tries === V1_TRIES) return answer;
    await closedFor(answer.headers.get('retry-after'));
  }
}

const isMockOrder = (id: unknown) => orders.some((order) => order.id === Number(id));

// the answer of the real service where it can give one, null where the mock answers (the real
// mode only)
async function realAnswer(
  method: string,
  params: Record<string, unknown>,
  path: string,
  ask: () => Promise<Response>,
): Promise<Response | null> {
  switch (method) {
    case 'Ping':
    case 'GetCarriers':
      return ask();
    case 'GetRates': {
      const only = Array.isArray(params.RateCarriers) ? (params.RateCarriers as string[]) : null;
      const real = carriers
        .filter(realBacked)
        // by the name: the id of the account a process knows only once it asked the prices itself,
        // and a price the cart took from the redis of the run may be of another process
        .filter((c) => !only || only.some((one) => one.startsWith(`${c.name}|`)));
      if (!real.length) return null;
      const answer = await ask();
      if (!answer.ok) return answer;
      const body = (await answer.json()) as Record<string, unknown>;
      if (!Array.isArray(body.Rates)) return json(body);
      const names = real.map((c) => c.name);
      type Rate = { carrier: string; carrier_id: string; service: string; rate: number } & Record<
        string,
        unknown
      >;
      const rates = (body.Rates as Rate[]).filter((rate) => names.includes(rate.carrier));
      for (const rate of rates) {
        learned.set(rate.carrier, {
          id: Number(rate.carrier_id),
          service: rate.service,
          label: String(rate.carrier_label ?? rate.carrier),
          days: String(rate.delivery_days ?? ''),
        });
      }
      const errors = (Array.isArray(body.RatesErrors) ? (body.RatesErrors as Rate[]) : []).filter(
        (error) => names.includes(error.carrier),
      );
      const mock = ratesOf(
        params,
        carriers.filter((c) => !realBacked(c)),
      );
      return json({
        ...body,
        Rates: [...rates, ...mock.Rates].sort((a, b) => Number(a.rate) - Number(b.rate)),
        RatesErrors: [...errors, ...mock.RatesErrors],
      });
    }
    // a parcel is never made at the real account: every Ship takes a label of it (the user, 16.11.2026:
    // the real mode tests all it can, no label spent), the mock makes it in both modes
    case 'Ship':
      return null;
    case 'GetShippedOrders': {
      const tx = params.TransactionID === undefined ? null : String(params.TransactionID);
      if (tx === null || orders.some((order) => order.transactionId === tx)) return null;
      return ask();
    }
    case 'GetOrder':
      return isMockOrder(params.OrderID) ? null : ask();
    case 'VoidShipments': {
      const ids = Array.isArray(params.OrderIDS) ? (params.OrderIDS as unknown[]) : [];
      return ids.length && ids.every(isMockOrder) ? null : ask();
    }
    // the parcels are of the mock in both modes (Ship above): so are their invoices
    case 'CreateCrossBorderInvoice':
      return isMockOrder(params.OrderId) ? null : ask();
  }

  if (path === '/v2/carriers') {
    const answer = await ask();
    if (!answer.ok) return answer;
    const body = (await answer.json()) as { data?: unknown[] } & Record<string, unknown>;
    return json({
      ...body,
      data: [...(body.data ?? []), ...catalogOf(carriers.filter((c) => !realBacked(c)))],
    });
  }
  const slug = /^\/v2\/carriers\/([^/]+)\/capabilities$/.exec(path)?.[1];
  if (slug) {
    const mockOnly = carriers.filter((c) => !realBacked(c)).map((c) => c.slug);
    return mockOnly.includes(slug) || slug === 'mockexpress-legacy' ? null : ask();
  }
  // nothing else of the account is read (its configurations of the carriers hold their keys)
  return null;
}

// the end of a test file: the client of the limits goes
export async function closeShippyPro(): Promise<void> {
  if (limits?.isOpen) await limits.quit();
  limits = null;
}

// the steady carrier of the tests (Generic) as the buyer gets it: the one of the real account in the
// real mode once it gave its prices, the one of the mock otherwise
export function steadyCarrierChoice(): { name: string; service: string; connection: string } {
  const c = viewOf(MOCK_CARRIERS[0]!);
  return { name: c.name, service: c.service, connection: String(c.id) };
}

export function steadyCarrierWords(): { label: string; days: string | null } {
  const c = viewOf(MOCK_CARRIERS[0]!);
  return { label: c.label.trim() || c.name, days: c.days.trim() || null };
}

// after every test: the carriers, the outage, the refusals and the watchers are what they were; the
// parcels stay, as they do at ShippyPro
export function resetShippyPro(): void {
  carriers = [...MOCK_CARRIERS];
  outage = null;
  refusals = [];
  watchers.clear();
  meanwhile.clear();
}

// a copy of every request the app sends to ShippyPro from now until the test ends
export function watchShippyPro(): ShippyProCall[] {
  const calls: ShippyProCall[] = [];
  watchers.add(calls);
  return calls;
}

// what happens while the next request of the method (GetRates, Ship, ...) is on its way to
// ShippyPro: the test acts there as another request of the app would, before the answer comes
export function whileShippyPro(method: string, act: () => Promise<void>): void {
  meanwhile.set(method, act);
}

// ShippyPro does not answer the way the outage says until the test ends, in both modes
export function breakShippyPro(kind: ShippyProOutage): void {
  outage = kind;
}

// the carrier refuses the next parcels with these reasons (Status "2"); null makes that one
export function refuseNextParcel(...reasons: (string | null)[]): void {
  refusals.push(...reasons);
}

// the carriers of the account until the test ends
export function useCarriers(list: MockCarrier[]): void {
  carriers = list;
}

// a parcel of the mock by its id, as ShippyPro keeps it; null when it has none
export function mockParcel(parcelId: string): Readonly<MockOrder> | null {
  return orders.find((order) => String(order.id) === parcelId) ?? null;
}

export const realRequestsMade = (): number => realRequests;

// the secret of the webhook in the tests (tests/setup/integration.setup.ts)
export const SHIPPYPRO_TEST_WEBHOOK_SECRET = 'cartlify-tests-delivery-webhook-secret';

// a body of the webhook the way ShippyPro posts it (notes/delivery-shippypro.md, part 8)
export function shippyProWebhookBody(
  event: 'shipped' | 'error' | 'tracking',
  parcel: { parcelId: string; reference: string; trackingNumber?: string | null },
  tracking: { code?: number; extendedCode?: string | null; date?: number } = {},
): Record<string, unknown> {
  const OrderID = Number(parcel.parcelId);
  // as the real account sent it (the log of the webhooks, 22.11.2026): the ids are texts
  if (event === 'shipped') {
    return {
      Event: 'ORDER_SHIPPED',
      LabelURL: [`https://cdn.shippypro.example/labels/label-${parcel.parcelId}.pdf`],
      OrderID: String(OrderID),
      TransactionID: parcel.reference,
      CarrierID: '7001',
      TrackingCarrier: 'MockExpress',
      TrackingNumber: parcel.trackingNumber ?? '',
      MarketplaceID: '0',
      MarketplacePlatform: 'Manual shipment',
      IsReturn: false,
      ReturnType: null,
    };
  }
  if (event === 'error') {
    return {
      Event: 'ORDER_ERROR',
      OrderID,
      TransactionID: parcel.reference,
      ErrorMessage: 'No street found',
      ErrorType: {},
      ErrorSuggestion: {},
    };
  }
  return {
    Event: 'TRACKING_UPDATE',
    tracking: parcel.trackingNumber ?? '',
    date: tracking.date ?? Math.floor(Date.now() / 1000),
    message: 'Carrier update',
    city: 'Madrid',
    code: tracking.code ?? 2,
    extendedCode: tracking.extendedCode === undefined ? '2200' : tracking.extendedCode,
    Category: 'IN TRANSIT',
    IsReturning: false,
    AtPudo: false,
    PudoID: null,
    OrderID,
    TransactionID: parcel.reference,
    TrackingCarrier: 'MockExpress',
    TrackingCarrierID: 7001,
    ExternalLink: `https://track.example.com/${parcel.trackingNumber ?? ''}`,
    est_delivery_date: null,
    late: false,
    IsReturn: false,
    ReturnType: '',
  };
}
