import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { MAX_ID } from '@schemas/idPathParam.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import {
  answerOf,
  choose,
  createChoice,
  createProductWith,
  numberOf,
  type VariantSpec,
} from '../../../helpers/characteristics.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createAttribute,
  createAttributeGroup,
  createAttributeOption,
  createCategory,
  createUser,
  deleteProductFromCatalog,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { markVariantDeleted, stripVariantImages } from '../../../helpers/variants.js';

// GET /api/products/filters?categoryId=<id>[&branch=false]: the filter of a category, made from the
// variants a buyer sees in it (the category and everything below it, unless branch=false). A
// characteristic is in it when it is in the filters (`inFilters`), is no text, and has at least two
// DIFFERENT values among those variants. A choice gives the values that are there (ordered as the
// admin put them), a number its lowest and highest, yes/no the answers that are there. A variant
// without a value is no value. No counts, and nothing else the person chose changes the panel

let app: FastifyInstance;
let admin: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
  userIds.push(admin.id, buyer.id);
});

afterAll(async () => {
  try {
    for (const product of products) await deleteProductFromCatalog(product.id);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type PanelItem = {
  id: number;
  name: string;
  unit: string | null;
  type: string;
  group: { id: number; name: string };
  values?: ({ id: number; name: string; colorCode: string | null; position: number } | string)[];
  min?: number;
  max?: number;
};

const panel = (
  query: Record<string, string>,
  actor: TestUser | null = null,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'GET',
    url: `/api/products/filters?${new URLSearchParams(query)}`,
    headers: actor ? { cookie: accessCookie(actor) } : {},
  });

const itemsOf = (res: LightMyRequestResponse) => {
  expect(res.statusCode).toBe(200);
  return res.json().items as PanelItem[];
};

const idsOf = (res: LightMyRequestResponse) => itemsOf(res).map((item) => item.id);

async function makeProduct(categoryId: number, specs: VariantSpec[]) {
  const made = await createProductWith(categoryId, specs);
  products.push(made.product);
  return made;
}

const namesOf = (item: PanelItem | undefined) =>
  (item?.values ?? []).map((value) => (typeof value === 'string' ? value : value.name));

describe('what the panel holds', () => {
  it('holds a choice with the values that are in the category, ordered as the admin put them', async () => {
    const category = (await createCategory()).id;
    // made in this order; the places follow it: XL, S, M, L
    const size = await createChoice(['XL', 'S', 'M', 'L']);
    await makeProduct(category, [
      { values: [choose(size, 'M')] },
      { values: [choose(size, 'XL')] },
      { values: [choose(size, 'S')] },
    ]);

    const [item, ...rest] = itemsOf(await panel({ categoryId: String(category) }));

    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      id: size.attribute.id,
      name: size.attribute.name,
      unit: null,
      type: 'option',
    });
    // L is in no variant, M was the first made but has the third place
    expect(namesOf(item)).toEqual(['XL', 'S', 'M']);
    expect(item!.values).toEqual([
      { id: size.option.XL, name: 'XL', colorCode: null, position: 1 },
      { id: size.option.S, name: 'S', colorCode: null, position: 2 },
      { id: size.option.M, name: 'M', colorCode: null, position: 3 },
    ]);
  });

  it('follows the places the admin changed, not the ids or the names', async () => {
    const category = (await createCategory()).id;
    const tone = await createChoice(['dark', 'light', 'mid']);
    await makeProduct(category, [
      { values: [choose(tone, 'dark')] },
      { values: [choose(tone, 'light')] },
      { values: [choose(tone, 'mid')] },
    ]);
    // the third value comes first, the first one last
    await asAdmin(async (tx) => {
      await tx.attributeOption.update({ where: { id: tone.option.dark! }, data: { position: 30 } });
      await tx.attributeOption.update({
        where: { id: tone.option.light! },
        data: { position: 20 },
      });
      await tx.attributeOption.update({ where: { id: tone.option.mid! }, data: { position: 10 } });
    });

    const [item] = itemsOf(await panel({ categoryId: String(category) }));

    expect(namesOf(item)).toEqual(['mid', 'light', 'dark']);
  });

  it('gives a colour its code and a value without one a null', async () => {
    const category = (await createCategory()).id;
    const paint = await createChoice([]);
    const red = (
      await createAttributeOption(paint.attribute.id, { name: 'red', colorCode: '#ff0000' })
    ).id;
    const plain = (await createAttributeOption(paint.attribute.id, { name: 'plain' })).id;
    await makeProduct(category, [
      { values: [{ attributeId: paint.attribute.id, value: { optionId: red } }] },
      { values: [{ attributeId: paint.attribute.id, value: { optionId: plain } }] },
    ]);

    const [item] = itemsOf(await panel({ categoryId: String(category) }));

    expect(item!.values).toEqual([
      { id: red, name: 'red', colorCode: '#ff0000', position: 1 },
      { id: plain, name: 'plain', colorCode: null, position: 2 },
    ]);
  });

  it('holds a number with its lowest and its highest value and the unit', async () => {
    const category = (await createCategory()).id;
    const storage = await createAttribute({ type: 'number', unit: 'GB' });
    await makeProduct(category, [
      { values: [numberOf(storage, 256)] },
      { values: [numberOf(storage, 64)] },
      { values: [numberOf(storage, 128)] },
    ]);

    const [item] = itemsOf(await panel({ categoryId: String(category) }));

    expect(item).toMatchObject({ id: storage.id, unit: 'GB', type: 'number', min: 64, max: 256 });
    expect(item).not.toHaveProperty('values');
  });

  it('holds the decimals of a number as they are', async () => {
    const category = (await createCategory()).id;
    const diagonal = await createAttribute({ type: 'number', decimals: 2 });
    await makeProduct(category, [
      { values: [numberOf(diagonal, 6.1)] },
      { values: [numberOf(diagonal, 6.75)] },
      { values: [numberOf(diagonal, -1.5)] },
    ]);

    const [item] = itemsOf(await panel({ categoryId: String(category) }));

    expect(item).toMatchObject({ min: -1.5, max: 6.75 });
  });

  it('holds yes/no with both answers when both are there', async () => {
    const category = (await createCategory()).id;
    const waterproof = await createAttribute({ type: 'boolean' });
    await makeProduct(category, [
      { values: [answerOf(waterproof, true)] },
      { values: [answerOf(waterproof, false)] },
      { values: [answerOf(waterproof, true)] },
    ]);

    const [item] = itemsOf(await panel({ categoryId: String(category) }));

    expect(item).toMatchObject({ id: waterproof.id, type: 'boolean', values: ['yes', 'no'] });
  });

  it('holds the values of a set that its variants have, even when one variant has them all', async () => {
    const category = (await createCategory()).id;
    const features = await createChoice(['wifi', 'bluetooth', 'nfc'], { type: 'options' });
    await makeProduct(category, [{ values: [choose(features, 'nfc'), choose(features, 'wifi')] }]);

    const [item] = itemsOf(await panel({ categoryId: String(category) }));

    expect(item).toMatchObject({ id: features.attribute.id, type: 'options' });
    expect(namesOf(item)).toEqual(['wifi', 'nfc']);
  });

  it('gives the group of the characteristic', async () => {
    const category = (await createCategory()).id;
    const group = await createAttributeGroup({ name: 'Display' });
    const diagonal = await createAttribute({ type: 'number', groupId: group.id });
    await makeProduct(category, [
      { values: [numberOf(diagonal, 6)] },
      { values: [numberOf(diagonal, 7)] },
    ]);

    const [item] = itemsOf(await panel({ categoryId: String(category) }));

    expect(item!.group).toEqual({ id: group.id, name: 'Display' });
  });

  it('gives no counts', async () => {
    const category = (await createCategory()).id;
    const colour = await createChoice(['black', 'white']);
    await makeProduct(category, [
      { values: [choose(colour, 'black')] },
      { values: [choose(colour, 'white')] },
    ]);

    const res = await panel({ categoryId: String(category) });

    expect(JSON.stringify(res.json())).not.toMatch(/count|total/i);
  });

  it('is empty for a category without variants', async () => {
    const category = (await createCategory()).id;

    const res = await panel({ categoryId: String(category) });

    expect(res.json()).toEqual({ items: [] });
  });
});

describe('what the panel leaves out', () => {
  it('leaves out a characteristic that has one value in the category', async () => {
    const category = (await createCategory()).id;
    const country = await createChoice(['DE', 'PL']);
    const weight = await createAttribute({ type: 'number' });
    const sealed = await createAttribute({ type: 'boolean' });
    await makeProduct(category, [
      { values: [choose(country, 'DE'), numberOf(weight, 5), answerOf(sealed, true)] },
      { values: [choose(country, 'DE'), numberOf(weight, 5), answerOf(sealed, true)] },
    ]);

    expect(itemsOf(await panel({ categoryId: String(category) }))).toEqual([]);
  });

  it('leaves out a characteristic whose second value is in another category', async () => {
    const category = (await createCategory()).id;
    const elsewhere = (await createCategory()).id;
    const colour = await createChoice(['black', 'white']);
    await makeProduct(category, [{ values: [choose(colour, 'black')] }]);
    await makeProduct(elsewhere, [{ values: [choose(colour, 'white')] }]);

    expect(itemsOf(await panel({ categoryId: String(category) }))).toEqual([]);
  });

  it('does not count a variant without a value as another value', async () => {
    const category = (await createCategory()).id;
    const colour = await createChoice(['black', 'white']);
    const storage = await createAttribute({ type: 'number' });
    await makeProduct(category, [
      { values: [choose(colour, 'black'), numberOf(storage, 64)] },
      { values: [] },
      { values: [] },
    ]);

    expect(itemsOf(await panel({ categoryId: String(category) }))).toEqual([]);
  });

  it('leaves out a text, however it is set', async () => {
    const category = (await createCategory()).id;
    const note = await createAttribute({ type: 'text', inFilters: true });
    await makeProduct(category, [
      { values: [{ attributeId: note.id, value: { text: 'one' } }] },
      { values: [{ attributeId: note.id, value: { text: 'two' } }] },
    ]);

    expect(itemsOf(await panel({ categoryId: String(category) }))).toEqual([]);
  });

  it('leaves out a characteristic that is not in the filters', async () => {
    const category = (await createCategory()).id;
    const quiet = await createChoice(['a', 'b'], { inFilters: false });
    const loud = await createChoice(['a', 'b'], { inFilters: true });
    await makeProduct(category, [
      { values: [choose(quiet, 'a'), choose(loud, 'a')] },
      { values: [choose(quiet, 'b'), choose(loud, 'b')] },
    ]);

    expect(idsOf(await panel({ categoryId: String(category) }))).toEqual([loud.attribute.id]);
  });

  it('ignores the variants a buyer does not see, and the products taken out', async () => {
    const category = (await createCategory()).id;
    const colour = await createChoice(['black', 'white', 'red', 'blue']);
    const made = await makeProduct(category, [
      { values: [choose(colour, 'black')] },
      // taken out of sale
      { values: [choose(colour, 'white')] },
      // shows no picture
      { values: [choose(colour, 'red')] },
    ]);
    await markVariantDeleted(made.variantIds[1]!);
    await stripVariantImages(made.variantIds[2]!);
    // the product is taken out of the catalog
    const gone = await makeProduct(category, [{ values: [choose(colour, 'blue')] }]);
    await deleteProductFromCatalog(gone.product.id);

    // one value is left: black
    expect(itemsOf(await panel({ categoryId: String(category) }))).toEqual([]);

    // a second visible value brings the characteristic and only the values that are seen
    await makeProduct(category, [{ values: [choose(colour, 'red')] }]);
    const [item] = itemsOf(await panel({ categoryId: String(category) }));
    expect(namesOf(item)).toEqual(['black', 'red']);
  });

  it('ignores the variants of a product whose other variants are all hidden', async () => {
    const category = (await createCategory()).id;
    const storage = await createAttribute({ type: 'number' });
    const made = await makeProduct(category, [
      { values: [numberOf(storage, 64)] },
      { values: [numberOf(storage, 512)] },
    ]);
    await markVariantDeleted(made.variantIds[1]!);

    expect(itemsOf(await panel({ categoryId: String(category) }))).toEqual([]);
  });

  it('keeps the same panel for an admin as for a buyer, the hidden variants left out', async () => {
    const category = (await createCategory()).id;
    const colour = await createChoice(['black', 'white']);
    const made = await makeProduct(category, [
      { values: [choose(colour, 'black')] },
      { values: [choose(colour, 'white')] },
    ]);
    await markVariantDeleted(made.variantIds[1]!);

    expect(itemsOf(await panel({ categoryId: String(category) }, admin))).toEqual([]);
  });
});

describe('the branch of a category', () => {
  async function tree() {
    const parent = (await createCategory()).id;
    const first = (await createCategory({ parentId: parent })).id;
    const second = (await createCategory({ parentId: parent })).id;
    const deep = (await createCategory({ parentId: first })).id;
    const colour = await createChoice(['black', 'white', 'red', 'blue']);
    await makeProduct(parent, [{ values: [choose(colour, 'black')] }]);
    await makeProduct(first, [{ values: [choose(colour, 'white')] }]);
    await makeProduct(second, [{ values: [choose(colour, 'red')] }]);
    await makeProduct(deep, [{ values: [choose(colour, 'blue')] }]);

    return { parent, first, second, deep, colour };
  }

  it('gives a parent the values of everything below it', async () => {
    const { parent } = await tree();

    const [item] = itemsOf(await panel({ categoryId: String(parent) }));

    expect(namesOf(item)).toEqual(['black', 'white', 'red', 'blue']);
  });

  it('takes the branch by default and with branch=true', async () => {
    const { first } = await tree();

    const byDefault = itemsOf(await panel({ categoryId: String(first) }));
    const asked = itemsOf(await panel({ categoryId: String(first), branch: 'true' }));

    expect(namesOf(byDefault[0])).toEqual(['white', 'blue']);
    expect(asked).toEqual(byDefault);
  });

  it('gives only the category itself with branch=false', async () => {
    const { parent, first } = await tree();

    // the parent has one product of black: one value, so no panel
    expect(itemsOf(await panel({ categoryId: String(parent), branch: 'false' }))).toEqual([]);
    expect(itemsOf(await panel({ categoryId: String(first), branch: 'false' }))).toEqual([]);
  });

  it('gives only the category itself, with two values of its own', async () => {
    const { first, colour } = await tree();
    await makeProduct(first, [{ values: [choose(colour, 'red')] }]);

    const [item] = itemsOf(await panel({ categoryId: String(first), branch: 'false' }));

    expect(namesOf(item)).toEqual(['white', 'red']);
  });

  it('gives a leaf the values of its own products', async () => {
    const { deep, second } = await tree();

    expect(itemsOf(await panel({ categoryId: String(deep) }))).toEqual([]);
    expect(itemsOf(await panel({ categoryId: String(second) }))).toEqual([]);
  });
});

describe('the order of the characteristics', () => {
  it('orders them by the place of the group and then by their place in it, as the card does', async () => {
    const category = (await createCategory()).id;
    const early = await createAttributeGroup({ name: 'Early' });
    const late = await createAttributeGroup({ name: 'Late' });
    // the characteristic of the late group is made first: its id is the lowest, its place the last
    const lateOne = await createAttribute({ type: 'number', groupId: late.id, name: 'Late one' });
    const earlyOne = await createAttribute({
      type: 'number',
      groupId: early.id,
      name: 'Early one',
    });
    const earlyTwo = await createAttribute({
      type: 'number',
      groupId: early.id,
      name: 'Early two',
    });
    // the second characteristic of the early group takes the first place of it
    await asAdmin(async (tx) => {
      await tx.attribute.update({ where: { id: earlyOne.id }, data: { position: 2 } });
      await tx.attribute.update({ where: { id: earlyTwo.id }, data: { position: 1 } });
    });
    await makeProduct(category, [
      { values: [numberOf(lateOne, 1), numberOf(earlyOne, 1), numberOf(earlyTwo, 1)] },
      { values: [numberOf(lateOne, 2), numberOf(earlyOne, 2), numberOf(earlyTwo, 2)] },
    ]);

    const items = itemsOf(await panel({ categoryId: String(category) }));

    expect(items.map((item) => item.name)).toEqual(['Early two', 'Early one', 'Late one']);
    expect(items.map((item) => item.group.name)).toEqual(['Early', 'Early', 'Late']);
  });
});

describe('who may ask, and what', () => {
  it('answers a guest, a user, an admin', async () => {
    const category = (await createCategory()).id;
    const colour = await createChoice(['black', 'white']);
    await makeProduct(category, [
      { values: [choose(colour, 'black')] },
      { values: [choose(colour, 'white')] },
    ]);

    const guest = await panel({ categoryId: String(category) });
    const user = await panel({ categoryId: String(category) }, buyer);
    const asAdmin = await panel({ categoryId: String(category) }, admin);

    for (const res of [guest, user, asAdmin]) {
      expect(idsOf(res)).toEqual([colour.attribute.id]);
    }
  });

  it('ignores a parameter it does not know', async () => {
    const category = (await createCategory()).id;

    const res = await panel({ categoryId: String(category), f: '1:yes' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it('is 404 for a category that is not there', async () => {
    const res = await panel({ categoryId: String(MAX_ID) });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_NOT_FOUND' });
  });

  it.each([
    ['no category', {}],
    ['a category of zero', { categoryId: '0' }],
    ['a negative category', { categoryId: '-1' }],
    ['a category that is no number', { categoryId: 'shoes' }],
    ['a category over the biggest id', { categoryId: String(MAX_ID + 1) }],
    ['a category with a decimal', { categoryId: '1.5' }],
    ['a branch that is no boolean', { categoryId: '1', branch: 'maybe' }],
  ])('is 400 for %s', async (_case, query) => {
    const res = await panel(query as Record<string, string>);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});
