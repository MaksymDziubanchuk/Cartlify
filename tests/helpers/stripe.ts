import Stripe from 'stripe';
import type { FastifyInstance } from 'fastify';
import { describe, jest } from '@jest/globals';

import appStripe from '@config/stripe.js';

import { STRIPE_PLACEHOLDER_KEY } from '../setup/isolateEnv.js';
import { uniqueTag } from './factories.js';
import { hideSecrets } from './hideSecrets.js';

// Stripe has a test mode: the payment tests use the key of a test sandbox (STRIPE_TEST_SECRET_KEY,
// tests/setup/integration.setup.ts) and pay with a test card. The sandbox has no webhook endpoint,
// so Stripe delivers nothing by itself: a test takes the event Stripe recorded for its payment page
// from the events api and delivers it to the webhook route, signed with the test webhook secret
// the way Stripe signs it. No answer of Stripe is made up: Stripe out of reach is a real failed
// connection of the client of the app (withStripeOutOfReach); the helpers here use a client of
// their own, so they still reach Stripe meanwhile

export const hasStripe = (process.env.STRIPE_SECRET_KEY ?? '') !== STRIPE_PLACEHOLDER_KEY;

// without the key (a ci run without the secret) these tests are skipped
export const describeWithStripe = hasStripe ? describe : describe.skip;

export const WEBHOOK_URL = '/api/payments/stripe/webhook';

const testStripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? STRIPE_PLACEHOLDER_KEY, {
  maxNetworkRetries: 2,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// a Stripe failure without the key in it: an error of Stripe quotes its end, so it is not kept
// as the cause either
function stripeFailure(err: unknown, what: string): Error {
  const e = err as { type?: string; statusCode?: number; code?: string; message?: string };

  return new Error(
    hideSecrets(
      `Stripe could not ${what}: ${e.type ?? ''} ${e.statusCode ?? ''} ${e.code ?? ''} ` +
        `${e.message ?? String(err)}`,
    ),
  );
}

async function call<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw stripeFailure(err, what);
  }
}

// the payment pages a test file opened, closed after it so none stays open in the sandbox
const openedSessions = new Set<string>();

export function rememberSession(sessionId: string): string {
  openedSessions.add(sessionId);
  return sessionId;
}

export async function closeOpenSessions(): Promise<void> {
  await Promise.allSettled(
    [...openedSessions].map(async (id) => {
      const session = await testStripe.checkout.sessions.retrieve(id);
      if (session.status === 'open') await testStripe.checkout.sessions.expire(id);
    }),
  );
  openedSessions.clear();
}

export const readSession = (sessionId: string) =>
  call('read the payment page', () => testStripe.checkout.sessions.retrieve(sessionId));

export const expireSession = (sessionId: string) =>
  call('close the payment page', () => testStripe.checkout.sessions.expire(sessionId));

// a payment page that is not one of the app, for example of another tool using the sandbox
export async function openForeignSession(
  opts: { amount?: number; metadata?: Record<string, string> } = {},
): Promise<Stripe.Checkout.Session> {
  const session = await call('open a payment page', () =>
    testStripe.checkout.sessions.create({
      mode: 'payment',
      allowed_payment_method_types: ['card'],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: opts.amount ?? 1000,
            product_data: { name: 'Not a Cartlify order' },
          },
        },
      ],
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
      success_url: 'https://shop.example.com/elsewhere',
    }),
  );
  rememberSession(session.id);
  return session;
}

// pays the page with a test card the way `stripe trigger checkout.session.completed` does: through
// the api of the payment page itself. It is not documented, a change at Stripe breaks only this
// step. Returns the payment of the page
export async function payCheckoutSession(sessionId: string): Promise<string> {
  const session = await readSession(sessionId);

  await call('open the payment page', () =>
    testStripe.rawRequest('GET', `/v1/payment_pages/${sessionId}`, {}),
  );
  const card = await call('make a test card', () =>
    testStripe.paymentMethods.create({
      type: 'card',
      card: { token: 'tok_visa' },
      billing_details: { email: 'buyer@example.com', name: 'Test Buyer' },
    }),
  );
  const paid = await call('pay the page', () =>
    testStripe.rawRequest('POST', `/v1/payment_pages/${sessionId}/confirm`, {
      payment_method: card.id,
      expected_amount: session.amount_total,
    }),
  );
  if (paid.payment_status !== 'paid') {
    throw new Error(`the test card left the page ${paid.payment_status}`);
  }

  const after = await readSession(sessionId);
  const payment = after.payment_intent;
  const paymentId = typeof payment === 'string' ? payment : payment?.id;
  if (!paymentId) throw new Error('the paid page has no payment');
  return paymentId;
}

// the event Stripe recorded for the payment page; it comes a moment after the change
export async function stripeEvent(
  type: Stripe.Event.Type,
  sessionId: string,
): Promise<Stripe.Event> {
  const since = Math.floor(Date.now() / 1000) - 600;

  for (let attempt = 0; attempt < 40; attempt++) {
    const events = await call('list the events', () =>
      testStripe.events.list({ type, created: { gte: since }, limit: 100 }),
    );
    const event = events.data.find(
      (candidate) => (candidate.data.object as { id?: string }).id === sessionId,
    );
    if (event) return event;
    await sleep(500);
  }

  throw new Error(`Stripe recorded no ${type} event for the page in 20 s`);
}

// an event Stripe could send but a test cannot make it send (an async payment method; an object
// of another kind), around an object Stripe gave
export const craftEvent = (type: string, object: unknown) => ({
  id: `evt_test_${uniqueTag().replaceAll('-', '_')}`,
  object: 'event',
  api_version: null,
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  pending_webhooks: 0,
  request: { id: null, idempotency_key: null },
  type,
  data: { object },
});

// the signature header Stripe sends with the body; another secret or time makes a wrong one
export const signatureOf = (payload: string, opts: { secret?: string; timestamp?: number } = {}) =>
  testStripe.webhooks.generateTestHeaderString({
    payload,
    secret: opts.secret ?? process.env.STRIPE_WEBHOOK_SECRET!,
    ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
  });

// delivers the event to the webhook route the way Stripe does
export function deliver(
  app: FastifyInstance,
  event: unknown,
  opts: { secret?: string; timestamp?: number; remoteAddress?: string } = {},
) {
  const payload = typeof event === 'string' ? event : JSON.stringify(event);

  return app.inject({
    method: 'POST',
    url: WEBHOOK_URL,
    headers: { 'content-type': 'application/json', 'stripe-signature': signatureOf(payload, opts) },
    payload,
    ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
  });
}

export const refundsOf = async (paymentId: string) =>
  (await call('list the refunds', () => testStripe.refunds.list({ payment_intent: paymentId })))
    .data;

// money given back outside the app, the way an admin does it in the Stripe dashboard
export const refundAtStripe = (paymentId: string) =>
  call('refund the payment', () => testStripe.refunds.create({ payment_intent: paymentId }));

// a payment of the amount (in cents) with a test card, without a payment page: an order an admin
// cancels needs a payment Stripe really took. Returns the payment
export async function payByCard(amount: number): Promise<string> {
  const payment = await call('take a test card payment', () =>
    testStripe.paymentIntents.create({
      amount,
      currency: 'eur',
      payment_method: 'pm_card_visa',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    }),
  );
  if (payment.status !== 'succeeded') throw new Error(`the test card left ${payment.status}`);
  return payment.id;
}

// a page paid by a bank debit (SEPA, a test IBAN): complete, but the bank still decides, so it
// is not paid yet. The app opens only card pages, a test links this one to an order itself
export async function openBankPaymentPage(amount: number): Promise<string> {
  const session = await call('open a bank payment page', () =>
    testStripe.checkout.sessions.create({
      mode: 'payment',
      allowed_payment_method_types: ['sepa_debit'],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: amount,
            product_data: { name: 'Bank payment' },
          },
        },
      ],
      success_url: 'https://shop.example.com/checkout/success',
    }),
  );

  await call('open the payment page', () =>
    testStripe.rawRequest('GET', `/v1/payment_pages/${session.id}`, {}),
  );
  const debit = await call('make a test bank account', () =>
    testStripe.paymentMethods.create({
      type: 'sepa_debit',
      sepa_debit: { iban: 'DE89370400440532013000' },
      billing_details: { email: 'buyer@example.com', name: 'Test Buyer' },
    }),
  );
  await call('pay the page by the bank', () =>
    testStripe.rawRequest('POST', `/v1/payment_pages/${session.id}/confirm`, {
      payment_method: debit.id,
      expected_amount: amount,
    }),
  );

  return session.id;
}

// Stripe out of reach for real: the client of the app goes to a closed port while fn runs, its
// requests fail the way they fail without a network (StripeConnectionError after its retries)
export async function withStripeOutOfReach<T>(fn: () => Promise<T>): Promise<T> {
  const saved = (['host', 'port', 'protocol'] as const).map(
    (field) => [field, appStripe.getApiField(field)] as const,
  );
  appStripe._setApiField('host', '127.0.0.1');
  appStripe._setApiField('port', 9);
  appStripe._setApiField('protocol', 'http');

  try {
    return await fn();
  } finally {
    for (const [field, value] of saved) appStripe._setApiField(field, value);
  }
}

// the same for one call of the app only, for example the close of a page while reading it works;
// jest.restoreAllMocks puts the call back
export function outOfReachDuring<T extends object, K extends keyof T>(resource: T, method: K) {
  const original = resource[method] as (...args: unknown[]) => Promise<unknown>;

  jest
    .spyOn(resource, method as never)
    .mockImplementation(((...args: unknown[]) =>
      withStripeOutOfReach(() => original.apply(resource, args))) as never);
}

type StripeRequest = { method?: string; path?: string; idempotency_key?: string };

// the requests the app sends to Stripe while fn runs; they go through as they are
export async function stripeRequestsDuring(fn: () => Promise<unknown>): Promise<StripeRequest[]> {
  const seen: StripeRequest[] = [];
  const listener = (request: StripeRequest) => seen.push(request);
  appStripe.on('request', listener);

  try {
    await fn();
  } finally {
    appStripe.off('request', listener);
  }
  return seen;
}
