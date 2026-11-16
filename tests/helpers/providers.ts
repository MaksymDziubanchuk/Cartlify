// What the tests of the contract of a kind of outside service (tests/integration/providers) need of
// each provider of the kind: a way to make it answer as the contract describes, through the helpers
// of the tests of that provider (its mock, or the real service when the run takes it). The contract
// itself is written once for the kind; a new provider adds its entry here and passes the same tests.
import env from '@config/env.js';

import { brokenPng, pngImage, storedImage, withSilentCloudinaryMoves } from './cloudinary.js';
import { brokenPdf, samplePdf } from './documents.js';
import { answerAsGithub, oidcProvider } from './oauth.js';
import { answerAsModel, cleanText, plainAnswer, realOpenAi, stopModel } from './openai.js';
import {
  answerNewsletterMail,
  breakSpamReportClearing,
  watchMail,
  watchNewsletterMail,
  watchSpamReportClearing,
} from './mail.js';
import { mailEvent, requestOf, signerOfAnotherKey } from './newsletterWebhook.js';
import {
  breakTurnstile,
  CAPTCHA_TOKEN,
  failCaptcha,
  spendCaptcha,
  useCaptchaSecret,
  watchCaptcha,
} from './turnstile.js';
import {
  payByCard,
  queueRefundOutcome,
  realStripe,
  rememberSession,
  withStripeOutOfReach,
} from './stripe.js';
import {
  breakShippyPro,
  MOCK_CARRIERS,
  mockParcel,
  realShippyPro,
  refuseNextParcel,
  SHIPPYPRO_TEST_WEBHOOK_SECRET,
  shippyProWebhookBody,
  useCarriers,
} from './shippyPro.js';

import type {
  MailDropReason,
  MailEventKind,
  MailProviderName,
  MailStream,
} from '@providers/mail/index.js';
import type { AiProviderName } from '@providers/ai/index.js';
import type { CaptchaProviderName } from '@providers/captcha/index.js';
import type {
  DeliveryAddress,
  DeliveryEventKind,
  DeliveryProviderName,
} from '@providers/delivery/index.js';
import type { FileStorageProviderName } from '@providers/files/index.js';
import type { IdentityProviderName } from '@providers/identity/index.js';
import type { PaymentProviderName } from '@providers/payments/index.js';

export type PaymentHarness = {
  // a payment the provider took, of the amount in cents; its id at the provider
  payment(amountCents: number): Promise<string>;
  // the next refund the provider makes is refused at once; none when the provider (the real one)
  // cannot be made to refuse a refund at once
  refuseNextRefund: (() => void) | null;
  // the provider cannot be reached while fn runs
  outOfReach<T>(fn: () => Promise<T>): Promise<T>;
  // a page the test opened, for the provider to close it at the end of the run when it is real
  keepPage(pageId: string): void;
};

export const paymentHarness: Record<PaymentProviderName, PaymentHarness> = {
  stripe: {
    payment: (amountCents) => payByCard(amountCents),
    refuseNextRefund: realStripe
      ? null
      : () => queueRefundOutcome({ status: 'failed', reason: 'lost_or_stolen_card' }),
    outOfReach: withStripeOutOfReach,
    keepPage: (pageId) => {
      rememberSession(pageId);
    },
  },
};

// a request of the webhook of a mail provider: its headers and the bytes of its body
export type MailWebhookRequest = {
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
};

export type MailHarness = {
  // the addresses the provider took a mail of the stream for, from now until the test ends
  watch(stream: MailStream): () => string[];
  // the provider answers the next mails of the newsletter stream with a refusal of this fault, or
  // not at all
  answerNewsletter(answer: 'refused' | 'account' | 'busy' | 'unreachable'): void;
  // the stream has no key of the provider while fn runs
  withoutKey<T>(stream: MailStream, fn: () => Promise<T>): Promise<T>;
  // the addresses taken off the list of complaints from now on; and the provider out of reach for it
  watchCleared(): () => string[];
  breakClearing(): void;
  // an event of a kind the app keeps, in the words of the provider, carrying the tags given
  eventOf(kind: MailEventKind, tags: Record<string, string>, dropReason?: MailDropReason): unknown;
  // an event of a kind the app does not keep
  otherEvent(tags: Record<string, string>): unknown;
  // a batch signed by the provider, by somebody else, or without a signature
  signed(events: unknown[]): MailWebhookRequest;
  signedByAnother(events: unknown[]): MailWebhookRequest;
  unsigned(events: unknown[]): MailWebhookRequest;
};

const sendGridRequest = (request: ReturnType<typeof requestOf>): MailWebhookRequest => ({
  headers: request.headers,
  rawBody: Buffer.from(request.payload),
});

const SENDGRID_DROP_REASONS: Record<MailDropReason, string> = {
  address_bounced: 'Bounced Address',
  address_complained: 'Spam Reporting Address',
};

const SENDGRID_STATUS = { refused: 400, account: 401, busy: 503 } as const;

export const mailHarness: Record<MailProviderName, MailHarness> = {
  sendgrid: {
    watch: (stream) => {
      const mails = stream === 'orders' ? watchMail() : watchNewsletterMail();
      return () => mails.flatMap((mail) => mail.to);
    },
    answerNewsletter: (answer) =>
      answerNewsletterMail(() => (answer === 'unreachable' ? answer : SENDGRID_STATUS[answer])),
    withoutKey: async (stream, fn) => {
      const name = stream === 'orders' ? 'SENDGRID_API_KEY' : 'SENDGRID_NEWSLETTER_API_KEY';
      const saved = env[name];
      env[name] = '';
      try {
        return await fn();
      } finally {
        env[name] = saved;
      }
    },
    watchCleared: () => {
      const calls = watchSpamReportClearing();
      return () => calls.filter((call) => call.status === 204).map((call) => call.email);
    },
    breakClearing: () => breakSpamReportClearing('unreachable'),
    eventOf: (kind, tags, dropReason) => {
      const name = kind === 'bounced' ? 'bounce' : kind === 'complained' ? 'spamreport' : 'dropped';
      return mailEvent(name, null, {
        ...tags,
        ...(kind === 'dropped'
          ? { reason: dropReason ? SENDGRID_DROP_REASONS[dropReason] : 'Invalid' }
          : {}),
      });
    },
    otherEvent: (tags) => mailEvent('delivered', null, tags),
    signed: (events) => sendGridRequest(requestOf(events)),
    signedByAnother: (events) =>
      sendGridRequest(requestOf(events, { signWith: signerOfAnotherKey() })),
    unsigned: (events) => sendGridRequest(requestOf(events, { signature: null })),
  },
};

export type AiHarness = {
  // the provider runs as a mock in this run: the contract does not spend the tokens of a real one
  mock: boolean;
  // the model answers every request with the text, and the moderation with the scores, from now on
  answer(text: string, scores?: Record<string, number>): void;
  // the model answers with the status, or not at all
  refuse(status: number | 'unreachable'): void;
  // the provider has no key while fn runs
  withoutKey<T>(fn: () => Promise<T>): Promise<T>;
  // the provider as the tests leave it otherwise
  reset(): void;
};

export const aiHarness: Record<AiProviderName, AiHarness> = {
  openai: {
    mock: !realOpenAi,
    answer: (text, scores) => {
      answerAsModel(
        () => text,
        () => scores ?? cleanText(),
      );
    },
    refuse: (status) => {
      // the model and the moderation alike
      const refusal = () => {
        if (status === 'unreachable') throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ error: { message: 'refused by the test' } }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      };
      answerAsModel(refusal, refusal);
    },
    withoutKey: async (fn) => {
      answerAsModel(plainAnswer);
      const saved = env.OPENAI_API_KEY;
      env.OPENAI_API_KEY = '';
      try {
        return await fn();
      } finally {
        env.OPENAI_API_KEY = saved;
      }
    },
    reset: stopModel,
  },
};

export type CaptchaHarness = {
  // an answer of the widget the provider takes
  token: string;
  // the provider refuses every answer from now on: as wrong, or as used before
  refuse(): void;
  spend(): void;
  // the provider does not answer, or answers with a failure of its own
  breakDown(): void;
  // the secret of the shop is one the provider does not know
  wrongSecret(): void;
  // the addresses of the visitors the provider was asked about from now on
  watchIps(): () => Array<string | null>;
};

export const captchaHarness: Record<CaptchaProviderName, CaptchaHarness> = {
  turnstile: {
    token: CAPTCHA_TOKEN,
    refuse: failCaptcha,
    spend: spendCaptcha,
    breakDown: () => breakTurnstile('server-error'),
    wrongSecret: () => useCaptchaSecret('0x0000000000000000000000000000000000000000'),
    watchIps: () => {
      const calls = watchCaptcha();
      return () => calls.map((call) => call.remoteip);
    },
  },
};

// a person as the test wants a provider of accounts to tell it
export type IdentityAccount = {
  sub: string;
  email: string;
  verified: boolean;
  name: string;
  picture: string;
};

export type IdentityHarness = {
  // the provider answers the code of a login with the account, from now until the test ends
  answerWith(account: IdentityAccount): void;
  // an address of a picture the provider serves, and one on a host it does not
  ownPicture: string;
};

const oidcHarness = (name: 'google' | 'linkedin', ownPicture: string): IdentityHarness => ({
  answerWith: (account) => {
    const provider = oidcProvider(name);
    provider.answer(
      provider.idToken({
        sub: account.sub,
        email: account.email,
        email_verified: account.verified,
        name: account.name,
        picture: account.picture,
      }),
    );
  },
  ownPicture,
});

export const identityHarness: Record<IdentityProviderName, IdentityHarness> = {
  google: oidcHarness('google', 'https://lh3.googleusercontent.com/a/photo=s96-c'),
  github: {
    answerWith: (account) => {
      answerAsGithub({
        id: Number(account.sub),
        name: account.name,
        avatar_url: account.picture,
        emails: [{ email: account.email, primary: true, verified: account.verified }],
      });
    },
    ownPicture: 'https://avatars.githubusercontent.com/u/1?v=4',
  },
  linkedin: oidcHarness('linkedin', 'https://media.licdn.com/dms/image/photo'),
};

export type FileStorageHarness = {
  // a picture and a pdf the storage reads, and files that start as one but are none
  image(): Buffer;
  brokenImage(): Buffer;
  pdf(): Buffer;
  brokenPdf(): Buffer;
  // the folder the files of the tests go to (the storage refuses any other in the tests)
  folder: string;
  // whether the storage keeps a file under the id
  keeps(publicId: string): Promise<boolean>;
  // the storage takes the connection of a move and never answers while fn runs
  silentMoves<T>(fn: () => Promise<T>): Promise<T>;
};

export const fileStorageHarness: Record<FileStorageProviderName, FileStorageHarness> = {
  cloudinary: {
    image: () => pngImage(8, 8),
    brokenImage: brokenPng,
    pdf: () => samplePdf(),
    brokenPdf,
    folder: 'test/',
    keeps: async (publicId) => (await storedImage(publicId)) !== null,
    silentMoves: withSilentCloudinaryMoves,
  },
};

// where the parcels of the contract go: a sender in Valencia, a recipient in Madrid and one in
// London, made up; the carrier Generic of the account of the tests takes them all
const testAddress = (over: Partial<DeliveryAddress>): DeliveryAddress => ({
  name: 'Test Recipient',
  street: 'Calle Mayor',
  house: '1',
  apartment: null,
  city: 'Madrid',
  postalCode: '28013',
  country: 'ES',
  phone: '+34910000000',
  email: 'recipient@example.com',
  ...over,
});

export type DeliveryHarness = {
  // the run asks the real service: the contract makes one parcel and no more (a label each)
  real: boolean;
  sender: DeliveryAddress;
  recipient: DeliveryAddress;
  abroad: DeliveryAddress;
  // the name of a carrier of the account that cannot void a parcel; and one that can, null when the
  // account of the run has none (the real one of the tests)
  steadyCarrier: string;
  voidingCarrier: string | null;
  // the carrier refuses the next parcel with the reason; null when the real one cannot be made to
  refuseNext: ((reason: string) => void) | null;
  // the first carrier of the account prices in another currency than the shop; null for real
  pricesInOtherCurrency: (() => void) | null;
  // the provider does not answer while fn runs
  outOfReach<T>(fn: () => Promise<T>): Promise<T>;
  // the server has no key of the provider while fn runs
  withoutKey<T>(fn: () => Promise<T>): Promise<T>;
  // the server has no secret of the webhook while fn runs
  withoutWebhookSecret<T>(fn: () => T): T;
  // whether the provider still keeps the parcel live (a void takes it off)
  keepsLive(parcelId: string): Promise<boolean> | null;
  // the headers of a request of the webhook: from the provider, with another secret, without any
  webhookHeaders(secret?: 'own' | 'other' | 'none'): Record<string, string>;
  // the body of an event of the parcel the provider posts, of a kind the app takes or of one it
  // drops
  eventBody(
    kind: DeliveryEventKind | 'dropped',
    parcel: { parcelId: string; reference: string; trackingNumber?: string | null },
    at?: Date,
  ): unknown;
};

const SHIPPYPRO_EVENTS: Record<
  Exclude<DeliveryEventKind, 'created' | 'failed'> | 'dropped',
  { code: number; extendedCode: string }
> = {
  collected: { code: 2, extendedCode: '2200' },
  delivered: { code: 6, extendedCode: '6000' },
  returning: { code: 5, extendedCode: '5630' },
  returned: { code: 5, extendedCode: '5640' },
  lost: { code: 5, extendedCode: '5330' },
  dropped: { code: 1, extendedCode: '1000' },
};

export const deliveryHarness: Record<DeliveryProviderName, DeliveryHarness> = {
  shippypro: {
    real: realShippyPro,
    sender: testAddress({
      name: 'Test Sender',
      street: 'Calle de la Paz',
      city: 'Valencia',
      postalCode: '46003',
      phone: '+34960000000',
      email: 'sender@example.com',
    }),
    recipient: testAddress({}),
    abroad: testAddress({
      street: 'Test Street',
      city: 'London',
      postalCode: 'E1 6AN',
      country: 'GB',
      phone: '+442000000000',
    }),
    steadyCarrier: 'Generic',
    // what the real account cannot be made to do answers from the mock in both modes
    voidingCarrier: 'MockExpress',
    refuseNext: (reason) => refuseNextParcel(reason),
    pricesInOtherCurrency: () =>
      useCarriers(MOCK_CARRIERS.map((c, i) => (i === 0 ? { ...c, currency: 'USD' } : c))),
    outOfReach: async (fn) => {
      breakShippyPro('unreachable');
      return fn();
    },
    withoutKey: async (fn) => {
      const saved = env.SHIPPYPRO_API_KEY;
      env.SHIPPYPRO_API_KEY = '';
      try {
        return await fn();
      } finally {
        env.SHIPPYPRO_API_KEY = saved;
      }
    },
    withoutWebhookSecret: (fn) => {
      const saved = env.SHIPPYPRO_WEBHOOK_SECRET;
      const restore = () => {
        env.SHIPPYPRO_WEBHOOK_SECRET = saved;
      };
      env.SHIPPYPRO_WEBHOOK_SECRET = '';
      let out: ReturnType<typeof fn>;
      try {
        out = fn();
      } catch (error) {
        restore();
        throw error;
      }
      // a request keeps the secret away until it is answered (app.inject starts it on then)
      const thenable = out as { then?: unknown } | null;
      if (
        thenable !== null &&
        typeof thenable === 'object' &&
        typeof thenable.then === 'function'
      ) {
        return Promise.resolve(out).finally(restore) as typeof out;
      }
      restore();
      return out;
    },
    // a parcel of the mock; one of the real account cannot be looked at here
    keepsLive: (parcelId) => {
      const parcel = mockParcel(parcelId);
      return parcel ? Promise.resolve(!parcel.voided) : null;
    },
    webhookHeaders: (secret = 'own') => ({
      'content-type': 'application/json',
      ...(secret === 'none'
        ? {}
        : {
            'x-webhook-secret': secret === 'own' ? SHIPPYPRO_TEST_WEBHOOK_SECRET : 'another-secret',
          }),
    }),
    eventBody: (kind, parcel, at) => {
      if (kind === 'created') return shippyProWebhookBody('shipped', parcel);
      if (kind === 'failed') return shippyProWebhookBody('error', parcel);
      return shippyProWebhookBody('tracking', parcel, {
        ...SHIPPYPRO_EVENTS[kind],
        ...(at ? { date: Math.floor(at.getTime() / 1000) } : {}),
      });
    },
  },
};
