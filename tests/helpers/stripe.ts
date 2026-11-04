import Stripe from 'stripe';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, jest } from '@jest/globals';

import appStripe from '@config/stripe.js';

import { STRIPE_PLACEHOLDER_KEY } from '../setup/isolateEnv.js';
import { uniqueTag } from './factories.js';
import { hideSecrets } from './hideSecrets.js';
import { isRealService } from './services.js';
import { startStripeMock, type RefundOutcome, type StripeMock } from './stripeMock.js';

// Stripe answers from a mock (tests/helpers/stripeMock.ts) unless the run takes it for real
// (service:stripe): then the payment tests use the key of a test sandbox (STRIPE_TEST_SECRET_KEY,
// tests/setup/integration.setup.ts) and pay with a test card. Either way the client of the app
// and the one of the helpers are the real sdk, only where they send their requests differs. The
// sandbox has no webhook endpoint and the mock sends nothing: a test takes the event Stripe recorded
// for its payment page from the events api and delivers it to the webhook route, signed with the
// test webhook secret the way Stripe signs it. Stripe out of reach is a real failed connection of
// the client of the app (withStripeOutOfReach); the helpers use a client of their own, so they
// still reach Stripe meanwhile. tests/integration/api/payments/stripeAnswers.test.ts holds the mock
// to the answers of the sandbox: it runs in both modes

export const realStripe = isRealService('stripe');

export const WEBHOOK_URL = '/api/payments/stripe/webhook';

const testStripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? STRIPE_PLACEHOLDER_KEY, {
  maxNetworkRetries: 2,
});

// the client of the helpers, for a test of the answers of Stripe themselves
export const stripeOfTests = testStripe;

// the clients of the app and of the helpers send their requests to the mock
function aimAt(client: Stripe, port: number) {
  client._setApiField('host', '127.0.0.1');
  client._setApiField('port', port);
  client._setApiField('protocol', 'http');
}

// a client with another key, sent where the client of the helpers goes
export function stripeWithKey(key: string): Stripe {
  const client = new Stripe(key);
  for (const field of ['host', 'port', 'protocol'] as const) {
    client._setApiField(field, testStripe.getApiField(field));
  }
  return client;
}

// every integration test file: the mock starts before the file and stops after it, unless the run
// takes Stripe for real. A request the mock does not answer fails the test that sent it: the mock
// would only guess, so it gets the answer of the sandbox first
// the mock of the file under test; none when the run takes Stripe for real
let activeMock: StripeMock | null = null;

function mockOfRefunds(): StripeMock {
  if (!activeMock) {
    throw new Error(
      'this end of a refund or of a dispute can be made by the mock only, not by Stripe',
    );
  }
  return activeMock;
}

// the next refund Stripe makes is still pending, or fails with the reason (mock only)
export const queueRefundOutcome = (outcome: RefundOutcome) =>
  mockOfRefunds().queueRefundOutcome(outcome);

// a refund that was pending ends the way given; the event of it is recorded for the webhook (mock only)
export const settleRefund = (refundId: string, end: { status: 'succeeded' } | RefundOutcome) =>
  mockOfRefunds().settleRefund(refundId, end);

// the test card whose refunds are pending first and succeed a moment later, with a refund.updated
// event (docs.stripe.com/testing, refunds; the sandbox took about two minutes, 04.11.2026); the mock
// keeps it pending until a test ends it (settleRefund)
export const PENDING_REFUND_CARD = 'pm_card_pendingRefund';

// the test card whose payment the buyer disputes at the bank at once (docs.stripe.com/testing,
// disputes): Stripe refuses a refund of it with charge_disputed, the mock does the same
export const DISPUTED_CARD = 'pm_card_createDispute';

// the test card of a card that is gone: a refund succeeds, then the bank sends the money back and
// Stripe fails it with expired_or_canceled_card and refund.failed (about 130 s later in the
// sandbox, 04.11.2026); the mock fails it when the test says so (refundBecomes)
export const REFUND_FAIL_CARD = 'pm_card_refundFail';

// the time a test that waits for Stripe may take with the sandbox: Stripe ends a pending refund or
// fails one of a card that is gone about two minutes later (04.11.2026); the mock answers at once,
// those tests keep the usual limit there
export const stripeWait: number | undefined = realStripe ? 300_000 : undefined;

// asks Stripe until the answer is there (not null), for at most four minutes
export async function untilStripe<T>(
  what: string,
  ask: () => Promise<T | null | undefined>,
): Promise<T> {
  const until = Date.now() + 240_000;
  for (;;) {
    const answer = await call(what, ask);
    if (answer !== null && answer !== undefined) return answer;
    if (Date.now() > until) throw new Error(`Stripe did not give ${what} in four minutes`);
    await sleep(3000);
  }
}

// a refund ends the way Stripe ends it on its own: the sandbox does it a moment later (the card of
// the payment decides how), the test waits; the mock ends it now
export async function refundBecomes(
  refundId: string,
  end: { status: 'succeeded' } | RefundOutcome,
): Promise<void> {
  if (!realStripe) {
    settleRefund(refundId, end);
    return;
  }
  await untilStripe(`the end ${end.status} of the refund`, async () => {
    const refund = await testStripe.refunds.retrieve(refundId);
    return refund.status === end.status ? refund : null;
  });
}

// the bank decides the dispute of a payment of DISPUTED_CARD: the sandbox closes it by the test
// evidence (winning_evidence or losing_evidence, docs.stripe.com/testing; won in about 20 s,
// 04.11.2026), the test waits; the mock closes it now
export async function closeDispute(paymentId: string, outcome: 'won' | 'lost'): Promise<void> {
  if (!realStripe) {
    mockOfRefunds().closeDispute(paymentId, outcome);
    return;
  }
  const dispute = await untilStripe('the dispute of the payment', async () => {
    const found = await testStripe.disputes.list({ payment_intent: paymentId, limit: 1 });
    return found.data[0] ?? null;
  });
  await call('answer the dispute', () =>
    testStripe.disputes.update(dispute.id, {
      evidence: { uncategorized_text: outcome === 'won' ? 'winning_evidence' : 'losing_evidence' },
      submit: true,
    }),
  );
  await untilStripe(`the dispute ${outcome}`, async () => {
    const now = await testStripe.disputes.retrieve(dispute.id);
    return now.status === outcome ? now : null;
  });
}

export function installStripe(): void {
  if (realStripe) return;

  const mock = startStripeMock(process.env.STRIPE_SECRET_KEY ?? STRIPE_PLACEHOLDER_KEY);
  activeMock = mock;
  const failUnanswered = () => {
    const unanswered = mock.takeUnanswered();
    if (unanswered.length) {
      throw new Error(
        `the Stripe mock does not answer ${unanswered.join('; ')}: add the answer of the ` +
          'sandbox to tests/helpers/stripeMock.ts and to stripeAnswers.test.ts',
      );
    }
  };

  beforeAll(async () => {
    const port = await mock.listen();
    aimAt(appStripe, port);
    aimAt(testStripe, port);
  });
  afterEach(failUnanswered);
  afterAll(async () => {
    await mock.close();
    failUnanswered();
  });
}

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

// the payment pages a test file opened, closed after it so none stays open in the sandbox; the
// pages of the mock go with it
const openedSessions = new Set<string>();

export function rememberSession(sessionId: string): string {
  openedSessions.add(sessionId);
  return sessionId;
}

export async function closeOpenSessions(): Promise<void> {
  if (!realStripe) {
    openedSessions.clear();
    return;
  }

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

// the lines of a payment page, as Stripe shows them to the buyer
export const lineItemsOf = (sessionId: string) =>
  call('read the lines of the payment page', async () =>
    (await testStripe.checkout.sessions.listLineItems(sessionId, { limit: 100 })).data.map(
      (line) => ({
        description: line.description,
        quantity: line.quantity,
        unitAmount: line.price?.unit_amount ?? null,
        amountTotal: line.amount_total,
      }),
    ),
  );

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
  const refusal = await tryCardOnPage(sessionId, 'tok_visa');
  if (refusal) throw new Error(`the test card was refused on the page: ${refusal.code}`);

  const after = await readSession(sessionId);
  const payment = after.payment_intent;
  const paymentId = typeof payment === 'string' ? payment : payment?.id;
  if (!paymentId) throw new Error('the paid page has no payment');
  return paymentId;
}

// the buyer tries a test card on the page (docs.stripe.com/testing: tok_visa pays,
// tok_chargeDeclined, tok_chargeDeclinedInsufficientFunds and tok_chargeDeclinedExpiredCard are
// refused by the bank of the card); null when the page is paid, the refusal otherwise
export async function tryCardOnPage(
  sessionId: string,
  token: string,
): Promise<{
  statusCode: number;
  type: string;
  code: string;
  declineCode: string;
  message: string;
} | null> {
  const session = await readSession(sessionId);

  await call('open the payment page', () =>
    testStripe.rawRequest('GET', `/v1/payment_pages/${sessionId}`, {}),
  );
  const card = await call('make a test card', () =>
    testStripe.paymentMethods.create({
      type: 'card',
      card: { token },
      // the page knows the email of the buyer: the card has the same one
      billing_details: { email: session.customer_email ?? 'buyer@example.com', name: 'Test Buyer' },
    }),
  );
  try {
    const paid = await testStripe.rawRequest('POST', `/v1/payment_pages/${sessionId}/confirm`, {
      payment_method: card.id,
      expected_amount: session.amount_total,
    });
    if (paid.payment_status !== 'paid') {
      throw new Error(`the test card left the page ${paid.payment_status}`);
    }
    return null;
  } catch (err) {
    const e = err as Stripe.errors.StripeError & { raw?: { decline_code?: string } };
    if (e.type !== 'StripeCardError') throw stripeFailure(err, 'pay the page');
    return {
      statusCode: e.statusCode ?? 0,
      type: e.type,
      code: e.code ?? '',
      declineCode: e.raw?.decline_code ?? '',
      message: e.message,
    };
  }
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

// a payment of the amount (in cents) with a test card (pm_card_visa unless given), without a payment
// page: an order an admin cancels needs a payment Stripe really took. Returns the payment
export async function payByCard(amount: number, card = 'pm_card_visa'): Promise<string> {
  const payment = await call('take a test card payment', () =>
    testStripe.paymentIntents.create({
      amount,
      currency: 'eur',
      payment_method: card,
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
