// no import of @config/env.js here: tests/setup/integration.setup.ts imports the helpers before it
// puts the env of the tests in place, and env.ts would take the values of .env
import { isRealService } from './services.js';

// fiskaly SIGN ES in the integration tests (tests/setup/integration.fiskaly.ts puts it in place for
// every file): a mock of its api at the level of http, the way it answered in TEST (21-22.11.2026,
// notes/fiskaly.md): a token for a day, the taxpayer of the key (404 until it is put), a signer put
// with no content, a client; an invoice put under an id of ours is ISSUED and PENDING, the tax
// authority registers it by the next GET; the same id with the same body answers the same, with
// another body 409, a number of the series taken by another id 409; a simplified invoice over 3000
// without exception_unidentified 400; an EXPORT with a category 400 (the schema); what the tax
// authority of the test refused: an issuer NIF not of its format (4116), the VAT of another country
// under OSS (1124), an exemption of an export under the regular system (1199), a total that is not
// the sum of the bases and the taxes of Spain by more than 10 (2005, a correction asked).
// Without service:fiskaly nothing reaches the service. With it (npm test -- service:fiskaly) every
// request goes to TEST with FISKALY_API_TEST_KEY of .env (the managed organization of the tests, its
// taxpayer B12345674); an outage a test sets answers here in both modes, a refusal of the next
// receipt in the mock only

export const FISKALY_TEST_ORIGIN = 'https://test.es.sign.fiskaly.com';

export const realFiskaly = isRealService('fiskaly');

// the limit of a test that waits for the tax authority of the test to register a receipt (15
// seconds in the pilot, over a minute on another day), the usual one with the mock
export const fiskalyWait: number | undefined = realFiskaly ? 300_000 : undefined;

// the NIF of the taxpayer of the managed organization of the tests in TEST (notes/fiskaly.md): the
// shop of a test that sends receipts names it
export const FISKALY_TEST_NIF = 'B12345674';

export type FiskalyOutage = 'down' | 'timeout' | 'unauthorized';

type MockInvoice = { body: string; content: Record<string, unknown>; polls: number };

let taxpayer: { legal_name: string; tax_number: string } | null = null;
const invoices = new Map<string, MockInvoice>();
const numbers = new Map<string, string>();
const clients = new Set<string>();
let outage: FiskalyOutage | null = null;
// what the tax authority answers for the next invoices a test asked to refuse
let refusals: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const error = (status: number, code: string, message: string) =>
  json({ content: { code, error: code, message, status } }, status);

// the rates of the VAT of Spain the tax authority takes under the regular system
const SPANISH_RATES = ['0', '2', '4', '5', '7.5', '10', '21'];

// a NIF of the format of the tax authority: 8 digits and a letter, or a letter, 7 digits and a sign
const nifFormat = (nif: string) => /^(\d{8}[A-Z]|[A-Z]\d{7}[0-9A-Z])$/.test(nif);

// what the tax authority of the test says of an invoice (its validations), none: registered
function validationsOf(content: Record<string, any>): { code: string; description: string }[] {
  if (!nifFormat(taxpayer?.tax_number ?? '') || /^T\d+$/.test(taxpayer?.tax_number ?? '')) {
    return [{ code: '4116', description: 'The NIF has a wrong format.' }];
  }
  const invoice = content.type === 'CORRECTING' ? content.invoice : content;
  for (const item of (invoice?.items ?? []) as Record<string, any>[]) {
    const system = item.system ?? {};
    if (system.type === 'OSS_IOSS' && system.category?.type === 'VAT') {
      return [
        {
          code: '1124',
          description: 'The rate (TipoImpositivo) is not one of the values allowed.',
        },
      ];
    }
    if (
      system.type === 'REGULAR' &&
      system.category?.type === 'VAT' &&
      !SPANISH_RATES.includes(String(system.category.rate ?? '21'))
    ) {
      return [
        {
          code: '1124',
          description: 'The rate (TipoImpositivo) is not one of the values allowed.',
        },
      ];
    }
    if (
      system.type === 'REGULAR' &&
      system.category?.type === 'NO_VAT' &&
      ['TAXABLE_EXEMPT_2', 'TAXABLE_EXEMPT_3'].includes(system.category.cause)
    ) {
      return [
        {
          code: '1199',
          description: 'The regular system (ClaveRegimen 01) takes no exemption E2 or E3.',
        },
      ];
    }
  }
  // the total of the record is the sum of the bases and of the taxes of Spain, 10 of difference let
  // through: a tax of another country in the total past that is refused (2005 in TEST, 23.11.2026,
  // for a sale of 104.80 with 17.46 of the VAT of Austria)
  const items = (invoice?.items ?? []) as Record<string, any>[];
  const record = items.reduce((sum, item) => {
    const base = Number(item.unit_amount) * Number(item.quantity);
    const category = item.system?.category;
    const rate = category?.type === 'VAT' ? Number(category.rate ?? '21') / 100 : 0;
    return sum + base * (1 + rate);
  }, 0);
  if (Math.abs(Number(invoice?.full_amount) - record) > 10) {
    return [
      {
        code: '2005',
        description: 'The total (ImporteTotal) is not the sum of the bases and the taxes given.',
      },
    ];
  }
  return [];
}

// a validation the tax authority asks a correction of the record for; the others it inspects
const CORRECTION_CODES = ['2005'];

function invoiceAnswer(id: string, content: Record<string, any>, registration: string) {
  const invoice = content.type === 'CORRECTING' ? content.invoice : content;
  const numserie = `${invoice.series}${invoice.number}`;
  return {
    id,
    state: 'ISSUED',
    transmission: {
      cancellation: 'NOT_CANCELLED',
      registration,
      ...(registration === 'REGISTERED'
        ? { registration_csv: `A-MOCK${id.slice(0, 8).toUpperCase()}` }
        : {}),
    },
    compliance: {
      code: {
        type: 'QR_CODE',
        image:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      },
      url: `https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=${taxpayer?.tax_number}&numserie=${numserie}`,
      text: 'QR tributario:|VERI*FACTU',
    },
    validations: [] as unknown[],
  };
}

function outageAnswer(kind: FiskalyOutage, init?: RequestInit): Promise<Response> {
  if (kind === 'unauthorized') return Promise.resolve(error(401, 'E_UNAUTHORIZED', 'Unauthorized'));
  if (kind === 'down')
    return Promise.resolve(error(503, 'E_SERVICE_UNAVAILABLE', 'Service Unavailable'));
  // no answer: the request waits until the provider gives up on it
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function answer(method: string, path: string, rawBody: string): Response {
  const body = rawBody ? (JSON.parse(rawBody) as Record<string, any>) : {};
  if (path === '/auth' && method === 'POST') {
    return json({
      content: {
        access_token: { bearer: 'mock-token', expires_in: 86400 },
        refresh_token: { bearer: 'mock-refresh', expires_in: 86400 },
      },
    });
  }
  if (path === '/taxpayer' && method === 'GET') {
    return taxpayer
      ? json({
          content: {
            issuer: taxpayer,
            state: 'ENABLED',
            territory: 'SPAIN_OTHER',
            type: /^\d/.test(taxpayer.tax_number) ? 'INDIVIDUAL' : 'COMPANY',
          },
        })
      : error(404, 'E_RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  }
  if (path === '/taxpayer' && method === 'PUT') {
    taxpayer = body.content.issuer;
    return json({ content: { issuer: taxpayer, state: 'ENABLED', territory: 'SPAIN_OTHER' } });
  }
  const signer = /^\/signers\/([^/]+)$/.exec(path);
  if (signer && method === 'PUT') {
    if (body.content !== undefined) return error(400, 'E_BAD_REQUEST', 'certificate is missing');
    return json({ content: { id: signer[1], state: 'ENABLED' } });
  }
  const client = /^\/clients\/([^/]+)$/.exec(path);
  if (client && method === 'PUT') {
    if (clients.has(client[1]!))
      return error(409, 'E_RESOURCE_CONFLICT', 'creation failed: client exists');
    clients.add(client[1]!);
    return json({
      content: { id: client[1], signer: { id: body.content.signer_id }, state: 'ENABLED' },
    });
  }
  const invoice = /^\/clients\/([^/]+)\/invoices\/([^/]+)$/.exec(path);
  if (invoice && method === 'PUT') {
    const id = invoice[2]!;
    const kept = invoices.get(id);
    if (kept) {
      return kept.body === rawBody
        ? json({ content: kept.content })
        : error(
            409,
            'E_RESOURCE_CONFLICT',
            `invoice id '${id}' retry with different payload is illegal`,
          );
    }
    const content = body.content as Record<string, any>;
    const own = content.type === 'CORRECTING' ? content.invoice : content;
    for (const item of own.items ?? []) {
      if (item.system?.type === 'EXPORT' && 'category' in item.system) {
        return error(
          400,
          'E_BAD_REQUEST',
          'Error at "/content/items/0/system": property "category" is unsupported',
        );
      }
    }
    if (
      own.type === 'SIMPLIFIED' &&
      !own.exception_unidentified &&
      Math.abs(Number(own.full_amount)) > 3000
    ) {
      return error(400, 'E_BAD_REQUEST', 'invoice issue failed: full amount exceeds limit of 3000');
    }
    const numberKey = `${own.series}|${own.number}`;
    if (numbers.has(numberKey) && numbers.get(numberKey) !== id) {
      return error(
        409,
        'E_RESOURCE_CONFLICT',
        `issuing failed: invoice with series ${own.series} and number ${own.number} already exists`,
      );
    }
    numbers.set(numberKey, id);
    const issued = invoiceAnswer(id, content, 'PENDING');
    const refusal = refusals.shift();
    invoices.set(id, {
      body: rawBody,
      content: { ...issued, ...(refusal ? { refusal } : {}), request: content },
      polls: 0,
    });
    return json({ content: issued });
  }
  if (invoice && method === 'GET') {
    const kept = invoices.get(invoice[2]!);
    if (!kept) return error(404, 'E_RESOURCE_NOT_FOUND', 'The requested resource was not found.');
    // the tax authority answers before the next look
    const { refusal, request, ...issued } = kept.content as Record<string, any>;
    const validations = refusal
      ? [{ code: '1100', description: 'A wrong value or type.' }]
      : validationsOf(request);
    const registration =
      refusal ??
      (!validations.length
        ? 'REGISTERED'
        : CORRECTION_CODES.includes(validations[0]!.code)
          ? 'REQUIRES_CORRECTION'
          : 'REQUIRES_INSPECTION');
    kept.polls += 1;
    return json({
      content: { ...issued, ...invoiceAnswer(issued.id, request, registration), validations },
    });
  }
  return error(404, 'E_RESOURCE_NOT_FOUND', `the mock of fiskaly has no ${method} ${path}`);
}

// the real TEST now and then does not answer in time or answers 5xx or 429: a request goes again,
// this many times at most, after a pause, each time with the time the app gives it (TIMEOUT_MS of
// src/providers/receipts/fiskaly/fiskaly.provider.ts); a request to fiskaly is the same every time
// (an invoice under our id), so going again changes nothing there. How the app takes a service
// that does not answer the mock checks (an outage)
const REAL_TRIES = 3;
const REAL_PAUSE_MS = 3_000;
const REAL_TIMEOUT_MS = 20_000;

async function askRealFiskaly(
  realFetch: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  for (let tries = 1; ; tries += 1) {
    try {
      const res = await realFetch(input, {
        ...init,
        signal: AbortSignal.timeout(REAL_TIMEOUT_MS),
      });
      if ((res.status < 500 && res.status !== 429) || tries === REAL_TRIES) return res;
    } catch (err) {
      if (tries === REAL_TRIES) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, REAL_PAUSE_MS));
  }
}

// in place for the whole test file, by assignment and not jest.spyOn: restoreAllMocks of a test must
// not take it away. Every other request passes untouched
export function installFiskaly(): void {
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== FISKALY_TEST_ORIGIN) return realFetch(input, init);
    if (outage) return outageAnswer(outage, init);
    if (realFiskaly) return askRealFiskaly(realFetch, input, init);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    return answer(init?.method ?? 'GET', path, init?.body == null ? '' : String(init.body));
  }) as typeof fetch;
}

// after every test: the outage and the refusals are gone; the taxpayer, the devices and the
// invoices stay, as they do at fiskaly
export function resetFiskaly(): void {
  outage = null;
  refusals = [];
}

// fiskaly does not answer the way the outage says until the test ends, in both modes
export function breakFiskaly(kind: FiskalyOutage): void {
  outage = kind;
}

// the tax authority refuses the next invoices the mock takes (the mock only)
export function refuseNextReceipt(
  registration: 'REQUIRES_INSPECTION' | 'REQUIRES_CORRECTION' = 'REQUIRES_INSPECTION',
): void {
  refusals.push(registration);
}

// what the mock took of an invoice by our key's id: the request, and how many times it was asked
// about; null when it has none (the mock only)
export function mockInvoice(
  id: string,
): { request: Record<string, unknown>; polls: number } | null {
  const kept = invoices.get(id);
  return kept
    ? { request: (kept.content as Record<string, any>).request, polls: kept.polls }
    : null;
}

// the mock with its own taxpayer of another NIF, for the refusal of a taxpayer that does not match
export function mockTaxpayerOf(nif: string, name = 'Another shop'): void {
  taxpayer = { legal_name: name, tax_number: nif };
}

export const mockTaxpayer = (): Readonly<{ legal_name: string; tax_number: string }> | null =>
  taxpayer;
