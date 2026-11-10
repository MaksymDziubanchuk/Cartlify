import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  campaignApi,
  campaignLinesOf,
  campaignRowOf,
  draftOf,
  forgetCampaigns,
  moveTo,
  type CampaignApi,
} from '../../../helpers/newsletterCampaigns.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';

// A campaign with a text in a language root turned off since: the text stays, it only does not go out
// (nobody has the language any more), and the answer says which languages those are
// (`disabledLocales`, the languages the campaign has a subject in that the shop does not answer in).
// The text of such a language can be kept and edited, but a new one cannot be written: a PATCH takes
// the languages the shop answers in and the ones the stored campaign already has. The languages of the
// shop here are the memory of the server of this file (setShopSettings), the rows are not touched, so
// the file does not wait for the others; what turning a language off does to the people is
// api/shopSettings/localeReset.shopwide.test.ts and the scheduling of such a campaign is in
// campaignsSchedule.shopwide.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let api: CampaignApi;
const made: number[] = [];

const ALL = ['en', 'es', 'uk'];

const content = (subject: Record<string, string>, text: Record<string, string>) => ({
  subject,
  preview: {},
  blocks: [{ type: 'text', text }],
});

// a campaign with a text in three languages
const threeLanguages = () =>
  content(
    { en: 'Spring', es: 'Primavera', uk: 'Весна' },
    { en: 'Hello', es: 'Hola', uk: 'Привіт' },
  );

const draft = async (over: Record<string, unknown> = {}) => {
  const id = await draftOf(api, staff.manager, over);
  made.push(id);
  return id;
};

const turnOff = (...locales: string[]) =>
  setShopSettings({ enabledLocales: ALL.filter((code) => !locales.includes(code)) });

const disabledOf = (res: LightMyRequestResponse) => res.json().disabledLocales as string[];

// a campaign in the list, found by paging from the newest: other files make campaigns too
async function inList(id: number): Promise<Record<string, unknown> | undefined> {
  let cursor: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const res: LightMyRequestResponse = await api.list(
      staff.manager,
      `limit=100${cursor ? `&cursor=${cursor}` : ''}`,
    );
    expect(res.statusCode).toBe(200);

    const found = (res.json().items as Array<Record<string, unknown>>).find((row) => row.id === id);
    if (found) return found;

    cursor = res.json().nextCursor as string | null;
    if (!cursor) return undefined;
  }

  return undefined;
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
  api = campaignApi(app, csrf);
});

afterEach(() => {
  resetShopSettings();
});

afterAll(async () => {
  try {
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

describe('what the answer says of the languages that are off', () => {
  it('names none while the shop answers in every language the campaign has', async () => {
    const id = await draft({ content: threeLanguages() });

    const res = await api.get(staff.manager, id);

    expect(res.statusCode).toBe(200);
    expect(disabledOf(res)).toEqual([]);
  });

  it('names the languages of the campaign that the shop has turned off, in the order of their codes', async () => {
    const id = await draft({ content: threeLanguages() });
    turnOff('uk', 'es');

    const res = await api.get(staff.manager, id);

    expect(res.statusCode).toBe(200);
    expect(disabledOf(res)).toEqual(['es', 'uk']);
    // the text is still there, in every language it was written
    expect(res.json().content).toEqual({ ...threeLanguages(), preview: {} });
  });

  it('names a language only when the campaign has a subject in it', async () => {
    const id = await draft({ content: content({ en: 'Spring' }, { en: 'Hello' }) });
    turnOff('uk');

    expect(disabledOf(await api.get(staff.manager, id))).toEqual([]);
  });

  it('is in every answer that carries a campaign, as the shop has the languages at the moment of it', async () => {
    const id = await draft({ content: threeLanguages() });
    turnOff('uk');

    const renamed = await api.update(staff.manager, id, { name: 'Renamed' });
    const copy = await api.copy(staff.manager, id);
    if (copy.statusCode === 201) made.push(copy.json().id as number);

    expect(renamed.statusCode).toBe(200);
    expect(disabledOf(renamed)).toEqual(['uk']);
    expect(copy.statusCode).toBe(201);
    expect(disabledOf(copy)).toEqual(['uk']);
    expect(copy.json().content).toEqual({ ...threeLanguages(), preview: {} });
  });

  it('is on each row of the list', async () => {
    const withUk = await draft({ content: threeLanguages() });
    const english = await draft({ content: content({ en: 'Spring' }, { en: 'Hello' }) });
    const empty = await draft();
    turnOff('uk');

    expect((await inList(withUk))?.disabledLocales).toEqual(['uk']);
    expect((await inList(english))?.disabledLocales).toEqual([]);
    expect((await inList(empty))?.disabledLocales).toEqual([]);

    // and it follows the languages: turned on again, the campaign has none that are off
    resetShopSettings();
    expect((await inList(withUk))?.disabledLocales).toEqual([]);
  });

  it('is empty for a campaign that was made without a content', async () => {
    const id = await draft();

    expect(disabledOf(await api.get(staff.manager, id))).toEqual([]);
  });
});

describe('PATCH of a campaign that has a text in a language that is off', () => {
  it('changes the name and leaves the text of that language as it is', async () => {
    const id = await draft({ content: threeLanguages() });
    turnOff('uk');

    const res = await api.update(staff.manager, id, { name: 'Only the name' });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Only the name');
    expect((await campaignRowOf(id))?.content).toEqual({ ...threeLanguages(), preview: {} });
  });

  it('takes the content back as the form sends it, the text of that language in it', async () => {
    const id = await draft({ content: threeLanguages() });
    turnOff('uk');

    const res = await api.update(staff.manager, id, {
      name: 'Form',
      content: { ...threeLanguages(), subject: { ...threeLanguages().subject, en: 'Spring 2' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().content.subject).toEqual({ en: 'Spring 2', es: 'Primavera', uk: 'Весна' });
    expect(disabledOf(res)).toEqual(['uk']);
  });

  it('lets the text of that language be edited, ready for the day the language is turned on', async () => {
    const id = await draft({ content: threeLanguages() });
    turnOff('uk');

    const res = await api.update(staff.manager, id, {
      content: content(
        { en: 'Spring', es: 'Primavera', uk: 'Весна' },
        { en: 'Hello', es: 'Hola', uk: 'Вітаємо' },
      ),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().content.blocks[0].text.uk).toBe('Вітаємо');
  });

  it('lets the language be taken out of the campaign', async () => {
    const id = await draft({ content: threeLanguages() });
    turnOff('uk');

    const res = await api.update(staff.manager, id, {
      content: content({ en: 'Spring', es: 'Primavera' }, { en: 'Hello', es: 'Hola' }),
    });

    expect(res.statusCode).toBe(200);
    expect(disabledOf(res)).toEqual([]);
    expect(res.json().content.subject).toEqual({ en: 'Spring', es: 'Primavera' });
  });

  it('refuses a new text in a language that is off: the campaign had no subject in it', async () => {
    const id = await draft({ content: content({ en: 'Spring' }, { en: 'Hello' }) });
    turnOff('uk');
    const before = (await campaignRowOf(id))?.content;

    const res = await api.update(staff.manager, id, {
      content: content({ en: 'Spring', uk: 'Весна' }, { en: 'Hello', uk: 'Привіт' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'LOCALE_INVALID',
      details: { field: 'content.subject.uk', locale: 'uk' },
    });
    expect((await campaignRowOf(id))?.content).toEqual(before);
  });

  it('refuses a new language that is off while it keeps the one that is off and was there', async () => {
    const id = await draft({ content: threeLanguages() });
    turnOff('uk', 'es');

    // "es" is off and was in the campaign, so it stays; the campaign never had "xx"
    const kept = await api.update(staff.manager, id, { content: threeLanguages() });
    expect(kept.statusCode).toBe(200);

    // take "es" out, then it cannot come back while it is off
    const taken = await api.update(staff.manager, id, {
      content: content({ en: 'Spring', uk: 'Весна' }, { en: 'Hello', uk: 'Привіт' }),
    });
    expect(taken.statusCode).toBe(200);
    const back = await api.update(staff.manager, id, { content: threeLanguages() });
    expect(back.statusCode).toBe(400);
    expect(back.json()).toMatchObject({ errorCode: 'LOCALE_INVALID', details: { locale: 'es' } });
  });

  it('refuses a text of a language that is off in a place the campaign had no subject for', async () => {
    const id = await draft({ content: threeLanguages() });
    turnOff('uk');

    // the subject of "uk" is dropped but its text stays: a text needs the subject of its language
    const res = await api.update(staff.manager, id, {
      content: content(
        { en: 'Spring', es: 'Primavera' },
        { en: 'Hello', es: 'Hola', uk: 'Привіт' },
      ),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'NEWSLETTER_LOCALE_WITHOUT_SUBJECT',
      details: { locale: 'uk' },
    });
  });

  it('does not keep a language that has no dictionary, off or never on', async () => {
    const id = await draft({ content: content({ en: 'Spring' }, { en: 'Hello' }) });
    // a language put into the row by hand: no dictionary has it
    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ROOT', userId: staff.root.id });
        await db.rows(
          `update cartlify.newsletter_campaigns
           set content = jsonb_set(content, '{subject,xx}', '"Xx"'), "updatedById" = $2::int
           where id = $1`,
          id,
          staff.root.id,
        );
      },
      { commit: true },
    );

    const res = await api.update(staff.manager, id, {
      content: content({ en: 'Spring', xx: 'Xx' }, { en: 'Hello' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'LOCALE_INVALID', details: { locale: 'xx' } });
  });

  it('answers a content it refuses before the state of a campaign that cannot be changed', async () => {
    const id = await draft({ content: content({ en: 'Spring' }, { en: 'Hello' }) });
    await moveTo(staff.manager, id, 'cancelled');
    turnOff('uk');

    const refused = await api.update(staff.manager, id, {
      content: content({ en: 'Spring', uk: 'Весна' }, { en: 'Hello' }),
    });
    const fine = await api.update(staff.manager, id, { name: 'Late' });

    expect(refused.statusCode).toBe(400);
    expect(refused.json().errorCode).toBe('LOCALE_INVALID');
    expect(fine.statusCode).toBe(409);
    expect(fine.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_EDITABLE');
  });

  it('keeps the text of a language that is off in a campaign that cannot be changed, and says so', async () => {
    const id = await draft({ content: threeLanguages() });
    await moveTo(staff.manager, id, 'cancelled');
    turnOff('uk');

    const res = await api.get(staff.manager, id);

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
    expect(disabledOf(res)).toEqual(['uk']);
  });

  it('answers a campaign that is not there with the content refusal first, as it always did', async () => {
    turnOff('uk');

    const refused = await api.update(staff.manager, 2_147_483_647, {
      content: content({ en: 'Spring', uk: 'Весна' }, { en: 'Hello' }),
    });
    const absent = await api.update(staff.manager, 2_147_483_647, { name: 'Nobody' });

    expect(refused.statusCode).toBe(400);
    expect(refused.json().errorCode).toBe('LOCALE_INVALID');
    expect(absent.statusCode).toBe(404);
  });

  it('writes the usual line, and none for a request that changes nothing', async () => {
    const id = await draft({ content: threeLanguages() });
    turnOff('uk');
    const before = (await campaignLinesOf(id)).length;

    const same = await api.update(staff.manager, id, { content: threeLanguages() });

    expect(same.statusCode).toBe(200);
    expect(await campaignLinesOf(id)).toHaveLength(before);

    const changed = await api.update(staff.manager, id, { name: 'Another name' });

    expect(changed.statusCode).toBe(200);
    expect(await campaignLinesOf(id)).toHaveLength(before + 1);
  });
});

describe('POST of a campaign', () => {
  it('still refuses a text in a language that is off: there is nothing stored to keep', async () => {
    turnOff('uk');

    const res = await api.create(staff.manager, {
      name: 'New',
      content: content({ en: 'Spring', uk: 'Весна' }, { en: 'Hello', uk: 'Привіт' }),
    });
    if (res.statusCode === 201) made.push(res.json().id as number);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'LOCALE_INVALID', details: { locale: 'uk' } });
  });
});

describe('the preview and the test mail', () => {
  // they show the mail in a language of the shop: one that is off has no subscribers to be sent to
  it('are refused in a language that is off', async () => {
    const id = await draft({ content: threeLanguages() });
    turnOff('uk');

    const preview = await api.preview(staff.manager, id, { locale: 'uk' });
    const test = await api.testMail(staff.manager, id, {
      email: staff.manager.email,
      locale: 'uk',
    });

    expect(preview.statusCode).toBe(400);
    expect(preview.json().errorCode).toBe('LOCALE_INVALID');
    expect(test.statusCode).toBe(400);
    expect(test.json().errorCode).toBe('LOCALE_INVALID');
  });
});

// The drafts of the file go in a test, not in afterAll: the lock of the shop (tests/setup/
// integration.shopState.ts) is let go before the afterAll of a file, and the file that counts every
// campaign of the shop would meet drafts that vanish while it pages through them
describe('the end of the file', () => {
  it('removes the drafts it made', async () => {
    await forgetCampaigns(api, staff.manager, made);

    for (const id of made) {
      const row = await campaignRowOf(id);
      expect(row === null || row.status !== 'draft').toBe(true);
    }
  });
});
