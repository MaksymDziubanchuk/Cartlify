import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { strictValidatorCompiler } from '@helpers/strictValidator.js';
import errorNormalizer from '@middlewares/errorNormalizer.js';
import { MAX_ID } from '@schemas/idPathParam.js';
import {
  NEWSLETTER_MAX_BLOCKS,
  NEWSLETTER_MAX_PRODUCTS,
  newslettersCampaignDtoSchemas,
} from '@schemas/dto/newslettersCampaign.dtoSchemas.js';

// a bare fastify instance with the schemas of the campaigns and the same ajv options as the app for
// everything but the bodies, which the routes of the campaigns check with the strict compiler: no
// type is turned into another, no field is taken away, so what is stored is what was sent
const app = fastify({ logger: false, ajv: { customOptions: { coerceTypes: true } } });
const strict = strictValidatorCompiler(newslettersCampaignDtoSchemas);

beforeAll(async () => {
  for (const schema of newslettersCampaignDtoSchemas) app.addSchema(schema);
  errorNormalizer(app);

  const echo = async (req: { body: unknown }) => ({ body: req.body });
  app.post(
    '/create',
    {
      validatorCompiler: strict,
      schema: { body: { $ref: 'newslettersCampaignCreateBodySchema#' } },
    },
    echo,
  );
  app.patch(
    '/update/:campaignId',
    {
      validatorCompiler: strict,
      schema: {
        params: { $ref: 'newslettersCampaignParamsSchema#' },
        body: { $ref: 'newslettersCampaignUpdateBodySchema#' },
      },
    },
    echo,
  );

  app.post(
    '/schedule',
    {
      validatorCompiler: strict,
      schema: { body: { $ref: 'newslettersCampaignScheduleBodySchema#' } },
    },
    echo,
  );

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

type Json = Record<string, unknown>;

const create = (body: unknown) =>
  app.inject({ method: 'POST', url: '/create', payload: body as Json });
const update = (body: unknown, id = '5') =>
  app.inject({ method: 'PATCH', url: `/update/${id}`, payload: body as Json });

const accepted = async (body: unknown) => {
  const res = await create(body);
  expect(res.statusCode).toBe(200);
  // the body reaches the route as it was sent
  expect(res.json().body).toEqual(body);
};

const refused = async (body: unknown) => {
  const res = await create(body);
  expect(res.statusCode).toBe(400);
  expect(res.json().errorCode).toBe('VALIDATION_ERROR');
};

const content = (over: Json = {}) => ({ subject: { en: 'Subject' }, blocks: [], ...over });
const withBlocks = (...blocks: unknown[]) => ({ name: 'Spring', content: content({ blocks }) });
const text = (over: Json = {}) => ({ type: 'text', text: { en: 'Hello' }, ...over });
const manual = (over: Json = {}) => ({
  type: 'products',
  source: 'manual',
  productIds: [1],
  ...over,
});
const rule = (over: Json = {}) => ({ type: 'products', source: 'rule', rule: 'new', ...over });
const category = (over: Json = {}) => ({ type: 'category', categoryId: 3, ...over });
const button = (over: Json = {}) => ({ type: 'button', kind: 'shop', url: '/', ...over });

describe('the body that makes a campaign', () => {
  it.each([
    ['only a name', { name: 'Spring sale' }],
    ['a name of one sign', { name: 'S' }],
    ['a name of the longest size', { name: 'S'.repeat(200) }],
    ['a name with spaces around', { name: '  Spring  ' }],
    ['the rule for a language without a text', { name: 'a', missingLocale: 'shop_locale' }],
    ['the other rule for it', { name: 'a', missingLocale: 'skip' }],
    ['a content with no blocks', { name: 'a', content: content() }],
    ['a content with no language at all', { name: 'a', content: { subject: {}, blocks: [] } }],
    ['a content with a preview', { name: 'a', content: content({ preview: { en: 'Preview' } }) }],
    ['a content with an empty preview', { name: 'a', content: content({ preview: { en: '' } }) }],
  ])('takes %s', async (_name, body) => {
    await accepted(body);
  });

  it.each([
    ['no name', {}],
    ['an empty name', { name: '' }],
    ['a name of spaces', { name: '   ' }],
    ['a name that is too long', { name: 'S'.repeat(201) }],
    ['a name with a new line', { name: 'a\nb' }],
    ['a name with a tab', { name: 'a\tb' }],
    ['a name with a line separator', { name: 'a\u2028b' }],
    ['a name that is a number', { name: 5 }],
    ['a name that is a list', { name: ['a'] }],
    ['a name that is null', { name: null }],
    ['a rule that is not one', { name: 'a', missingLocale: 'other' }],
    ['a rule in capitals', { name: 'a', missingLocale: 'SKIP' }],
    ['a rule that is null', { name: 'a', missingLocale: null }],
    ['a field that is not known', { name: 'a', status: 'sending' }],
    ['a content that is null', { name: 'a', content: null }],
    ['a content that is a list', { name: 'a', content: [] }],
    ['a content that is a text', { name: 'a', content: 'text' }],
  ])('refuses %s', async (_name, body) => {
    await refused(body);
  });
});

describe('the body that changes a campaign', () => {
  it.each([
    ['a name', { name: 'New' }],
    ['a rule', { missingLocale: 'skip' }],
    ['a content', { content: content() }],
    ['all three', { name: 'New', missingLocale: 'skip', content: content() }],
  ])('takes %s', async (_name, body) => {
    const res = await update(body);

    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual(body);
  });

  it.each([
    ['nothing', {}],
    ['a field that is not known', { status: 'sending' }],
    ['the time of the start', { scheduledAt: '2030-01-01T00:00:00Z' }],
    ['an empty name', { name: '' }],
    ['a content that is not whole', { content: {} }],
    ['a name that is a number', { name: 5 }],
  ])('refuses %s', async (_name, body) => {
    const res = await update(body);

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('VALIDATION_ERROR');
  });

  it.each(['0', '-1', '1.5', 'abc', '01', '1e3'])(
    'refuses %s as the id of a campaign',
    async (id) => {
      const res = await update({ name: 'a' }, id);

      expect(res.statusCode).toBe(400);
    },
  );
});

describe('the content of a campaign', () => {
  it('takes blocks up to the number that fits a mail and refuses one more', async () => {
    const block = text();
    await accepted(withBlocks(...Array.from({ length: 10 }, () => block)));
    await refused(withBlocks(...Array.from({ length: 11 }, () => block)));
  });

  it('knows the limits it names', () => {
    expect(NEWSLETTER_MAX_BLOCKS).toBe(10);
    expect(NEWSLETTER_MAX_PRODUCTS).toBe(12);
  });

  it.each([
    ['a subject of the longest size', content({ subject: { en: 'S'.repeat(150) } }), true],
    ['a subject that is too long', content({ subject: { en: 'S'.repeat(151) } }), false],
    ['a subject of one sign', content({ subject: { en: 'S' } }), true],
    ['an empty subject', content({ subject: { en: '' } }), false],
    ['a subject of spaces', content({ subject: { en: '   ' } }), false],
    ['a subject with a new line', content({ subject: { en: 'a\nb' } }), false],
    ['a subject with a carriage return', content({ subject: { en: 'a\rb' } }), false],
    ['a subject with a control sign', content({ subject: { en: 'a\u0007b' } }), false],
    ['a subject with an emoji', content({ subject: { en: '😀 Sale' } }), true],
    ['a subject that is a number', content({ subject: { en: 5 } }), false],
    ['a subject that is null', content({ subject: { en: null } }), false],
    ['a subject that is not a map', content({ subject: 'Subject' }), false],
    ['a subject that is a list', content({ subject: ['Subject'] }), false],
    ['no subject', { blocks: [] }, false],
    ['no blocks', { subject: { en: 'S' } }, false],
    ['blocks that are not a list', content({ blocks: {} }), false],
    ['a preview of the longest size', content({ preview: { en: 'P'.repeat(150) } }), true],
    ['a preview that is too long', content({ preview: { en: 'P'.repeat(151) } }), false],
    ['a preview with a new line', content({ preview: { en: 'a\nb' } }), false],
    ['a preview that is null', content({ preview: null }), false],
    ['a field that is not known', content({ footer: {} }), false],
    ['twenty languages', content({ subject: langs(20) }), true],
    ['twenty-one languages', content({ subject: langs(21) }), false],
    ['two languages', content({ subject: { en: 'S', uk: 'S' } }), true],
  ])('with %s', async (_name, value, ok) => {
    const body = { name: 'a', content: value };

    if (ok) await accepted(body);
    else await refused(body);
  });

  it('does not pick the languages: the keys are for the service to judge', async () => {
    await accepted({ name: 'a', content: content({ subject: { xx: 'S', EN: 'S', '': 'S' } }) });
  });
});

function langs(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`l${i}`, 'S']));
}

describe('a block of text', () => {
  it.each([
    ['a text', text()],
    ['a text in two languages', text({ text: { en: 'a', uk: 'b' } })],
    ['a text of the longest size', text({ text: { en: 'a'.repeat(5000) } })],
    ['a text with lines', text({ text: { en: 'a\n\nb\n- c\n# d' } })],
    ['a text with a tag', text({ text: { en: '<script>x</script>' } })],
    ['a text of no language yet', text({ text: {} })],
  ])('takes %s', async (_name, block) => {
    await accepted(withBlocks(block));
  });

  it.each([
    ['a text that is too long', text({ text: { en: 'a'.repeat(5001) } })],
    ['an empty text', text({ text: { en: '' } })],
    ['a text that is a number', text({ text: { en: 5 } })],
    ['a text that is not a map', text({ text: 'Hello' })],
    ['a text that is null', text({ text: null })],
    ['no text', { type: 'text' }],
    ['a field that is not known', text({ html: '<b>x</b>' })],
    ['a title', text({ title: { en: 'T' } })],
    ['a block that is not an object', 'text'],
    ['a block that is null', null],
    ['a block of a type that is not known', { type: 'banner', text: { en: 'x' } }],
    ['a block with no type', { text: { en: 'x' } }],
    ['a block with a type in capitals', text({ type: 'TEXT' })],
  ])('refuses %s', async (_name, block) => {
    await refused(withBlocks(block));
  });
});

describe('a block of products chosen by hand', () => {
  it.each([
    ['one product', manual()],
    ['the most products', manual({ productIds: Array.from({ length: 12 }, (_, i) => i + 1) })],
    ['the largest id', manual({ productIds: [MAX_ID] })],
    ['a title', manual({ title: { en: 'Picks' } })],
    ['a title of the longest size', manual({ title: { en: 'T'.repeat(120) } })],
  ])('takes %s', async (_name, block) => {
    await accepted(withBlocks(block));
  });

  it.each([
    ['no products', manual({ productIds: [] })],
    ['one product too many', manual({ productIds: Array.from({ length: 13 }, (_, i) => i + 1) })],
    ['no list', { type: 'products', source: 'manual' }],
    ['an id of zero', manual({ productIds: [0] })],
    ['a negative id', manual({ productIds: [-1] })],
    ['an id with a fraction', manual({ productIds: [1.5] })],
    ['an id that is a text', manual({ productIds: ['1'] })],
    ['an id that is null', manual({ productIds: [null] })],
    ['an id past the largest', manual({ productIds: [MAX_ID + 1] })],
    ['the same product twice', manual({ productIds: [4, 4] })],
    ['a list that is a number', manual({ productIds: 1 })],
    ['a rule', manual({ rule: 'new' })],
    ['a limit', manual({ limit: 4 })],
    ['a category', manual({ categoryId: 1 })],
    ['a period', manual({ periodDays: 7 })],
    ['a title that is too long', manual({ title: { en: 'T'.repeat(121) } })],
    ['an empty title', manual({ title: { en: '' } })],
    ['a title with a new line', manual({ title: { en: 'a\nb' } })],
    ['a title that is not a map', manual({ title: 'Picks' })],
    ['a source that is not known', manual({ source: 'auto' })],
  ])('refuses %s', async (_name, block) => {
    await refused(withBlocks(block));
  });
});

describe('a block of products taken by a rule', () => {
  it.each([
    ['new', rule()],
    ['on sale', rule({ rule: 'sale' })],
    ['popular', rule({ rule: 'popular' })],
    ['top rated', rule({ rule: 'top_rated' })],
    ['bestsellers', rule({ rule: 'bestsellers' })],
    ['bestsellers of a week', rule({ rule: 'bestsellers', periodDays: 7 })],
    ['bestsellers of a month', rule({ rule: 'bestsellers', periodDays: 30 })],
    ['bestsellers of a quarter', rule({ rule: 'bestsellers', periodDays: 90 })],
    ['the least products', rule({ limit: 1 })],
    ['the most products', rule({ limit: 12 })],
    ['a category', rule({ categoryId: 5 })],
    ['the largest category id', rule({ categoryId: MAX_ID })],
    ['a title', rule({ title: { en: 'New' } })],
    [
      'everything at once',
      rule({ rule: 'bestsellers', periodDays: 90, limit: 6, categoryId: 2, title: { en: 'Best' } }),
    ],
  ])('takes %s', async (_name, block) => {
    await accepted(withBlocks(block));
  });

  it.each([
    ['no rule', { type: 'products', source: 'rule' }],
    ['a rule that is not known', rule({ rule: 'random' })],
    ['a rule in capitals', rule({ rule: 'NEW' })],
    ['a rule that is null', rule({ rule: null })],
    ['a limit of zero', rule({ limit: 0 })],
    ['a limit past the most', rule({ limit: 13 })],
    ['a limit with a fraction', rule({ limit: 2.5 })],
    ['a limit that is a text', rule({ limit: '4' })],
    ['a category of zero', rule({ categoryId: 0 })],
    ['a category with a fraction', rule({ categoryId: 1.5 })],
    ['a category that is a text', rule({ categoryId: '2' })],
    ['a category past the largest id', rule({ categoryId: MAX_ID + 1 })],
    ['a period for new', rule({ periodDays: 7 })],
    ['a period for sale', rule({ rule: 'sale', periodDays: 30 })],
    ['a period for popular', rule({ rule: 'popular', periodDays: 30 })],
    ['a period for top rated', rule({ rule: 'top_rated', periodDays: 90 })],
    ['a period that is not one', rule({ rule: 'bestsellers', periodDays: 14 })],
    ['a period of zero', rule({ rule: 'bestsellers', periodDays: 0 })],
    ['a period that is a text', rule({ rule: 'bestsellers', periodDays: '7' })],
    ['a list of products', rule({ productIds: [1] })],
    ['a title that is too long', rule({ title: { en: 'T'.repeat(121) } })],
    ['a field that is not known', rule({ order: 'asc' })],
  ])('refuses %s', async (_name, block) => {
    await refused(withBlocks(block));
  });
});

describe('a block of a category', () => {
  it.each([
    ['a category', category()],
    ['the largest id', category({ categoryId: MAX_ID })],
    ['a title', category({ title: { en: 'Shoes' } })],
    ['a title of the longest size', category({ title: { en: 'T'.repeat(120) } })],
  ])('takes %s', async (_name, block) => {
    await accepted(withBlocks(block));
  });

  it.each([
    ['no category', { type: 'category' }],
    ['a category of zero', category({ categoryId: 0 })],
    ['a negative category', category({ categoryId: -2 })],
    ['a category with a fraction', category({ categoryId: 1.5 })],
    ['a category that is a text', category({ categoryId: '3' })],
    ['a category that is null', category({ categoryId: null })],
    ['a category past the largest id', category({ categoryId: MAX_ID + 1 })],
    ['a title that is too long', category({ title: { en: 'T'.repeat(121) } })],
    ['an empty title', category({ title: { en: '' } })],
    ['a field that is not known', category({ limit: 4 })],
  ])('refuses %s', async (_name, block) => {
    await refused(withBlocks(block));
  });
});

describe('a block of a button', () => {
  it.each(['shop', 'sale', 'new', 'category', 'product'])('takes the kind %s', async (kind) => {
    await accepted(withBlocks(button({ kind })));
  });

  it.each([
    ['a path', button({ url: '/sale' })],
    ['an address', button({ url: 'https://shop.example.com/sale' })],
    ['an address of the longest size', button({ url: `/${'a'.repeat(1999)}` })],
  ])('takes %s', async (_name, block) => {
    await accepted(withBlocks(block));
  });

  it.each([
    ['a kind that is not known', button({ kind: 'link' })],
    ['a kind in capitals', button({ kind: 'SHOP' })],
    ['no kind', { type: 'button', url: '/' }],
    ['no address', { type: 'button', kind: 'shop' }],
    ['an empty address', button({ url: '' })],
    ['an address that is too long', button({ url: `/${'a'.repeat(2000)}` })],
    ['an address that is a number', button({ url: 5 })],
    ['an address that is null', button({ url: null })],
    ['a label', button({ label: { en: 'Go' } })],
    ['a label that is free text', button({ label: 'Go' })],
  ])('refuses %s', async (_name, block) => {
    await refused(withBlocks(block));
  });
});

describe('the blocks in an order', () => {
  it('takes every kind of block, in any order', async () => {
    await accepted(
      withBlocks(
        button(),
        manual(),
        text(),
        rule({ rule: 'bestsellers', periodDays: 30 }),
        category(),
        text({ text: { en: 'b' } }),
      ),
    );
  });

  it('names the place of a wrong field in the answer', async () => {
    const res = await create(withBlocks(text(), manual({ productIds: [0] })));
    const details = JSON.stringify(res.json().details);

    expect(res.statusCode).toBe(400);
    expect(details).toContain('content.blocks.1');
  });
});

// the body that schedules a campaign: a time, or "now", and nothing besides; the time itself is
// judged by the service (the shop's own reading of an ISO 8601 text)
describe('the body that schedules a campaign', () => {
  const schedule = (body: unknown) =>
    app.inject({ method: 'POST', url: '/schedule', payload: body as Json });

  it.each([
    [{ scheduledAt: '2095-07-01T10:00' }],
    [{ scheduledAt: '2095-07-01T10:00:00Z' }],
    [{ scheduledAt: '2095-07-01T12:00:00+02:00' }],
    [{ runNow: true }],
  ])('takes %j as it is', async (body) => {
    const res = await schedule(body);

    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual(body);
  });

  it.each([
    ['nothing', {}],
    ['both a time and now', { scheduledAt: '2095-07-01T10:00', runNow: true }],
    ['now as false', { runNow: false }],
    ['now as the text "true"', { runNow: 'true' }],
    ['now as 1', { runNow: 1 }],
    ['now as null', { runNow: null }],
    ['a time that is not text', { scheduledAt: 20950701 }],
    ['a time that is null', { scheduledAt: null }],
    ['an empty time', { scheduledAt: '' }],
    ['a time over 40 characters', { scheduledAt: '2095-07-01T10:00:00.000000000+02:00 and more' }],
    ['another field with a time', { scheduledAt: '2095-07-01T10:00', name: 'x' }],
    ['another field with now', { runNow: true, extra: 1 }],
    ['a field it does not know', { when: '2095-07-01T10:00' }],
  ])('refuses %s', async (_case, body) => {
    const res = await schedule(body);

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('VALIDATION_ERROR');
  });

  it('refuses a body that is not an object', async () => {
    for (const payload of ['"2095-07-01T10:00"', '[]', 'true', 'null']) {
      const res = await app.inject({
        method: 'POST',
        url: '/schedule',
        headers: { 'content-type': 'application/json' },
        payload,
      });

      expect(res.statusCode).toBe(400);
    }
  });
});
