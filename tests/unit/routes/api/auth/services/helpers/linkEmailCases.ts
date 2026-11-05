import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { FastifyBaseLogger } from 'fastify';

import { rejectedBy } from '../../../../../../helpers/errors.js';
import { jsonResponse, stubFetch, textResponse } from '../../../../../../helpers/fetchStub.js';
import { importWithEnv } from '../../../../../../helpers/freshImport.js';
import { pngImage } from '../../../../../../helpers/cloudinary.js';

// the verify and the reset mails differ only in the page the link opens and in the error
// code, so both test files run these cases

type SendLinkEmail = (
  args: { to: string; token: string; expiresAt: Date },
  log: Pick<FastifyBaseLogger, 'warn'>,
) => Promise<{ status: number }>;

export type LinkEmailCase = {
  specifier: string;
  // the helper under test, taken from its freshly imported module
  pick: (module: any) => SendLinkEmail;
  linkPath: string;
  failureCode: string;
};

const CONFIG = {
  SENDGRID_API_KEY: 'SG.test-sendgrid-key',
  EMAIL_FROM: 'shop@cartlify.test',
  WEB_ORIGIN: 'https://shop.example.com',
};

// the data of the shop, read at request time, not at import (@config/shopSettings.js); no logo,
// the way most of these cases run (the logo of the mails has its own two cases below)
const SETTINGS = { emailFromName: 'Cartlify', emailReplyTo: 'help@cartlify.test' };

const LOGO_URL = 'https://res.cloudinary.com/cartlify-test/image/upload/v1/test/shop/logo/a.png';
const LOGO_BYTES = pngImage(6, 4);

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const log = () => ({ warn: jest.fn() });

// one handler for both calls a mail with a logo makes: the logo of the shop and the send of
// sendgrid itself; sendPayload picks the sendgrid call back out
const stubFetchAndLogo = () =>
  stubFetch((call) =>
    call.url === LOGO_URL
      ? new Response(new Uint8Array(LOGO_BYTES), { headers: { 'content-type': 'image/png' } })
      : textResponse('', 202),
  );

const sendPayload = (calls: ReturnType<typeof stubFetch>) =>
  JSON.parse(calls.find((call) => call.url !== LOGO_URL)!.body);

// the plain text part of the first mail sendgrid got
const sentText = (body: string) => JSON.parse(body).content[0].value as string;

// "This link is valid for 2 hours." -> 2 hours in ms
function statedValidity(text: string): number {
  const match = /valid for (\d+) (minute|hour|day)s?\./.exec(text);
  if (!match) throw new Error(`no validity line in: ${text}`);

  const unit = { minute: MINUTE, hour: HOUR, day: DAY }[match[2] as 'minute' | 'hour' | 'day'];
  return Number(match[1]) * unit;
}

export function describeLinkEmail(name: string, c: LinkEmailCase): void {
  describe(name, () => {
    let send: SendLinkEmail;

    beforeAll(async () => {
      send = c.pick(await importWithEnv(c.specifier, CONFIG, { shopSettings: SETTINGS }));
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const mail = (validFor = HOUR, token = 'tok-123') => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      return { to: 'buyer@cartlify.test', token, expiresAt: new Date(NOW + validFor) };
    };

    it('mails a link to our web page with the token', async () => {
      const calls = stubFetch(() => textResponse('', 202));

      expect(await send(mail(), log())).toEqual({ status: 202 });
      expect(JSON.parse(calls[0]!.body).personalizations[0].to).toEqual([
        { email: 'buyer@cartlify.test' },
      ]);
      expect(sentText(calls[0]!.body)).toContain(`${CONFIG.WEB_ORIGIN}${c.linkPath}?token=tok-123`);
    });

    it('encodes a token with url characters so the link stays whole', async () => {
      const calls = stubFetch(() => textResponse('', 202));

      await send(mail(HOUR, 'a+b/c=&d'), log());

      expect(sentText(calls[0]!.body)).toContain(`${c.linkPath}?token=a%2Bb%2Fc%3D%26d`);
    });

    // the plan for this (notes/i18n-shop-steps.md, step 4): no logo is not a reason to refuse the
    // mail, only to send it without one
    it('sends no attachment and no place for a logo in the html when the shop has none', async () => {
      const calls = stubFetch(() => textResponse('', 202));

      await send(mail(), log());

      const payload = JSON.parse(calls[0]!.body);
      expect(payload.attachments).toBeUndefined();
      expect(payload.content[1].value).not.toContain('cid:cartlify-logo');
    });

    it('attaches the logo inline under the id the html refers to, when the shop has one', async () => {
      const withLogo = c.pick(
        await importWithEnv(c.specifier, CONFIG, {
          shopSettings: { ...SETTINGS, logoUrl: LOGO_URL },
        }),
      );
      const calls = stubFetchAndLogo();

      await withLogo(mail(), log());

      expect(sendPayload(calls).attachments).toEqual([
        {
          content: LOGO_BYTES.toString('base64'),
          type: 'image/png',
          filename: 'logo.png',
          disposition: 'inline',
          content_id: 'cartlify-logo',
        },
      ]);
      expect(sendPayload(calls).content[1].value).toContain('cid:cartlify-logo');
    });

    // a logo Cloudinary does not answer is only logged, the mail still goes, without it
    it('sends the mail without the logo when Cloudinary does not answer for it', async () => {
      const withLogo = c.pick(
        await importWithEnv(c.specifier, CONFIG, {
          shopSettings: { ...SETTINGS, logoUrl: LOGO_URL },
        }),
      );
      const warnLog = log();
      stubFetch((call) =>
        call.url === LOGO_URL ? new Response(null, { status: 404 }) : textResponse('', 202),
      );

      expect(await withLogo(mail(), warnLog)).toEqual({ status: 202 });
      expect(warnLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ url: LOGO_URL }),
        'logo of the shop was not fetched for a mail',
      );
    });

    it.each([
      ['15 minutes', 15 * MINUTE],
      ['24 hours', 24 * HOUR],
      ['3 days', 3 * DAY],
    ])('says the link is valid for %s', async (text, validFor) => {
      const calls = stubFetch(() => textResponse('', 202));

      await send(mail(validFor), log());

      expect(sentText(calls[0]!.body)).toContain(`This link is valid for ${text}.`);
    });

    it.each([
      ['1 minute', MINUTE],
      ['1 hour', HOUR],
    ])('uses the singular: %s', async (text, validFor) => {
      const calls = stubFetch(() => textResponse('', 202));

      await send(mail(validFor), log());

      expect(sentText(calls[0]!.body)).toContain(`This link is valid for ${text}.`);
    });

    // rounding up a unit would tell the customer the link works when it no longer does
    it.each([
      ['61 minutes', 61 * MINUTE],
      ['90 minutes', 90 * MINUTE],
      ['25 hours', 25 * HOUR],
      ['49 hours', 49 * HOUR],
    ])('never promises more time than the link has: %s', async (_label, validFor) => {
      const calls = stubFetch(() => textResponse('', 202));

      await send(mail(validFor), log());

      expect(statedValidity(sentText(calls[0]!.body))).toBeLessThanOrEqual(validFor);
    });

    it('hides what the provider said behind a bad gateway error', async () => {
      stubFetch(() => jsonResponse({ errors: [{ message: 'internal provider detail' }] }, 500));

      const err = await rejectedBy(() => send(mail(), log()));

      expect(err).toMatchObject({
        statusCode: 502,
        errorCode: c.failureCode,
        message: 'Bad Gateway',
      });
      expect((err as { details?: unknown }).details).toBeUndefined();
    });

    // a missing setting is our fault, not a failure of the mail provider
    it('reports missing mail settings as a server error, not as a provider failure', async () => {
      const unconfigured = c.pick(
        await importWithEnv(
          c.specifier,
          { ...CONFIG, SENDGRID_API_KEY: '' },
          { shopSettings: SETTINGS },
        ),
      );
      stubFetch(() => textResponse('', 202));

      expect(await rejectedBy(() => unconfigured(mail(), log()))).toMatchObject({
        statusCode: 500,
        details: { reason: 'SENDGRID_API_KEY_REQUIRED' },
      });
    });

    it('reports an empty address of the customer as a server error', async () => {
      stubFetch(() => textResponse('', 202));

      expect(await rejectedBy(() => send({ ...mail(), to: ' ' }, log()))).toMatchObject({
        statusCode: 500,
        details: { reason: 'EMAIL_TO_REQUIRED' },
      });
    });

    it('turns a network failure of the provider into a bad gateway too', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

      expect(await rejectedBy(() => send(mail(), log()))).toMatchObject({
        statusCode: 502,
        errorCode: c.failureCode,
      });
    });

    // a link to localhost in a mail from the live shop opens nothing for the customer
    it('never mails a localhost link from production', async () => {
      const live = c.pick(
        await importWithEnv(
          c.specifier,
          { ...CONFIG, NODE_ENV: 'production', WEB_ORIGIN: '' },
          { shopSettings: SETTINGS },
        ),
      );
      const calls = stubFetch(() => textResponse('', 202));

      await live(mail(), log()).catch(() => undefined);

      expect(calls.map((call) => sentText(call.body)).join('\n')).not.toContain('localhost');
    });

    it('stops with a server error and mails nothing when production has no web origin', async () => {
      const live = c.pick(
        await importWithEnv(
          c.specifier,
          { ...CONFIG, NODE_ENV: 'production', WEB_ORIGIN: ' ' },
          { shopSettings: SETTINGS },
        ),
      );
      const calls = stubFetch(() => textResponse('', 202));

      expect(await rejectedBy(() => live(mail(), log()))).toMatchObject({
        statusCode: 500,
        details: { reason: 'WEB_ORIGIN_REQUIRED' },
      });
      expect(calls).toHaveLength(0);
    });

    it('links to the live site from production when the web origin is set', async () => {
      const live = c.pick(
        await importWithEnv(
          c.specifier,
          { ...CONFIG, NODE_ENV: 'production' },
          { shopSettings: SETTINGS },
        ),
      );
      const calls = stubFetch(() => textResponse('', 202));

      await live(mail(), log());

      expect(sentText(calls[0]!.body)).toContain(`${CONFIG.WEB_ORIGIN}${c.linkPath}?token=tok-123`);
    });

    // a test without the setting still gets a link to the local frontend
    it('falls back to localhost in the tests', async () => {
      const local = c.pick(
        await importWithEnv(
          c.specifier,
          { ...CONFIG, NODE_ENV: 'test', WEB_ORIGIN: '' },
          { shopSettings: SETTINGS },
        ),
      );
      const calls = stubFetch(() => textResponse('', 202));

      await local(mail(), log());

      expect(sentText(calls[0]!.body)).toContain(
        `http://localhost:3000${c.linkPath}?token=tok-123`,
      );
    });
  });
}
