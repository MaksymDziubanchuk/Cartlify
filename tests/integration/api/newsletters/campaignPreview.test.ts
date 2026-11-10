import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { dictionaryText } from '../../../helpers/dictionary.js';
import {
  createCategory,
  createProduct,
  deleteProductFromCatalog,
  type TestProduct,
} from '../../../helpers/factories.js';
import { watchNewsletterMail } from '../../../helpers/mail.js';
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

// POST /api/newsletters/campaigns/:campaignId/preview: the mail of a campaign as a reader of the language
// asked would get it, with the products taken from the catalog now and the warnings of what is wrong or
// left out. The links of the subscription lead to the home page of the shop. Nothing is sent, nothing is
// written; any state of a campaign can be looked at

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let api: CampaignApi;
const made: number[] = [];
const products: TestProduct[] = [];

const SHOP = 'https://shop.example.com';
const LOGO = 'https://res.cloudinary.com/cartlify-test/image/upload/v1/test/shop/logo/preview.png';

async function newProduct(opts: Parameters<typeof createProduct>[0] = {}) {
  const product = await createProduct({ price: 25, stock: 10, ...opts });
  products.push(product);
  return product;
}

// the content of a campaign with a block of every kind, in two languages
const contentWith = (productIds: number[], categoryId: number) => ({
  subject: { en: 'Spring sale', es: 'Rebajas de primavera' },
  preview: { en: 'Up to 30% off', es: 'Hasta un 30% de descuento' },
  blocks: [
    {
      type: 'text',
      text: { en: '# Hello\nThe **best** prices', es: '# Hola\nLos **mejores** precios' },
    },
    {
      type: 'products',
      title: { en: 'Our picks', es: 'Nuestra selección' },
      source: 'manual',
      productIds,
    },
    { type: 'category', categoryId, title: { en: 'Shoes', es: 'Zapatos' } },
    { type: 'button', kind: 'sale', url: '/sale' },
  ],
});

async function campaignOf(content: unknown): Promise<number> {
  const id = await draftOf(api, staff.manager, { content });
  made.push(id);
  return id;
}

const preview = (id: number, locale: unknown = 'en', user = staff.manager) =>
  api.preview(user, id, { locale });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
  api = campaignApi(app, csrf);
});

afterAll(async () => {
  try {
    await forgetCampaigns(api, staff.manager, made);
    for (const product of products) await deleteProductFromCatalog(product.id);
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

afterEach(() => resetShopSettings());

describe('POST /api/newsletters/campaigns/:campaignId/preview', () => {
  let shirt: TestProduct;
  let shoes: { id: number; name: string };
  let id: number;

  beforeAll(async () => {
    shirt = await newProduct({ name: 'Preview shirt', price: 19.9 });
    shoes = await createCategory({ name: 'Preview shoes' });
    id = await campaignOf(contentWith([shirt.id], shoes.id));
  });

  it('gives the mail: the subject, the preview line, the html and the text, with what the shop sells', async () => {
    const before = Date.now();
    const res = await preview(id);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual([
      'html',
      'preheader',
      'subject',
      'takenAt',
      'text',
      'warnings',
    ]);
    expect(body).toMatchObject({
      subject: 'Spring sale',
      preheader: 'Up to 30% off',
      warnings: [],
    });
    expect(Math.abs(new Date(body.takenAt).getTime() - before)).toBeLessThan(10_000);

    for (const part of [body.html as string, body.text as string]) {
      expect(part).toContain('Preview shirt');
      expect(part).toContain('Preview shoes');
      expect(part).toContain('Our picks');
      expect(part).toContain('Shoes');
    }
    expect(body.text).toContain(
      `${SHOP}/products/${shirt.id}?utm_source=newsletter&utm_campaign=${id}`,
    );
    expect(body.text).toContain(
      `${SHOP}/categories/${shoes.id}?utm_source=newsletter&utm_campaign=${id}`,
    );
    expect(body.text).toContain(`${SHOP}/sale?utm_source=newsletter&utm_campaign=${id}`);
    expect(body.html).toContain('lang="en"');
  });

  it('writes the mail in the language asked: the subject, the texts and the foot', async () => {
    const res = await preview(id, 'es');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      subject: 'Rebajas de primavera',
      preheader: 'Hasta un 30% de descuento',
    });
    expect(res.json().html).toContain('lang="es"');
    expect(res.json().html).toContain('Nuestra selección');
    expect(res.json().text).toContain('Los mejores precios');
    expect(res.json().text).toContain(dictionaryText('es', 'campaignMail.manage'));
    expect(res.json().text).not.toContain(dictionaryText('en', 'campaignMail.manage'));
  });

  it.each(['ES', ' es ', 'es-ES'])(
    'takes the language %j as the shop writes it, case and region left aside',
    async (spelling) => {
      const res = await preview(id, spelling);

      expect(res.statusCode).toBe(200);
      expect(res.json().subject).toBe('Rebajas de primavera');
    },
  );

  // a preview looks at the mail, it does not use a subscription: the links of the subscription lead to
  // the shop, where a person who pressed one would land on the home page
  it('leads the links of the subscription to the home page of the shop', async () => {
    const res = await preview(id);
    const html = res.json().html as string;
    const manage = dictionaryText('en', 'campaignMail.manage');

    expect(html).toMatch(new RegExp(`<a [^>]*href="${SHOP}/"[^>]*>\\s*${manage}\\s*</a>`));
    expect(html).not.toContain('/newsletter/manage');
    expect(html).not.toContain('/api/newsletters/unsubscribe');
    expect(res.json().text).toContain(`${manage}: ${SHOP}/`);
  });

  it('takes the products from the catalog at the moment of the request', async () => {
    const lamp = await newProduct({ name: 'Short-lived lamp' });
    const lampCampaign = await campaignOf(contentWith([lamp.id], shoes.id));

    const first = await preview(lampCampaign);
    expect(first.json().html).toContain('Short-lived lamp');
    expect(first.json().warnings).toEqual([]);

    await deleteProductFromCatalog(lamp.id);
    const second = await preview(lampCampaign);

    expect(second.json().html).not.toContain('Short-lived lamp');
    expect(second.json().warnings).toEqual(
      expect.arrayContaining([
        { blockIndex: 1, code: 'PRODUCT_UNAVAILABLE', productId: lamp.id },
        { blockIndex: 1, code: 'BLOCK_EMPTY' },
      ]),
    );
    expect(new Date(second.json().takenAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.json().takenAt).getTime(),
    );
  });

  describe('the warnings', () => {
    it('tells of a product that was left out, and still shows the others', async () => {
      const kept = await newProduct({ name: 'Kept shirt' });
      const gone = await newProduct({ name: 'Gone shirt' });
      const out = await newProduct({ name: 'Empty shelf', stock: 0 });
      await deleteProductFromCatalog(gone.id);
      const campaign = await campaignOf(contentWith([kept.id, gone.id, out.id], shoes.id));

      const res = await preview(campaign);

      expect(res.json().warnings).toEqual([
        { blockIndex: 1, code: 'PRODUCT_UNAVAILABLE', productId: gone.id },
        { blockIndex: 1, code: 'PRODUCT_UNAVAILABLE', productId: out.id },
      ]);
      expect(res.json().html).toContain('Kept shirt');
      expect(res.json().html).not.toContain('Gone shirt');
      expect(res.json().html).not.toContain('Empty shelf');
    });

    it('tells of a block of a category that is gone and leaves the block out', async () => {
      const vanished = await createCategory({ name: 'Vanishing category' });
      const campaign = await campaignOf(contentWith([shirt.id], vanished.id));
      await asAdmin((tx) => tx.category.delete({ where: { id: vanished.id } }));

      const res = await preview(campaign);

      expect(res.statusCode).toBe(200);
      expect(res.json().warnings).toEqual([{ blockIndex: 2, code: 'CATEGORY_MISSING' }]);
      expect(res.json().html).not.toContain('Vanishing category');
      expect(res.json().html).toContain('Preview shirt');
    });

    it('tells of a rule whose category is gone', async () => {
      const vanished = await createCategory();
      const campaign = await campaignOf({
        subject: { en: 'S' },
        blocks: [{ type: 'products', source: 'rule', rule: 'popular', categoryId: vanished.id }],
      });
      await asAdmin((tx) => tx.category.delete({ where: { id: vanished.id } }));

      const res = await preview(campaign);

      expect(res.json().warnings).toEqual([
        { blockIndex: 0, code: 'CATEGORY_MISSING' },
        { blockIndex: null, code: 'MAIL_EMPTY' },
      ]);
    });

    it('tells of a text that has no words in the language asked', async () => {
      const campaign = await campaignOf({
        subject: { en: 'S', es: 'Asunto' },
        blocks: [
          { type: 'text', text: { en: 'Only English' } },
          { type: 'text', text: { en: 'Hi', es: 'Hola' } },
        ],
      });

      const res = await preview(campaign, 'es');

      expect(res.json().warnings).toEqual([{ blockIndex: 0, code: 'TEXT_MISSING' }]);
      expect(res.json().text).toContain('Hola');
      expect(res.json().text).not.toContain('Only English');
    });

    it('tells the mail is empty when no block is left', async () => {
      const campaign = await campaignOf({ subject: { en: 'Nothing' }, blocks: [] });

      const res = await preview(campaign);

      expect(res.statusCode).toBe(200);
      expect(res.json().warnings).toEqual([{ blockIndex: null, code: 'MAIL_EMPTY' }]);
      expect(res.json().html).toContain(dictionaryText('en', 'campaignMail.manage'));
    });

    // the content is checked when it is written; the address of the shop may be another one now. The
    // way to have a link saved that the shop no longer owns is a content written behind the check
    it('tells of a link that does not lead to the shop any more, and leaves it out', async () => {
      const campaign = await campaignOf({
        subject: { en: 'S' },
        blocks: [
          { type: 'text', text: { en: 'See [the old shop](/old) now' } },
          { type: 'button', kind: 'shop', url: '/new' },
        ],
      });
      await inOwnerTx(
        async (db) => {
          await db.as({ role: 'ADMIN', userId: staff.manager.id });
          await db.rows(
            `update cartlify.newsletter_campaigns set content = $2::jsonb, "updatedById" = $3::int where id = $1`,
            campaign,
            JSON.stringify({
              subject: { en: 'S' },
              preview: {},
              blocks: [
                {
                  type: 'text',
                  text: { en: 'See [the old shop](https://old-shop.example.org/old) now' },
                },
                { type: 'button', kind: 'shop', url: 'https://old-shop.example.org/new' },
                { type: 'button', kind: 'sale', url: '/sale' },
              ],
            }),
            staff.manager.id,
          );
        },
        { commit: true },
      );

      const res = await preview(campaign);

      expect(res.json().warnings).toEqual([
        { blockIndex: 0, code: 'LINK_NOT_ALLOWED' },
        { blockIndex: 1, code: 'LINK_NOT_ALLOWED' },
      ]);
      expect(res.json().html).not.toContain('old-shop.example.org');
      expect(res.json().text).not.toContain('old-shop.example.org');
      expect(res.json().html).toContain('the old shop');
      expect(res.json().text).toContain(`${SHOP}/sale?utm_source=newsletter`);
    });
  });

  // the logo is shown by its address in a preview and in the mail itself, which carries no attachment
  describe('the logo', () => {
    it('is shown by its address in the preview', async () => {
      setShopSettings({ logoUrl: LOGO });

      const res = await preview(id);

      expect(res.json().html).toContain(`src="${LOGO}"`);
      expect(res.json().html).not.toContain('cid:');
    });

    it('is the name of the shop in its place while the shop has none', async () => {
      setShopSettings({ logoUrl: null, shopName: 'Linen & Co' });

      const res = await preview(id);

      expect(res.json().html).not.toContain('cid:');
      expect(res.json().html).not.toContain(LOGO);
      expect(res.json().html).toContain('Linen &amp; Co');
    });
  });

  describe('escaping', () => {
    it('shows the names of the products and of the categories, the titles and the texts as text', async () => {
      const hostile = await newProduct({ name: '<script>alert("p")</script>' });
      const category = await createCategory({ name: '<img src=x onerror=alert(1)>' });
      const campaign = await campaignOf({
        subject: { en: 'Fish & <b>chips</b>' },
        blocks: [
          { type: 'text', text: { en: '<script>alert("t")</script> [x" onclick="y](/z)' } },
          {
            type: 'products',
            title: { en: '<u>Picks</u>' },
            source: 'manual',
            productIds: [hostile.id],
          },
          { type: 'category', categoryId: category.id, title: { en: '"><svg onload=alert(1)>' } },
        ],
      });

      const res = await preview(campaign);
      const html = res.json().html as string;

      expect(res.statusCode).toBe(200);
      expect(res.json().subject).toBe('Fish & <b>chips</b>');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<svg');
      expect(html).not.toContain('<u>');
      expect(html).not.toMatch(/<[^>]*\sonclick=/);
      expect(html).toContain('&lt;script&gt;alert(&quot;p&quot;)&lt;/script&gt;');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });
  });

  describe('a campaign in any state', () => {
    it.each(['scheduled', 'sending', 'finished', 'stopped', 'cancelled'] as const)(
      'is looked at when it is %s',
      async (state) => {
        const campaign = await campaignOf(contentWith([shirt.id], shoes.id));
        await moveTo(staff.manager, campaign, state);

        const res = await preview(campaign);

        expect(res.statusCode).toBe(200);
        expect(res.json().subject).toBe('Spring sale');
      },
    );
  });

  describe('what it does not do', () => {
    it('sends no mail, changes nothing of the campaign and writes no line to the log', async () => {
      const sent = watchNewsletterMail();
      const campaign = await campaignOf(contentWith([shirt.id], shoes.id));
      const row = (await campaignRowOf(campaign))!;
      const lines = await campaignLinesOf(campaign);

      expect((await preview(campaign)).statusCode).toBe(200);
      expect((await preview(campaign, 'es')).statusCode).toBe(200);

      expect(sent).toEqual([]);
      const after = (await campaignRowOf(campaign))!;
      expect(after.updatedAt).toEqual(row.updatedAt);
      expect(after.status).toBe('draft');
      expect(after.productsSnapshot).toBeNull();
      expect(await campaignLinesOf(campaign)).toEqual(lines);
    });
  });

  describe('the refusals', () => {
    it('refuses a campaign that is not there', async () => {
      const res = await preview(2_147_483_647);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_CAMPAIGN_NOT_FOUND' });
    });

    it.each([
      ['a language the shop does not answer in', 'xx'],
      ['a language the shop knows but does not answer in', 'fr'],
      ['a code that is no language', 'english'],
      ['one letter', 'e'],
    ])('refuses %s: LOCALE_INVALID', async (_case, locale) => {
      const res = await preview(id, locale);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'LOCALE_INVALID' });
    });

    it('refuses an empty language with the schema of the body', async () => {
      const res = await preview(id, '');

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    });

    it('refuses a language the shop answers in that the campaign has no subject in', async () => {
      const res = await preview(id, 'uk');

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_LOCALE_NOT_IN_CAMPAIGN' });
    });

    it('looks for the campaign before it judges the language', async () => {
      const res = await preview(2_147_483_647, 'xx');

      expect(res.statusCode).toBe(404);
    });

    it.each([
      ['no body', undefined],
      ['no language', {}],
      ['a language that is no text', { locale: 5 }],
      ['a language that is null', { locale: null }],
      ['a field the route does not take', { locale: 'en', email: 'a@b.c' }],
    ])(
      'refuses %s with VALIDATION_ERROR, nothing is converted or dropped',
      async (_case, payload) => {
        const res = await api.preview(staff.manager, id, payload);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      },
    );

    it('refuses an id that is no id', async () => {
      const res = await api.preview(staff.manager, 'abc', { locale: 'en' });

      expect(res.statusCode).toBe(400);
    });
  });
});
