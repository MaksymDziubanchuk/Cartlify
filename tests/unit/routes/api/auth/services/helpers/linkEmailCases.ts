import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { rejectedBy } from '../../../../../../helpers/errors.js';
import { jsonResponse, stubFetch, textResponse } from '../../../../../../helpers/fetchStub.js';
import { importWithEnv } from '../../../../../../helpers/freshImport.js';

// the verify and the reset mails differ only in the page the link opens and in the error
// code, so both test files run these cases

type SendLinkEmail = (args: {
  to: string;
  token: string;
  expiresAt: Date;
}) => Promise<{ status: number }>;

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
  EMAIL_FROM_NAME: 'Cartlify',
  EMAIL_REPLY_TO: 'help@cartlify.test',
  WEB_ORIGIN: 'https://shop.example.com',
};

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const logo = readFileSync(path.join(process.cwd(), 'src', 'static', 'images', 'logo3.png'));

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
      send = c.pick(await importWithEnv(c.specifier, CONFIG));
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

      expect(await send(mail())).toEqual({ status: 202 });
      expect(JSON.parse(calls[0]!.body).personalizations[0].to).toEqual([
        { email: 'buyer@cartlify.test' },
      ]);
      expect(sentText(calls[0]!.body)).toContain(`${CONFIG.WEB_ORIGIN}${c.linkPath}?token=tok-123`);
    });

    it('encodes a token with url characters so the link stays whole', async () => {
      const calls = stubFetch(() => textResponse('', 202));

      await send(mail(HOUR, 'a+b/c=&d'));

      expect(sentText(calls[0]!.body)).toContain(`${c.linkPath}?token=a%2Bb%2Fc%3D%26d`);
    });

    it('attaches the logo inline under the id the html refers to', async () => {
      const calls = stubFetch(() => textResponse('', 202));

      await send(mail());

      const payload = JSON.parse(calls[0]!.body);
      expect(payload.attachments).toEqual([
        {
          content: logo.toString('base64'),
          type: 'image/png',
          filename: 'logo3.png',
          disposition: 'inline',
          content_id: 'cartlify-logo',
        },
      ]);
      expect(payload.content[1].value).toContain('cid:cartlify-logo');
    });

    it.each([
      ['15 minutes', 15 * MINUTE],
      ['24 hours', 24 * HOUR],
      ['3 days', 3 * DAY],
    ])('says the link is valid for %s', async (text, validFor) => {
      const calls = stubFetch(() => textResponse('', 202));

      await send(mail(validFor));

      expect(sentText(calls[0]!.body)).toContain(`This link is valid for ${text}.`);
    });

    it.each([
      ['1 minute', MINUTE],
      ['1 hour', HOUR],
    ])('uses the singular: %s', async (text, validFor) => {
      const calls = stubFetch(() => textResponse('', 202));

      await send(mail(validFor));

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

      await send(mail(validFor));

      expect(statedValidity(sentText(calls[0]!.body))).toBeLessThanOrEqual(validFor);
    });

    it('hides what the provider said behind a bad gateway error', async () => {
      stubFetch(() => jsonResponse({ errors: [{ message: 'internal provider detail' }] }, 500));

      const err = await rejectedBy(() => send(mail()));

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
        await importWithEnv(c.specifier, { ...CONFIG, SENDGRID_API_KEY: '' }),
      );
      stubFetch(() => textResponse('', 202));

      expect(await rejectedBy(() => unconfigured(mail()))).toMatchObject({
        statusCode: 500,
        details: { reason: 'SENDGRID_API_KEY_REQUIRED' },
      });
    });

    it('reports an empty address of the customer as a server error', async () => {
      stubFetch(() => textResponse('', 202));

      expect(await rejectedBy(() => send({ ...mail(), to: ' ' }))).toMatchObject({
        statusCode: 500,
        details: { reason: 'EMAIL_TO_REQUIRED' },
      });
    });

    it('turns a network failure of the provider into a bad gateway too', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

      expect(await rejectedBy(() => send(mail()))).toMatchObject({
        statusCode: 502,
        errorCode: c.failureCode,
      });
    });

    // a link to localhost in a mail from the live shop opens nothing for the customer
    it('never mails a localhost link from production', async () => {
      const live = c.pick(
        await importWithEnv(c.specifier, { ...CONFIG, NODE_ENV: 'production', WEB_ORIGIN: '' }),
      );
      const calls = stubFetch(() => textResponse('', 202));

      await live(mail()).catch(() => undefined);

      expect(calls.map((call) => sentText(call.body)).join('\n')).not.toContain('localhost');
    });

    it('stops with a server error and mails nothing when production has no web origin', async () => {
      const live = c.pick(
        await importWithEnv(c.specifier, { ...CONFIG, NODE_ENV: 'production', WEB_ORIGIN: ' ' }),
      );
      const calls = stubFetch(() => textResponse('', 202));

      expect(await rejectedBy(() => live(mail()))).toMatchObject({
        statusCode: 500,
        details: { reason: 'WEB_ORIGIN_REQUIRED' },
      });
      expect(calls).toHaveLength(0);
    });

    it('links to the live site from production when the web origin is set', async () => {
      const live = c.pick(await importWithEnv(c.specifier, { ...CONFIG, NODE_ENV: 'production' }));
      const calls = stubFetch(() => textResponse('', 202));

      await live(mail());

      expect(sentText(calls[0]!.body)).toContain(`${CONFIG.WEB_ORIGIN}${c.linkPath}?token=tok-123`);
    });

    // a developer without the setting still gets a link to the local frontend
    it('falls back to localhost outside production', async () => {
      const local = c.pick(
        await importWithEnv(c.specifier, { ...CONFIG, NODE_ENV: 'development', WEB_ORIGIN: '' }),
      );
      const calls = stubFetch(() => textResponse('', 202));

      await local(mail());

      expect(sentText(calls[0]!.body)).toContain(
        `http://localhost:3000${c.linkPath}?token=tok-123`,
      );
    });
  });
}
