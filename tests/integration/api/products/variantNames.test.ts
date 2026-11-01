import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createAttribute,
  createAttributeGroup,
  createAttributeOption,
  createProduct,
  createUser,
  createVariant,
  createVariantValue,
  removeProducts,
  type TestAttribute,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';
import { galleryIdsOf, markVariantDeleted, stripVariantImages } from '../../../helpers/variants.js';

// the name of a variant and the values that tell it from the others of its product: the product
// name, a dash and the labels of the characteristics that differ between the variants a buyer sees,
// the main ones first. The card, the lists and the order items read the name from the database
// (cartlify.variant_names), so what the card shows and what an order keeps agree

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const DASH = '—';

const newProduct = async (name: string) => {
  const product = await createProduct({ name });
  products.push(product);
  return product;
};

const cardOf = (productId: number, actor: TestUser | null = buyer, variantId?: number) =>
  app.inject({
    method: 'GET',
    url: `/api/products/${productId}${variantId ? `?variantId=${variantId}` : ''}`,
    headers: actor ? { cookie: accessCookie(actor) } : {},
  });

type Short = {
  id: number;
  name: string;
  values: { attributeId: number; name: string; value: string }[];
};

const namesOf = async (productId: number, actor: TestUser | null = buyer) => {
  const res = await cardOf(productId, actor);
  expect(res.statusCode).toBe(200);
  return new Map((res.json().variants as Short[]).map((variant) => [variant.id, variant]));
};

const patchDirectory = (url: string, payload: object) =>
  app.inject({
    method: 'PATCH',
    url,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

type Phone = {
  memory: TestAttribute;
  colour: TestAttribute;
  black: { id: number };
  white: { id: number };
};

// a memory (a number with a unit, in a group that comes first) and a colour (a main choice, in a
// group that comes later)
async function phoneCharacteristics(): Promise<Phone> {
  const early = await createAttributeGroup();
  const late = await createAttributeGroup();
  const memory = await createAttribute({ type: 'number', unit: 'GB', groupId: early.id });
  const colour = await createAttribute({ type: 'option', isMain: true, groupId: late.id });
  const black = await createAttributeOption(colour.id, { name: 'black' });
  const white = await createAttributeOption(colour.id, { name: 'white' });
  return { memory, colour, black, white };
}

describe('the names of the variants of a product', () => {
  it('tell the variants apart by the characteristics that differ, the main one first', async () => {
    const { memory, colour, black, white } = await phoneCharacteristics();
    const phone = await newProduct('Phone X');
    const v2 = await createVariant(phone.id);
    const v3 = await createVariant(phone.id);
    for (const [variantId, colourId, gb] of [
      [phone.variantId, black.id, 128],
      [v2.id, black.id, 256],
      [v3.id, white.id, 128],
    ] as const) {
      await createVariantValue(variantId, colour.id, { optionId: colourId });
      await createVariantValue(variantId, memory.id, { number: gb });
    }

    const names = await namesOf(phone.id);

    // the colour is main, so it comes first although the memory is in the earlier group
    expect([...names.values()].map((variant) => variant.name)).toEqual([
      `Phone X ${DASH} black, 128 GB`,
      `Phone X ${DASH} black, 256 GB`,
      `Phone X ${DASH} white, 128 GB`,
    ]);
    expect(names.get(phone.variantId)!.values).toEqual([
      { attributeId: colour.id, name: expect.any(String), value: 'black' },
      { attributeId: memory.id, name: expect.any(String), value: '128 GB' },
    ]);
  });

  it('leave out a characteristic the variants of the product share, whatever product they are of', async () => {
    const { memory, colour, black } = await phoneCharacteristics();
    const case1 = await newProduct('Case Y');
    const second = await createVariant(case1.id);
    // the colour is the same in both, the memory differs
    for (const [variantId, gb] of [
      [case1.variantId, 128],
      [second.id, 256],
    ] as const) {
      await createVariantValue(variantId, colour.id, { optionId: black.id });
      await createVariantValue(variantId, memory.id, { number: gb });
    }
    // another product with a single variant is no product of this one: it keeps its plain name
    const single = await newProduct('Single Z');
    await createVariantValue(single.variantId, memory.id, { number: 64 });

    const names = await namesOf(case1.id);
    const alone = await namesOf(single.id);

    expect([...names.values()].map((variant) => variant.name)).toEqual([
      `Case Y ${DASH} 128 GB`,
      `Case Y ${DASH} 256 GB`,
    ]);
    expect(alone.get(single.variantId)).toMatchObject({ name: 'Single Z', values: [] });
  });

  it('are the plain name of the product when the variants are alike in every characteristic', async () => {
    const { colour, black } = await phoneCharacteristics();
    const book = await newProduct('Book W');
    await createVariantValue(book.variantId, colour.id, { optionId: black.id });

    const names = await namesOf(book.id);

    expect(names.get(book.variantId)).toMatchObject({ name: 'Book W', values: [] });
  });

  it('write yes or no with the name of the characteristic, the values of a set joined by a comma', async () => {
    const waterproof = await createAttribute({
      type: 'boolean',
      name: `Waterproof ${Math.random()}`,
    });
    const features = await createAttribute({ type: 'options' });
    const nfc = await createAttributeOption(features.id, { name: 'NFC' });
    const gps = await createAttributeOption(features.id, { name: 'GPS' });
    const watch = await newProduct('Watch V');
    const second = await createVariant(watch.id);
    await createVariantValue(watch.variantId, waterproof.id, { bool: true });
    await createVariantValue(second.id, waterproof.id, { bool: false });
    await createVariantValue(watch.variantId, features.id, { optionId: nfc.id });
    await createVariantValue(watch.variantId, features.id, { optionId: gps.id });
    await createVariantValue(second.id, features.id, { optionId: gps.id });

    const names = await namesOf(watch.id);

    expect(names.get(watch.variantId)!.name).toBe(
      `Watch V ${DASH} ${waterproof.name}: yes, NFC, GPS`,
    );
    expect(names.get(second.id)!.name).toBe(`Watch V ${DASH} ${waterproof.name}: no, GPS`);
    expect(names.get(watch.variantId)!.values[0]).toMatchObject({
      name: waterproof.name,
      value: 'yes',
    });
  });

  it('count a variant that lacks a value as another value, and give it no label', async () => {
    const { memory } = await phoneCharacteristics();
    const cable = await newProduct('Cable U');
    const second = await createVariant(cable.id);
    await createVariantValue(cable.variantId, memory.id, { number: 128 });

    const names = await namesOf(cable.id);

    expect(names.get(cable.variantId)!.name).toBe(`Cable U ${DASH} 128 GB`);
    expect(names.get(second.id)!.name).toBe('Cable U');
  });

  it('compare the variants a buyer sees: one taken out of sale or without a picture is not among them', async () => {
    const { colour, black, white } = await phoneCharacteristics();
    const lamp = await newProduct('Lamp T');
    const second = await createVariant(lamp.id);
    const gone = await createVariant(lamp.id);
    const bare = await createVariant(lamp.id);
    await createVariantValue(lamp.variantId, colour.id, { optionId: black.id });
    await createVariantValue(second.id, colour.id, { optionId: black.id });
    await createVariantValue(gone.id, colour.id, { optionId: white.id });
    await createVariantValue(bare.id, colour.id, { optionId: white.id });
    await markVariantDeleted(gone.id);
    await stripVariantImages(bare.id);

    const forBuyer = await namesOf(lamp.id, buyer);
    const forAdmin = await namesOf(lamp.id, admin);

    // the two a buyer sees are alike: nothing tells them apart, the colour of the others is no matter
    expect([...forBuyer.values()].map((variant) => variant.name)).toEqual(['Lamp T', 'Lamp T']);
    expect(forBuyer.has(gone.id)).toBe(false);
    expect(forBuyer.has(bare.id)).toBe(false);
    // an admin sees all four; the names of the two that are visible are the same, and the other two
    // are compared with the live ones (the two visible and the one without a picture) and with
    // themselves
    expect(forAdmin.get(lamp.variantId)!.name).toBe('Lamp T');
    expect(forAdmin.get(second.id)!.name).toBe('Lamp T');
    expect(forAdmin.get(bare.id)!.name).toBe(`Lamp T ${DASH} white`);
    expect(forAdmin.get(gone.id)!.name).toBe(`Lamp T ${DASH} white`);
  });

  it('change with the variants: a second one makes the name of the first carry its value', async () => {
    const colour = await createAttribute({ type: 'text' });
    const shirt = await newProduct('Shirt S');
    await createVariantValue(shirt.variantId, colour.id, { text: 'black' });
    expect((await namesOf(shirt.id)).get(shirt.variantId)!.name).toBe('Shirt S');

    const second = await createVariant(shirt.id);
    await createVariantValue(second.id, colour.id, { text: 'white' });

    const names = await namesOf(shirt.id);
    expect(names.get(shirt.variantId)!.name).toBe(`Shirt S ${DASH} black`);
    expect(names.get(second.id)!.name).toBe(`Shirt S ${DASH} white`);
  });

  it('are in the full variant of the switch and in the card of the variant opened', async () => {
    const colour = await createAttribute({ type: 'text' });
    const shirt = await newProduct('Shirt R');
    const second = await createVariant(shirt.id);
    await createVariantValue(shirt.variantId, colour.id, { text: 'black' });
    await createVariantValue(second.id, colour.id, { text: 'white' });

    const opened = await cardOf(shirt.id, buyer, second.id);
    const alone = await app.inject({
      method: 'GET',
      url: `/api/products/${shirt.id}/variants/${second.id}`,
      headers: { cookie: accessCookie(buyer) },
    });

    expect(opened.json().variant).toMatchObject({
      id: second.id,
      name: `Shirt R ${DASH} white`,
      values: [{ attributeId: colour.id, value: 'white' }],
    });
    expect(alone.json()).toMatchObject({ name: `Shirt R ${DASH} white` });
    expect(alone.json().attributes[0].items[0]).toMatchObject({ value: 'white', raw: 'white' });
  });
});

describe('a rename and the names', () => {
  it('of a value, a unit, a characteristic changes the names at once', async () => {
    const { memory, colour, black, white } = await phoneCharacteristics();
    const flag = await createAttribute({ type: 'boolean', name: `Case ${Math.random()}` });
    const phone = await newProduct('Phone Q');
    const second = await createVariant(phone.id);
    await createVariantValue(phone.variantId, colour.id, { optionId: black.id });
    await createVariantValue(second.id, colour.id, { optionId: white.id });
    await createVariantValue(phone.variantId, memory.id, { number: 128 });
    await createVariantValue(second.id, memory.id, { number: 128 });
    await createVariantValue(phone.variantId, flag.id, { bool: true });
    await createVariantValue(second.id, flag.id, { bool: false });
    expect((await namesOf(phone.id)).get(phone.variantId)!.name).toBe(
      `Phone Q ${DASH} black, ${flag.name}: yes`,
    );

    await patchDirectory(`/api/admin/attributes/${colour.id}/options/${black.id}`, {
      name: 'graphite',
    });
    await patchDirectory(`/api/admin/attributes/${flag.id}`, { name: 'Sealed' });
    const renamed = await namesOf(phone.id);

    expect(renamed.get(phone.variantId)!.name).toBe(`Phone Q ${DASH} graphite, Sealed: yes`);
    expect(renamed.get(second.id)!.name).toBe(`Phone Q ${DASH} white, Sealed: no`);
  });

  it('of the unit of a number follows too, and a number has no trailing zeros', async () => {
    const memory = await createAttribute({ type: 'number', unit: 'GB', decimals: 3 });
    const phone = await newProduct('Phone P');
    const second = await createVariant(phone.id);
    await createVariantValue(phone.variantId, memory.id, { number: 1.5 });
    await createVariantValue(second.id, memory.id, { number: 2 });

    const before = await namesOf(phone.id);
    await patchDirectory(`/api/admin/attributes/${memory.id}`, { unit: 'TB' });
    const after = await namesOf(phone.id);

    expect(before.get(phone.variantId)!.name).toBe(`Phone P ${DASH} 1.5 GB`);
    expect(before.get(second.id)!.name).toBe(`Phone P ${DASH} 2 GB`);
    expect(after.get(second.id)!.name).toBe(`Phone P ${DASH} 2 TB`);
  });

  it('of a characteristic marked main or secondary changes the order of the labels at once', async () => {
    const { memory, colour, black, white } = await phoneCharacteristics();
    const phone = await newProduct('Phone O');
    const second = await createVariant(phone.id);
    for (const [variantId, gb] of [
      [phone.variantId, 128],
      [second.id, 256],
    ] as const) {
      await createVariantValue(variantId, colour.id, { optionId: black.id });
      await createVariantValue(variantId, memory.id, { number: gb });
    }
    await asAdmin((tx) =>
      tx.variantAttributeValue.updateMany({
        where: { variantId: second.id, attributeId: colour.id },
        data: { optionId: white.id },
      }),
    );

    // the colour is main: first
    expect((await namesOf(phone.id)).get(phone.variantId)!.name).toBe(
      `Phone O ${DASH} black, 128 GB`,
    );

    await patchDirectory(`/api/admin/attributes/${colour.id}`, { isMain: false });
    await patchDirectory(`/api/admin/attributes/${memory.id}`, { isMain: true });

    // the memory is main now, and it is in the group that comes first anyway
    expect((await namesOf(phone.id)).get(phone.variantId)!.name).toBe(
      `Phone O ${DASH} 128 GB, black`,
    );

    await patchDirectory(`/api/admin/attributes/${memory.id}`, { isMain: false });
    await patchDirectory(`/api/admin/attributes/${colour.id}`, { isMain: true });
    expect((await namesOf(phone.id)).get(phone.variantId)!.name).toBe(
      `Phone O ${DASH} black, 128 GB`,
    );
  });
});

describe('the name an order keeps', () => {
  it('is a copy made at the confirmation, the same the card showed, and a rename does not touch it', async () => {
    const { colour, black, white } = await phoneCharacteristics();
    // the products of orders stay (an order item holds its product): this one is not removed
    const phone = await createProduct({ name: 'Phone N' });
    const second = await createVariant(phone.id);
    await createVariantValue(phone.variantId, colour.id, { optionId: black.id });
    await createVariantValue(second.id, colour.id, { optionId: white.id });
    const shown = (await namesOf(phone.id)).get(phone.variantId)!.name;
    const orderBuyer = await createUser();
    const cartBuyer = await createUser();

    const orderId = await placeOrder(
      app,
      csrf,
      orderBuyer,
      { variantId: phone.variantId },
      'waiting',
    );
    // a cart of another buyer holds the same variant, not confirmed
    await placeOrder(app, csrf, cartBuyer, { variantId: phone.variantId }, 'cart');

    const copy = await asAdmin((tx) =>
      tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { productName: true } }),
    );
    expect(shown).toBe(`Phone N ${DASH} black`);
    expect(copy.productName).toBe(shown);

    await patchDirectory(`/api/admin/attributes/${colour.id}/options/${black.id}`, {
      name: 'graphite',
    });

    // the card shows the new name; the confirmed order keeps the copy; the cart follows the variant
    expect((await namesOf(phone.id)).get(phone.variantId)!.name).toBe(`Phone N ${DASH} graphite`);
    const order = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(orderBuyer) },
    });
    expect(order.json().items[0].variant.name).toBe(shown);
    const cart = await app.inject({
      method: 'GET',
      url: '/api/orders/current',
      headers: { cookie: accessCookie(cartBuyer) },
    });
    expect(cart.json().items[0].variant.name).toBe(`Phone N ${DASH} graphite`);
    expect(cart.json().items[0].variant).not.toHaveProperty('values');
    const stillCopy = await asAdmin((tx) =>
      tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { productName: true } }),
    );
    expect(stillCopy.productName).toBe(shown);

    await closeSessions([orderBuyer.id, cartBuyer.id]);
  });
});

describe('the pictures and the names', () => {
  it('a gallery of a product the names are read for is not needed: a product without values is named by itself', async () => {
    const plain = await newProduct('Plain M');
    await createVariant(plain.id);

    const names = await namesOf(plain.id);

    expect([...names.values()].map((variant) => variant.name)).toEqual(['Plain M', 'Plain M']);
    expect(await galleryIdsOf(plain.id)).toHaveLength(1);
  });
});
