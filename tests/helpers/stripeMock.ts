import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A Stripe for the tests: an http server the real sdk of the app and of the helpers sends its
// requests to (tests/helpers/stripe.ts), answering the requests they make the way the test sandbox
// answers them, checked on 24.10.2026 and held to it by stripeAnswers.test.ts in both modes: the
// objects and their ids, the states of a payment page and of a payment, the idempotency keys, the
// events Stripe records and the errors the app reads. Each test file has its own, in memory.
// A request it was not taught (another endpoint, a parameter it does not know) gets the answer
// Stripe gives an unknown one and is kept: tests/helpers/stripe.ts fails the test with it

type Params = Record<string, unknown>;
type Answer = { status: number; body: unknown };

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// ids of the lengths the sandbox gives: cs_test_ 66, pi_ 27, evt_ 28, price_ 30, prod_ 19
const idOf = (prefix: string, length: number) =>
  prefix +
  Array.from(randomBytes(length - prefix.length), (byte) => BASE62[byte % BASE62.length]).join('');

const now = () => Math.floor(Date.now() / 1000);

// the version the sandbox account renders its events in, whatever version the request names
const EVENT_API_VERSION = '2026-02-25.clover';

// the longest id of a checkout session Stripe reads
const SESSION_ID_MAX_LENGTH = 66;

// the smallest total of a card page in cents, in EUR
const CARD_MINIMUM_TOTAL = 50;

const error = (
  status: number,
  fields: { message: string; type?: string; code?: string; param?: string },
): Answer => ({
  status,
  body: {
    error: {
      ...(fields.code
        ? {
            code: fields.code,
            doc_url: `https://stripe.com/docs/error-codes/${fields.code.replaceAll('_', '-')}`,
          }
        : {}),
      message: fields.message,
      ...(fields.param ? { param: fields.param } : {}),
      type: fields.type ?? 'invalid_request_error',
    },
  },
});

const list = (url: string, data: unknown[]): Answer => ({
  status: 200,
  body: { object: 'list', data, has_more: false, url },
});

// the form body of the sdk: a[b][0][c]=v becomes { a: { b: [{ c: 'v' }] } }
function parseForm(text: string): Params {
  const out: Params = {};

  for (const [rawKey, value] of new URLSearchParams(text)) {
    const path = rawKey.replaceAll(']', '').split('[');
    let node = out as Record<string, unknown>;

    path.forEach((part, i) => {
      if (i === path.length - 1) {
        node[part] = value;
        return;
      }
      node[part] ??= /^\d+$/.test(path[i + 1]!) ? [] : {};
      node = node[part] as Record<string, unknown>;
    });
  }

  return out;
}

// the parameters of a request that are not among the known ones, by their whole name
function unknownParams(params: unknown, known: unknown, prefix = ''): string[] {
  if (!params || typeof params !== 'object') return [];
  if (known === true) return [];

  return Object.entries(params as Params).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}[${key}]` : key;
    const shape = Array.isArray(params)
      ? (known as unknown[])[0]
      : (known as Record<string, unknown> | undefined)?.[key];

    if (shape === undefined) return [name];
    return typeof value === 'object' ? unknownParams(value, shape, name) : [];
  });
}

// the parameters each request of the app and of the helpers sends; true is a value of any form
const KNOWN_PARAMS: Record<string, unknown> = {
  'POST /v1/checkout/sessions': {
    mode: true,
    allowed_payment_method_types: [true],
    client_reference_id: true,
    metadata: true,
    line_items: [
      {
        quantity: true,
        price_data: { currency: true, unit_amount: true, product_data: { name: true } },
      },
    ],
    payment_intent_data: { description: true },
    customer_email: true,
    success_url: true,
    cancel_url: true,
    expires_at: true,
  },
  'GET /v1/checkout/sessions/:id': {},
  'POST /v1/checkout/sessions/:id/expire': {},
  'GET /v1/checkout/sessions/:id/line_items': { limit: true },
  'GET /v1/payment_pages/:id': {},
  'POST /v1/payment_pages/:id/confirm': { payment_method: true, expected_amount: true },
  'POST /v1/payment_methods': {
    type: true,
    card: { token: true },
    sepa_debit: { iban: true },
    billing_details: { email: true, name: true },
  },
  'POST /v1/payment_intents': {
    amount: true,
    currency: true,
    payment_method: true,
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: true },
  },
  'GET /v1/payment_intents/:id': {},
  'POST /v1/refunds': { payment_intent: true, metadata: true },
  'GET /v1/refunds': { payment_intent: true },
  'GET /v1/events': { type: true, created: { gte: true }, limit: true },
};

// the routes, with :id for the id in the path
const ROUTES = Object.keys(KNOWN_PARAMS).map((route) => {
  const [method, path] = route.split(' ') as [string, string];
  const pattern = new RegExp(`^${path.replaceAll(':id', '([^/]+)')}$`);
  return { route, method, pattern };
});

type Session = Record<string, unknown> & { id: string; status: string; payment_status: string };
type LineItem = Record<string, unknown>;
type PaymentIntent = Record<string, unknown> & { id: string; amount: number; status: string };
type Refund = Record<string, unknown> & { id: string; payment_intent: string };
type StripeEvent = { id: string; type: string; created: number; [key: string]: unknown };

export type StripeMock = {
  listen: () => Promise<number>;
  close: () => Promise<void>;
  // the requests it was not taught since the last call
  takeUnanswered: () => string[];
};

export function startStripeMock(key: string): StripeMock {
  const sessions = new Map<string, Session>();
  // the description each page gives its payment, not a field of the session
  const descriptions = new Map<string, string | null>();
  const lineItems = new Map<string, LineItem[]>();
  const paymentIntents = new Map<string, PaymentIntent>();
  const paymentMethods = new Map<
    string,
    { id: string; type: string; email: string | null; name: string | null }
  >();
  const refunds: Refund[] = [];
  const events: StripeEvent[] = [];
  const idempotent = new Map<string, { request: string; answer: Answer }>();
  let unanswered: string[] = [];

  const copy = <T>(value: T): T => structuredClone(value);

  const record = (type: string, object: unknown) =>
    events.push({
      id: idOf('evt_', 28),
      object: 'event',
      api_version: EVENT_API_VERSION,
      created: now(),
      data: { object: copy(object) },
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type,
    });

  const noSuchSession = (id: string) =>
    error(404, {
      message: `No such checkout session: '${id}'`,
      code: 'resource_missing',
      param: 'session',
    });

  const noSuchPayment = (id: string, param: string) =>
    error(404, {
      message: `No such payment_intent: '${id}'`,
      code: 'resource_missing',
      param,
    });

  function createSession(params: Params): Answer {
    const created = now();
    const types = (params.allowed_payment_method_types as string[] | undefined) ?? ['card'];
    const lines = (params.line_items as Params[] | undefined) ?? [];
    const currency = String((lines[0]?.price_data as Params | undefined)?.currency ?? '');
    const expiresAt =
      params.expires_at === undefined ? created + 86_400 : Number(params.expires_at);

    if (expiresAt - created < 30 * 60) {
      return error(400, {
        message:
          'The `expires_at` timestamp must be at least 30 minutes from Checkout Session creation.',
      });
    }
    if (expiresAt - created > 86_400) {
      return error(400, {
        message:
          'The `expires_at` timestamp must be less than 24 hours from Checkout Session creation.',
      });
    }

    const id = idOf('cs_test_', SESSION_ID_MAX_LENGTH);
    const items = lines.map((line) => {
      const price = line.price_data as Params;
      const unitAmount = Number(price.unit_amount);
      const quantity = Number(line.quantity);
      return {
        id: idOf('li_', 27),
        object: 'item',
        adjustable_quantity: null,
        amount_discount: 0,
        amount_subtotal: unitAmount * quantity,
        amount_tax: 0,
        amount_total: unitAmount * quantity,
        currency,
        description: String((price.product_data as Params).name),
        metadata: {},
        price: {
          id: idOf('price_', 30),
          object: 'price',
          active: false,
          billing_scheme: 'per_unit',
          created,
          currency,
          custom_unit_amount: null,
          livemode: false,
          lookup_key: null,
          metadata: {},
          nickname: null,
          product: idOf('prod_', 19),
          recurring: null,
          tax_behavior: 'unspecified',
          tiers_mode: null,
          transform_quantity: null,
          type: 'one_time',
          unit_amount: unitAmount,
          unit_amount_decimal: String(unitAmount),
        },
        quantity,
      };
    });
    const total = items.reduce((sum, item) => sum + item.amount_total, 0);

    if (types.includes('card') && total < CARD_MINIMUM_TOTAL) {
      return error(400, {
        message:
          'All types provided in `allowed_payment_method_types` are invalid. Please ensure the ' +
          'provided types are activated in your dashboard (https://dashboard.stripe.com/account/' +
          'payments/settings) and your account is enabled for any preview features that you are ' +
          "trying to use. For example, `card` is invalid because: The Checkout Session's total " +
          'amount due must add up to at least €0.50 EUR',
        param: 'allowed_payment_method_types',
      });
    }

    const email = (params.customer_email as string | undefined) ?? null;
    const session: Session = {
      id,
      object: 'checkout.session',
      allowed_payment_method_types: types,
      amount_subtotal: total,
      amount_total: total,
      cancel_url: (params.cancel_url as string | undefined) ?? null,
      client_reference_id: (params.client_reference_id as string | undefined) ?? null,
      created,
      currency,
      customer: null,
      customer_details: email
        ? {
            address: null,
            business_name: null,
            email,
            individual_name: null,
            name: null,
            phone: null,
            tax_exempt: 'none',
            tax_ids: null,
          }
        : null,
      customer_email: email,
      expires_at: expiresAt,
      invoice: null,
      livemode: false,
      locale: null,
      metadata: (params.metadata as Params | undefined) ?? {},
      mode: String(params.mode),
      payment_intent: null,
      payment_method_types: types,
      payment_status: 'unpaid',
      status: 'open',
      success_url: (params.success_url as string | undefined) ?? null,
      total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
      ui_mode: 'hosted_page',
      url: `https://checkout.stripe.com/c/pay/${id}#mock`,
    };
    sessions.set(id, session);
    lineItems.set(id, items);
    descriptions.set(
      id,
      ((params.payment_intent_data as Params | undefined)?.description as string | undefined) ??
        null,
    );

    return { status: 200, body: copy(session) };
  }

  function retrieveSession(id: string): Answer {
    if (id.length > SESSION_ID_MAX_LENGTH) {
      return error(404, {
        message: `Invalid string: ${id.slice(0, 4)}...${id.slice(-4)}; must be at most ${SESSION_ID_MAX_LENGTH} characters`,
        param: 'session',
      });
    }
    const session = sessions.get(id);
    if (!session) {
      return error(404, { message: `No such checkout.session: ${id}`, code: 'resource_missing' });
    }
    return { status: 200, body: copy(session) };
  }

  function expireSession(id: string): Answer {
    const session = sessions.get(id);
    if (!session) return noSuchSession(id);
    if (session.status !== 'open') {
      return error(400, {
        message: `Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of \`${session.status}\`.`,
      });
    }

    session.status = 'expired';
    session.url = null;
    record('checkout.session.expired', copy(session));
    return { status: 200, body: copy(session) };
  }

  function confirmPage(id: string, params: Params): Answer {
    const session = sessions.get(id);
    if (!session) return noSuchSession(id);
    if (session.status === 'complete') {
      return error(400, {
        message: 'Your payment has already been processed.',
        code: 'checkout_succeeded_session',
      });
    }
    if (session.status !== 'open') {
      return error(400, {
        message: 'This Checkout Session is no longer active.',
        code: 'checkout_not_active_session',
      });
    }
    if (Number(params.expected_amount) !== session.amount_total) {
      return error(400, {
        message:
          'Your order has been updated. Please review the updated total and submit payment again.',
        code: 'checkout_amount_mismatch',
        param: 'expected_amount',
      });
    }

    const method = paymentMethods.get(String(params.payment_method));
    const types = session.allowed_payment_method_types as string[];
    if (!method || !types.includes(method.type)) {
      unanswered.push(`a payment of the page by ${method?.type ?? 'an unknown payment method'}`);
      return error(400, { message: 'stripe mock: the page is paid by card or sepa_debit only' });
    }

    // a card takes the money at once, a bank debit completes the page and the bank decides later
    const byBank = method.type === 'sepa_debit';
    const payment = makePayment({
      amount: session.amount_total as number,
      currency: session.currency as string,
      paymentMethod: method.id,
      description: descriptions.get(session.id) ?? null,
      status: byBank ? 'processing' : 'succeeded',
    });

    session.status = 'complete';
    session.payment_status = byBank ? 'unpaid' : 'paid';
    session.payment_intent = payment.id;
    session.url = null;
    session.customer_details = {
      address: {
        city: null,
        country: null,
        line1: null,
        line2: null,
        postal_code: null,
        state: null,
      },
      business_name: null,
      email: session.customer_email ?? method.email,
      individual_name: null,
      name: method.name,
      phone: null,
      tax_exempt: 'none',
      tax_ids: [],
    };
    record('checkout.session.completed', copy(session));

    return {
      status: 200,
      body: {
        session_id: session.id,
        status: session.status,
        payment_status: session.payment_status,
      },
    };
  }

  function makePayment(fields: {
    amount: number;
    currency: string;
    paymentMethod: string;
    description: string | null;
    status: 'succeeded' | 'processing';
  }): PaymentIntent {
    const payment: PaymentIntent = {
      id: idOf('pi_', 27),
      object: 'payment_intent',
      amount: fields.amount,
      amount_received: fields.status === 'succeeded' ? fields.amount : 0,
      capture_method: 'automatic_async',
      confirmation_method: 'automatic',
      created: now(),
      currency: fields.currency,
      description: fields.description,
      latest_charge: fields.status === 'succeeded' ? idOf('ch_', 27) : null,
      livemode: false,
      metadata: {},
      payment_method: fields.paymentMethod,
      status: fields.status,
    };
    paymentIntents.set(payment.id, payment);
    return payment;
  }

  function createPaymentMethod(params: Params): Answer {
    const type = String(params.type);
    const billing = (params.billing_details as Params | undefined) ?? {};
    const card = (params.card as Params | undefined)?.token === 'tok_visa';
    const bank = Boolean((params.sepa_debit as Params | undefined)?.iban);

    if (!(type === 'card' && card) && !(type === 'sepa_debit' && bank)) {
      unanswered.push(`a payment method of type ${type}`);
      return error(400, { message: 'stripe mock: a test card tok_visa or a test iban only' });
    }

    const method = {
      id: idOf('pm_', 27),
      type,
      email: (billing.email as string | undefined) ?? null,
      name: (billing.name as string | undefined) ?? null,
    };
    paymentMethods.set(method.id, method);
    return { status: 200, body: { id: method.id, object: 'payment_method', type } };
  }

  function createPaymentIntent(params: Params): Answer {
    const automatic = params.automatic_payment_methods as Params | undefined;
    if (
      params.payment_method !== 'pm_card_visa' ||
      params.confirm !== 'true' ||
      automatic?.allow_redirects !== 'never'
    ) {
      unanswered.push('a payment other than one confirmed at once by pm_card_visa');
      return error(400, { message: 'stripe mock: pm_card_visa confirmed at once only' });
    }

    const payment = makePayment({
      amount: Number(params.amount),
      currency: String(params.currency),
      paymentMethod: idOf('pm_', 27),
      description: null,
      status: 'succeeded',
    });
    return { status: 200, body: copy(payment) };
  }

  function createRefund(params: Params): Answer {
    const paymentId = String(params.payment_intent);
    const payment = paymentIntents.get(paymentId);
    if (!payment) return noSuchPayment(paymentId, 'id');
    if (payment.status !== 'succeeded') {
      unanswered.push(`a refund of a payment that is ${payment.status}`);
      return error(400, { message: 'stripe mock: a refund of a payment that succeeded only' });
    }
    if (refunds.some((refund) => refund.payment_intent === paymentId)) {
      return error(400, {
        message: `Charge ${String(payment.latest_charge)} has already been refunded.`,
        code: 'charge_already_refunded',
      });
    }

    const refund: Refund = {
      id: idOf('re_', 27),
      object: 'refund',
      amount: payment.amount,
      balance_transaction: idOf('txn_', 28),
      charge: payment.latest_charge,
      created: now(),
      currency: payment.currency,
      metadata: (params.metadata as Params | undefined) ?? {},
      payment_intent: paymentId,
      payment_method: payment.payment_method,
      reason: null,
      receipt_number: null,
      status: 'succeeded',
    };
    refunds.push(refund);
    return { status: 200, body: copy(refund) };
  }

  function listEvents(params: Params): Answer {
    const since = Number((params.created as Params | undefined)?.gte ?? 0);
    const limit = Number(params.limit ?? 10);
    const found = events
      .filter((event) => (!params.type || event.type === params.type) && event.created >= since)
      .reverse()
      .slice(0, limit);
    return list('/v1/events', copy(found));
  }

  function answer(route: string, id: string | undefined, params: Params): Answer {
    switch (route) {
      case 'POST /v1/checkout/sessions':
        return createSession(params);
      case 'GET /v1/checkout/sessions/:id':
        return retrieveSession(id!);
      case 'POST /v1/checkout/sessions/:id/expire':
        return expireSession(id!);
      case 'GET /v1/checkout/sessions/:id/line_items': {
        const items = lineItems.get(id!);
        if (!items) return noSuchSession(id!);
        return list(
          `/v1/checkout/sessions/${id}/line_items`,
          copy(items).slice(0, Number(params.limit ?? 10)),
        );
      }
      case 'GET /v1/payment_pages/:id': {
        const session = sessions.get(id!);
        if (!session) return noSuchSession(id!);
        return {
          status: 200,
          body: {
            session_id: session.id,
            status: session.status,
            payment_status: session.payment_status,
          },
        };
      }
      case 'POST /v1/payment_pages/:id/confirm':
        return confirmPage(id!, params);
      case 'POST /v1/payment_methods':
        return createPaymentMethod(params);
      case 'POST /v1/payment_intents':
        return createPaymentIntent(params);
      case 'GET /v1/payment_intents/:id': {
        const payment = paymentIntents.get(id!);
        if (!payment) return noSuchPayment(id!, 'intent');
        return { status: 200, body: copy(payment) };
      }
      case 'POST /v1/refunds':
        return createRefund(params);
      case 'GET /v1/refunds': {
        const paymentId = String(params.payment_intent);
        if (!paymentIntents.has(paymentId)) return noSuchPayment(paymentId, 'payment_intent');
        return list(
          '/v1/refunds',
          copy(refunds.filter((refund) => refund.payment_intent === paymentId)).reverse(),
        );
      }
      case 'GET /v1/events':
        return listEvents(params);
      default:
        throw new Error(`the stripe mock has no answer for ${route}`);
    }
  }

  // the key Stripe quotes in the error of a key it does not know
  const quoted = (given: string) =>
    `${given.slice(0, 8)}${'*'.repeat(Math.max(0, given.length - 12))}${given.slice(-4)}`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stripe.mock');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const method = req.method ?? 'GET';
    const params = parseForm(method === 'GET' ? url.searchParams.toString() : bodyText);
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'request-id': idOf('req_', 18),
      'stripe-version': String(req.headers['stripe-version'] ?? EVENT_API_VERSION),
      // the sdk tries again only what Stripe tells it to
      'stripe-should-retry': 'false',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    };
    const send = ({ status, body }: Answer, extra: Record<string, string> = {}) => {
      res.writeHead(status, { ...headers, ...extra });
      res.end(JSON.stringify(body));
    };

    const authorization = String(req.headers.authorization ?? '');
    if (authorization !== `Bearer ${key}`) {
      send(
        error(401, {
          message: `Invalid API Key provided: ${quoted(authorization.replace(/^Bearer /, ''))}`,
        }),
      );
      return;
    }

    const found = ROUTES.filter((route) => route.method === method)
      .map((route) => ({ route, match: route.pattern.exec(url.pathname) }))
      .find(({ match }) => match);
    if (!found) {
      unanswered.push(`${method} ${url.pathname}`);
      send(
        error(404, {
          message: `Unrecognized request URL (${method}: ${url.pathname}). Please see https://stripe.com/docs or we can help at https://support.stripe.com/.`,
        }),
      );
      return;
    }

    const route = found.route.route;
    const unknown = unknownParams(params, KNOWN_PARAMS[route]);
    if (unknown.length) {
      unanswered.push(`${route} with ${unknown.join(', ')}`);
      send(
        error(400, { message: `Received unknown parameter: ${unknown[0]}`, param: unknown[0]! }),
      );
      return;
    }

    // the same key gives the answer of its first request again, for the same request only
    const request = `${route} ${url.pathname} ${bodyText}`;
    const saved = method === 'POST' && idempotencyKey ? idempotent.get(idempotencyKey) : undefined;
    if (saved) {
      if (saved.request === request) {
        send(saved.answer, { 'idempotent-replayed': 'true' });
        return;
      }
      send(
        error(400, {
          type: 'idempotency_error',
          message: `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${idempotencyKey}' if you meant to execute a different request.`,
        }),
      );
      return;
    }

    const result = answer(route, found.match![1], params);
    // Stripe keeps the result of a request it carried out, not of one it refused
    if (method === 'POST' && idempotencyKey && result.status < 300) {
      idempotent.set(idempotencyKey, { request, answer: result });
    }
    send(result);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      unanswered.push(String(err));
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stripe mock failed', type: 'api_error' } }));
    });
  });

  return {
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    takeUnanswered: () => {
      const taken = unanswered;
      unanswered = [];
      return taken;
    },
  };
}
