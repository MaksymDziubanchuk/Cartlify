import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A Stripe for the tests: an http server the real sdk of the app and of the helpers sends its
// requests to (tests/helpers/stripe.ts), answering the requests they make the way the test sandbox
// answers them, checked on 24.10.2026 and held to it by stripeAnswers.test.ts in both modes: the
// objects and their ids, the states of a payment page and of a payment, the idempotency keys, the
// events Stripe records and the errors the app reads. The disputes (with their balance
// transactions and the draft of the evidence), the pages of the list of refunds, the number of the
// bank of a refund and the pages of card, PayPal and Bizum came on 11.11.2026 from the types of the
// sdk and the docs of Stripe, and stripeAnswers.test.ts holds them to the sandbox in its run with
// it. Each test file has its own, in memory.
// A request it was not taught (another endpoint, a parameter it does not know) gets the answer
// Stripe gives an unknown one and is kept: tests/helpers/stripe.ts fails the test with it

type Params = Record<string, unknown>;
type Answer = { status: number; body: unknown };

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// ids of the lengths the sandbox gives: cs_test_ 66, pi_ 27, evt_ 28, price_ 30, prod_ 19; the
// ones of disputes (du_ 27, as the sandbox gives them), early fraud warnings (issfr_ 30) and reviews (prv_ 28) as the docs
// of Stripe show them
export const idOf = (prefix: string, length: number) =>
  prefix +
  Array.from(randomBytes(length - prefix.length), (byte) => BASE62[byte % BASE62.length]).join('');

const now = () => Math.floor(Date.now() / 1000);

// the version the sandbox account renders its events in, whatever version the request names
const EVENT_API_VERSION = '2026-02-25.clover';

// the longest id of a checkout session Stripe reads
const SESSION_ID_MAX_LENGTH = 66;

// the smallest total of a page in cents, in EUR: the same for a card, PayPal and Bizum
const PAGE_MINIMUM_TOTAL = 50;

// the most items Stripe gives on a page of a list, and the number it gives without a limit
const LIST_MAX = 100;
const LIST_DEFAULT = 10;

// the fee Stripe takes from the balance for a dispute of a payment in EUR, in cents
const DISPUTE_FEE = 2000;

// the days the shop has to answer a dispute
const DISPUTE_DAYS = 7;

// the reasons a refund can be given with, as the dashboard lists them
const REFUND_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer'];

// a dispute is open until it ends one of these ways
const DISPUTE_ENDS = ['won', 'lost', 'warning_closed', 'prevented'];

// the text evidence of a dispute the app and the helpers send
const EVIDENCE_TEXT = [
  'product_description',
  'customer_name',
  'customer_email_address',
  'shipping_address',
  'shipping_carrier',
  'shipping_tracking_number',
  'shipping_date',
  'refund_policy_disclosure',
  'refund_refusal_explanation',
  'uncategorized_text',
];

// every field of the evidence of a dispute, empty while nothing is put on it
const EVIDENCE_FIELDS = [
  'access_activity_log',
  'billing_address',
  'cancellation_policy',
  'cancellation_policy_disclosure',
  'cancellation_rebuttal',
  'customer_communication',
  'customer_email_address',
  'customer_name',
  'customer_purchase_ip',
  'customer_signature',
  'duplicate_charge_documentation',
  'duplicate_charge_explanation',
  'duplicate_charge_id',
  'product_description',
  'receipt',
  'refund_policy',
  'refund_policy_disclosure',
  'refund_refusal_explanation',
  'service_date',
  'service_documentation',
  'shipping_address',
  'shipping_carrier',
  'shipping_date',
  'shipping_documentation',
  'shipping_tracking_number',
  'uncategorized_file',
  'uncategorized_text',
];

const error = (
  status: number,
  fields: {
    message: string;
    type?: string;
    code?: string;
    param?: string;
    decline_code?: string;
  },
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
      ...(fields.decline_code ? { decline_code: fields.decline_code } : {}),
      message: fields.message,
      ...(fields.param ? { param: fields.param } : {}),
      type: fields.type ?? 'invalid_request_error',
    },
  },
});

// the test cards whose bank says no on the page, with the answer of the sandbox (seen 04.11.2026)
const DECLINED_CARDS: Record<string, { code: string; decline_code: string; message: string }> = {
  tok_chargeDeclined: {
    code: 'card_declined',
    decline_code: 'generic_decline',
    message: 'Your card was declined.',
  },
  tok_chargeDeclinedInsufficientFunds: {
    code: 'card_declined',
    decline_code: 'insufficient_funds',
    message:
      'Your card has insufficient funds. Use a different payment method to complete this purchase.',
  },
  tok_chargeDeclinedExpiredCard: {
    code: 'expired_card',
    decline_code: 'expired_card',
    message: 'Your card has expired.',
  },
};

const list = (url: string, data: unknown[]): Answer => ({
  status: 200,
  body: { object: 'list', data, has_more: false, url },
});

// a page of a list (the items the newest first): limit items after the one starting_after names.
// Null for a limit or a cursor the mock was not taught, it gets the answer of the sandbox first
function pageOf<T extends { id: string }>(url: string, items: T[], params: Params): Answer | null {
  const limit = params.limit === undefined ? LIST_DEFAULT : Number(params.limit);
  const after =
    params.starting_after === undefined
      ? 0
      : items.findIndex((item) => item.id === params.starting_after) + 1;

  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) return null;
  if (params.starting_after !== undefined && after === 0) return null;

  return {
    status: 200,
    body: {
      object: 'list',
      data: items.slice(after, after + limit),
      has_more: after + limit < items.length,
      url,
    },
  };
}

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
    payment_intent_data: {
      description: true,
      shipping: {
        name: true,
        phone: true,
        address: { line1: true, line2: true, city: true, postal_code: true, country: true },
      },
    },
    customer_email: true,
    locale: true,
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
  'POST /v1/refunds': { payment_intent: true, amount: true, metadata: true, reason: true },
  'GET /v1/refunds': { payment_intent: true, limit: true, starting_after: true },
  'GET /v1/refunds/:id': {},
  'GET /v1/disputes': { payment_intent: true, limit: true },
  'GET /v1/disputes/:id': {},
  'POST /v1/disputes/:id': {
    evidence: Object.fromEntries(EVIDENCE_TEXT.map((field) => [field, true])),
    submit: true,
  },
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
type Dispute = Record<string, unknown> & {
  id: string;
  payment_intent: string;
  status: string;
  is_charge_refundable: boolean;
  evidence: Record<string, unknown>;
  evidence_details: { has_evidence: boolean; submission_count: number; [key: string]: unknown };
  balance_transactions: Record<string, unknown>[];
};
type StripeEvent = { id: string; type: string; created: number; [key: string]: unknown };

// how the next refund ends, for a test of a refund that does not simply succeed: the sandbox gives
// a card refund that succeeds, so only the mock can make one that is still pending or fails
export type RefundOutcome = { status: 'pending' } | { status: 'failed'; reason: string };

// a dispute the bank opens on a payment: a chargeback (needs_response) takes the sum from the
// balance at once, an inquiry (warning_needs_response) takes nothing. The sandbox makes a
// fraudulent chargeback of the whole payment for pm_card_createDispute; only the mock makes the
// others (an inquiry, a part of the payment, a dispute of PayPal, several on one payment)
export type DisputeOpening = {
  status?: 'needs_response' | 'warning_needs_response';
  reason?: string;
  // in cents, the whole payment unless given
  amount?: number;
  // whether the payment can still be refunded: an inquiry and a dispute of PayPal can, a
  // chargeback of a card cannot
  refundable?: boolean;
  method?: 'card' | 'paypal';
};

// how the bank ends a dispute: won puts the sum back on the balance, lost keeps it with the buyer,
// warning_closed ends an inquiry
export type DisputeEnd = 'won' | 'lost' | 'warning_closed';

export type StripeMock = {
  listen: () => Promise<number>;
  close: () => Promise<void>;
  // the requests it was not taught since the last call
  takeUnanswered: () => string[];
  // the next refund made ends this way (queued: one outcome for each refund made)
  queueRefundOutcome: (outcome: RefundOutcome) => void;
  // a refund that was pending ends: the event Stripe records is the one the webhook gets
  settleRefund: (refundId: string, end: { status: 'succeeded' } | RefundOutcome) => void;
  // the bank of the card gives the refund its number (refund.updated): the sandbox has it some
  // days after the money is sent, the mock when a test says so
  giveRefundReference: (refundId: string, reference: string) => void;
  // the bank opens a dispute on a payment, with its events; the id of the dispute
  openDispute: (paymentId: string, opening?: DisputeOpening) => string;
  // the bank ends a dispute, with its events: won, its charge may be refunded again; lost, it
  // stays charged back. The test evidence ends it too, as in the sandbox (POST /v1/disputes/:id)
  endDispute: (disputeId: string, end: DisputeEnd) => void;
};

export function startStripeMock(key: string): StripeMock {
  const sessions = new Map<string, Session>();
  // the description each page gives its payment, not a field of the session
  const descriptions = new Map<string, string | null>();
  // where the order goes, the shipping each page gives its payment
  const shippings = new Map<string, unknown>();
  const lineItems = new Map<string, LineItem[]>();
  const paymentIntents = new Map<string, PaymentIntent>();
  const paymentMethods = new Map<
    string,
    { id: string; type: string; token: string; email: string | null; name: string | null }
  >();
  const refunds: Refund[] = [];
  const refundOutcomes: RefundOutcome[] = [];
  // the payments made by the test card whose refunds are pending first (pm_card_pendingRefund)
  const pendingRefundPayments = new Set<string>();
  const disputes: Dispute[] = [];
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

  const noSuchDispute = (id: string) =>
    error(404, { message: `No such dispute: '${id}'`, code: 'resource_missing', param: 'dispute' });

  // a request the mock was not taught: the test that sent it fails with it
  const notTaught = (what: string): Answer => {
    unanswered.push(what);
    return error(400, { message: `stripe mock: ${what} is not taught` });
  };

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

    // a card, PayPal and Bizum all take 0.50 at least: below it no type is left, and Stripe names
    // the first one
    if (total < PAGE_MINIMUM_TOTAL) {
      return error(400, {
        message:
          'All types provided in `allowed_payment_method_types` are invalid. Please ensure the ' +
          'provided types are activated in your dashboard (https://dashboard.stripe.com/account/' +
          'payments/settings) and your account is enabled for any preview features that you are ' +
          `trying to use. For example, \`${types[0]}\` is invalid because: The Checkout Session's ` +
          'total amount due must add up to at least €0.50 EUR',
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
      locale: (params.locale as string | undefined) ?? null,
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
    shippings.set(id, (params.payment_intent_data as Params | undefined)?.shipping ?? null);

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
    // the bank of the card says no: the page stays open, another card may pay it
    const declined = DECLINED_CARDS[method.token];
    if (declined) return error(402, { type: 'card_error', ...declined });

    // a card takes the money at once, a bank debit completes the page and the bank decides later
    const byBank = method.type === 'sepa_debit';
    const payment = makePayment({
      amount: session.amount_total as number,
      currency: session.currency as string,
      paymentMethod: method.id,
      description: descriptions.get(session.id) ?? null,
      shipping: shippings.get(session.id) ?? null,
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
    shipping?: unknown;
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
      shipping: fields.shipping ?? null,
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
    const token = String((params.card as Params | undefined)?.token ?? '');
    const card = token === 'tok_visa' || token in DECLINED_CARDS;
    const bank = Boolean((params.sepa_debit as Params | undefined)?.iban);

    if (!(type === 'card' && card) && !(type === 'sepa_debit' && bank)) {
      unanswered.push(`a payment method of type ${type}`);
      return error(400, {
        message: 'stripe mock: a test card tok_visa, a declined test card or a test iban only',
      });
    }

    const method = {
      id: idOf('pm_', 27),
      type,
      token,
      email: (billing.email as string | undefined) ?? null,
      name: (billing.name as string | undefined) ?? null,
    };
    paymentMethods.set(method.id, method);
    return { status: 200, body: { id: method.id, object: 'payment_method', type } };
  }

  function createPaymentIntent(params: Params): Answer {
    const automatic = params.automatic_payment_methods as Params | undefined;
    const card = params.payment_method;
    if (
      (card !== 'pm_card_visa' &&
        card !== 'pm_card_pendingRefund' &&
        card !== 'pm_card_refundFail' &&
        card !== 'pm_card_createDispute') ||
      params.confirm !== 'true' ||
      automatic?.allow_redirects !== 'never'
    ) {
      unanswered.push('a payment other than one confirmed at once by a test card of the mock');
      return error(400, {
        message:
          'stripe mock: pm_card_visa, pm_card_pendingRefund or pm_card_createDispute confirmed at once only',
      });
    }

    const payment = makePayment({
      amount: Number(params.amount),
      currency: String(params.currency),
      paymentMethod: idOf('pm_', 27),
      description: null,
      status: 'succeeded',
    });
    if (card === 'pm_card_pendingRefund') pendingRefundPayments.add(payment.id);
    // the buyer disputes the payment of this card at once: a fraudulent chargeback of all of it
    if (card === 'pm_card_createDispute') openDisputeOf(payment, {});
    return { status: 200, body: copy(payment) };
  }

  // a move of money of a dispute on the balance: the sum (below 0 taken) and the fee of Stripe
  function disputeTransaction(dispute: Dispute, amount: number, fee: number, withdrawn: boolean) {
    const created = now();
    return {
      id: idOf('txn_', 28),
      object: 'balance_transaction',
      amount,
      available_on: created,
      balance_type: 'payments',
      created,
      currency: dispute.currency,
      description: `Chargeback ${withdrawn ? 'withdrawal' : 'reversal'} for ${String(dispute.charge)}`,
      exchange_rate: null,
      fee,
      fee_details: fee
        ? [
            {
              amount: fee,
              application: null,
              currency: dispute.currency,
              description: 'Dispute fee',
              type: 'stripe_fee',
            },
          ]
        : [],
      net: amount - fee,
      reporting_category: withdrawn ? 'dispute' : 'dispute_reversal',
      source: dispute.id,
      status: 'available',
      type: 'adjustment',
    };
  }

  function openDisputeOf(payment: PaymentIntent, opening: DisputeOpening): Dispute {
    const created = now();
    const status = opening.status ?? 'needs_response';
    const inquiry = status === 'warning_needs_response';
    const method = opening.method ?? 'card';
    const dispute: Dispute = {
      id: idOf('du_', 27),
      object: 'dispute',
      amount: opening.amount ?? payment.amount,
      balance_transactions: [],
      charge: payment.latest_charge,
      created,
      currency: payment.currency,
      enhanced_eligibility_types: [],
      evidence: {
        ...Object.fromEntries(EVIDENCE_FIELDS.map((field) => [field, null])),
        enhanced_evidence: {},
      },
      evidence_details: {
        due_by: created + DISPUTE_DAYS * 86_400,
        enhanced_eligibility: {},
        has_evidence: false,
        past_due: false,
        submission_count: 0,
      },
      is_charge_refundable: opening.refundable ?? (inquiry || method === 'paypal'),
      livemode: false,
      metadata: {},
      payment_intent: payment.id,
      payment_method_details:
        method === 'paypal'
          ? { paypal: { case_id: idOf('PP-D-', 17), reason_code: null }, type: 'paypal' }
          : {
              card: {
                brand: 'visa',
                case_type: inquiry ? 'inquiry' : 'chargeback',
                network_reason_code: inquiry ? null : '10.4',
              },
              type: 'card',
            },
      reason: opening.reason ?? 'fraudulent',
      status,
    };
    disputes.push(dispute);
    record('charge.dispute.created', dispute);

    // a chargeback takes the sum and the fee from the balance at once, an inquiry takes nothing
    if (!inquiry) {
      dispute.balance_transactions.push(
        disputeTransaction(dispute, -Number(dispute.amount), DISPUTE_FEE, true),
      );
      record('charge.dispute.funds_withdrawn', dispute);
    }
    return dispute;
  }

  function endDispute(disputeId: string, end: DisputeEnd): void {
    const dispute = disputes.find((one) => one.id === disputeId);
    if (!dispute) throw new Error(`the stripe mock has no dispute ${disputeId}`);
    if (DISPUTE_ENDS.includes(dispute.status)) {
      throw new Error(`the dispute ${disputeId} is ${dispute.status} already`);
    }

    const inquiry = dispute.status.startsWith('warning_');
    if (inquiry !== (end === 'warning_closed')) {
      throw new Error(`a dispute that is ${dispute.status} does not end ${end}`);
    }

    dispute.status = end;
    dispute.is_charge_refundable = end !== 'lost';
    record('charge.dispute.closed', dispute);

    // won: the bank gives the sum back, and Stripe its fee
    if (end === 'won' && dispute.balance_transactions.length) {
      dispute.balance_transactions.push(
        disputeTransaction(dispute, Number(dispute.amount), -DISPUTE_FEE, false),
      );
      record('charge.dispute.funds_reinstated', dispute);
    }
  }

  function listDisputes(params: Params): Answer {
    const paymentId = String(params.payment_intent ?? '');
    if (!paymentIntents.has(paymentId)) {
      return notTaught('a list of the disputes of a payment the mock does not have');
    }
    const found = disputes.filter((dispute) => dispute.payment_intent === paymentId).reverse();
    return pageOf('/v1/disputes', copy(found), params) ?? notTaught('a page of the disputes');
  }

  // the draft of the evidence is put on the dispute (submit false), or the evidence is submitted
  // (submit true): the test evidence winning_evidence and losing_evidence then end the dispute as
  // the sandbox does a moment later (docs.stripe.com/testing, disputes)
  function updateDispute(id: string, params: Params): Answer {
    const dispute = disputes.find((one) => one.id === id);
    if (!dispute) return noSuchDispute(id);
    if (DISPUTE_ENDS.includes(dispute.status) || dispute.evidence_details.submission_count > 0) {
      return notTaught(`the evidence of a dispute that is ${dispute.status}`);
    }

    const evidence = (params.evidence as Params | undefined) ?? {};
    Object.assign(dispute.evidence, evidence);
    if (Object.keys(evidence).length) dispute.evidence_details.has_evidence = true;

    const submit = params.submit === 'true';
    if (submit) {
      dispute.evidence_details.submission_count += 1;
      dispute.status =
        dispute.status === 'needs_response' ? 'under_review' : 'warning_under_review';
    }
    record('charge.dispute.updated', dispute);

    const verdict = evidence.uncategorized_text;
    if (submit && dispute.status === 'under_review' && verdict === 'winning_evidence') {
      endDispute(id, 'won');
    } else if (submit && dispute.status === 'under_review' && verdict === 'losing_evidence') {
      endDispute(id, 'lost');
    }
    return { status: 200, body: copy(dispute) };
  }

  // a payment the bank charged back: a dispute of it that is not over and lets no refund through
  const chargedBack = (paymentId: string) =>
    disputes.some(
      (dispute) =>
        dispute.payment_intent === paymentId &&
        !dispute.is_charge_refundable &&
        dispute.status !== 'won',
    );

  function createRefund(params: Params): Answer {
    const paymentId = String(params.payment_intent);
    const payment = paymentIntents.get(paymentId);
    if (!payment) return noSuchPayment(paymentId, 'id');
    if (payment.status !== 'succeeded') {
      unanswered.push(`a refund of a payment that is ${payment.status}`);
      return error(400, { message: 'stripe mock: a refund of a payment that succeeded only' });
    }
    // the sandbox refuses a refund of a charge the buyer disputed (seen 04.11.2026)
    if (chargedBack(paymentId)) {
      return error(400, {
        message: `Charge ${String(payment.latest_charge)} has been charged back; cannot issue a refund.`,
        code: 'charge_disputed',
      });
    }
    if (params.reason !== undefined && !REFUND_REASONS.includes(String(params.reason))) {
      return notTaught(`a refund with the reason ${String(params.reason)}`);
    }
    // what is left to give back: a refund that failed or was cancelled took nothing
    const left =
      payment.amount -
      refunds
        .filter(
          (refund) =>
            refund.payment_intent === paymentId &&
            refund.status !== 'failed' &&
            refund.status !== 'canceled',
        )
        .reduce((sum, refund) => sum + Number(refund.amount), 0);
    if (left <= 0) {
      return error(400, {
        message: `Charge ${String(payment.latest_charge)} has already been refunded.`,
        code: 'charge_already_refunded',
      });
    }

    const amount = params.amount === undefined ? left : Number(params.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      return error(400, { message: 'Invalid positive integer', param: 'amount' });
    }
    if (amount > left) {
      const money = (cents: number) => `€${(cents / 100).toFixed(2)}`;
      return error(400, {
        message: `Refund amount (${money(amount)}) is greater than unrefunded amount on charge (${money(left)})`,
        param: 'amount',
      });
    }

    // a refund of the payment of the pending card is pending, as at Stripe, until the test ends it
    const outcome: RefundOutcome | undefined =
      refundOutcomes.shift() ??
      (pendingRefundPayments.has(paymentId) ? { status: 'pending' } : undefined);
    const refund: Refund = {
      id: idOf('re_', 27),
      object: 'refund',
      amount,
      balance_transaction: idOf('txn_', 28),
      charge: payment.latest_charge,
      created: now(),
      currency: payment.currency,
      // the payments of the mock are by card: the bank of the card gives the refund its number
      // some days later (giveRefundReference)
      destination_details: {
        card: {
          reference_status: 'pending',
          reference_type: 'acquirer_reference_number',
          type: 'refund',
        },
        type: 'card',
      },
      ...(outcome?.status === 'failed'
        ? { failure_balance_transaction: idOf('txn_', 28), failure_reason: outcome.reason }
        : {}),
      // a refund made by hand in the dashboard has no key of a transfer of the app
      metadata: (params.metadata as Params | undefined) ?? {},
      payment_intent: paymentId,
      payment_method: payment.payment_method,
      reason: (params.reason as string | undefined) ?? null,
      receipt_number: null,
      status: outcome?.status ?? 'succeeded',
    };
    refunds.push(refund);
    record('refund.created', refund);
    if (outcome?.status === 'failed') record('refund.failed', refund);
    return { status: 200, body: copy(refund) };
  }

  function settleRefund(refundId: string, end: { status: 'succeeded' } | RefundOutcome): void {
    const refund = refunds.find((one) => one.id === refundId);
    if (!refund) throw new Error(`the stripe mock has no refund ${refundId}`);

    refund.status = end.status;
    if (end.status === 'failed') {
      refund.failure_reason = end.reason;
      refund.failure_balance_transaction = idOf('txn_', 28);
    }
    record('refund.updated', refund);
    if (end.status === 'failed') record('refund.failed', refund);
  }

  function giveRefundReference(refundId: string, reference: string): void {
    const refund = refunds.find((one) => one.id === refundId);
    if (!refund) throw new Error(`the stripe mock has no refund ${refundId}`);

    const details = refund.destination_details as { card: Record<string, unknown> };
    details.card.reference = reference;
    details.card.reference_status = 'available';
    record('refund.updated', refund);
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
      case 'GET /v1/refunds/:id': {
        const refund = refunds.find((one) => one.id === id);
        if (!refund) {
          return error(404, {
            message: `No such refund: '${id}'`,
            code: 'resource_missing',
            param: 'refund',
          });
        }
        return { status: 200, body: copy(refund) };
      }
      case 'GET /v1/refunds': {
        const paymentId = String(params.payment_intent);
        if (!paymentIntents.has(paymentId)) return noSuchPayment(paymentId, 'payment_intent');
        return (
          pageOf(
            '/v1/refunds',
            copy(refunds.filter((refund) => refund.payment_intent === paymentId)).reverse(),
            params,
          ) ?? notTaught('a page of the refunds')
        );
      }
      case 'GET /v1/disputes':
        return listDisputes(params);
      case 'GET /v1/disputes/:id': {
        const dispute = disputes.find((one) => one.id === id);
        return dispute ? { status: 200, body: copy(dispute) } : noSuchDispute(id!);
      }
      case 'POST /v1/disputes/:id':
        return updateDispute(id!, params);
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
    queueRefundOutcome: (outcome) => {
      refundOutcomes.push(outcome);
    },
    settleRefund,
    giveRefundReference,
    openDispute: (paymentId, opening = {}) => {
      const payment = paymentIntents.get(paymentId);
      if (!payment) throw new Error(`the stripe mock has no payment ${paymentId}`);
      return openDisputeOf(payment, opening).id;
    },
    endDispute,
  };
}
