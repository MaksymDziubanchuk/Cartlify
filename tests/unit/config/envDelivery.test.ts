import { describe, expect, it } from '@jest/globals';

import { rejectedBy } from '../../helpers/errors.js';
import { importWithEnv } from '../../helpers/freshImport.js';

type Env = (typeof import('@config/env.js'))['default'];

// the least a shop sets: the countries the default manual method delivers to
const NO_DELIVERY = {
  DELIVERY_METHODS: '',
  DELIVERY_FLAT_PRICE: '',
  DELIVERY_FREE_FROM: '',
  DELIVERY_COUNTRIES: 'UA',
  PICKUP_ADDRESS: '',
  PICKUP_HOURS: '',
};

const loadEnv = async (values: Record<string, string> = {}) =>
  (
    await importWithEnv<typeof import('@config/env.js')>('@config/env.js', {
      ...NO_DELIVERY,
      ...values,
    })
  ).default as Env;

const messageOf = async (values: Record<string, string>) =>
  ((await rejectedBy(() => loadEnv(values))) as Error).message;

describe('the settings of the delivery', () => {
  it('give a shop that sends by hand to its countries and asks nothing for it when nothing else is set', async () => {
    const env = await loadEnv();

    expect(env.DELIVERY_METHODS).toEqual(['manual']);
    expect(env.DELIVERY_FLAT_PRICE).toBeNull();
    expect(env.DELIVERY_FREE_FROM).toBeNull();
    expect(env.DELIVERY_COUNTRIES).toEqual(['UA']);
    expect(env.PICKUP_ADDRESS).toBe('');
    expect(env.PICKUP_HOURS).toBe('');
  });

  it('read the values that are set', async () => {
    const env = await loadEnv({
      DELIVERY_METHODS: 'manual, pickup',
      DELIVERY_FLAT_PRICE: '4.99',
      DELIVERY_FREE_FROM: '50',
      DELIVERY_COUNTRIES: 'ua, PL,de',
      PICKUP_ADDRESS: 'Main street 1, Kyiv',
      PICKUP_HOURS: 'Mon-Fri 10:00-18:00',
    });

    expect(env.DELIVERY_METHODS).toEqual(['manual', 'pickup']);
    expect(env.DELIVERY_FLAT_PRICE).toBe(4.99);
    expect(env.DELIVERY_FREE_FROM).toBe(50);
    expect(env.DELIVERY_COUNTRIES).toEqual(['UA', 'PL', 'DE']);
    expect(env.PICKUP_ADDRESS).toBe('Main street 1, Kyiv');
    expect(env.PICKUP_HOURS).toBe('Mon-Fri 10:00-18:00');
  });

  it.each(['courier', 'manual,courier', 'manual,manual', 'manual,', ','])(
    'stop the start on the methods %p, naming the setting and no value',
    async (value) => {
      expect(await messageOf({ DELIVERY_METHODS: value })).toBe(
        'Invalid env variable: DELIVERY_METHODS must be a list of manual and pickup, each once',
      );
    },
  );

  it.each(['abc', '-1', '0', '4.999', '4,99', '1e3', '100000000', '4.', '.5'])(
    'stop the start on the flat price %p',
    async (value) => {
      expect(await messageOf({ DELIVERY_FLAT_PRICE: value })).toMatch(
        /^Invalid env variable: DELIVERY_FLAT_PRICE /,
      );
    },
  );

  it.each(['5', '4.9', '4.99', '99999999.99'])('take the flat price %p', async (value) => {
    expect((await loadEnv({ DELIVERY_FLAT_PRICE: value })).DELIVERY_FLAT_PRICE).toBe(Number(value));
  });

  it('stop the start on a free-from sum without a flat price', async () => {
    expect(await messageOf({ DELIVERY_FREE_FROM: '50' })).toBe(
      'Invalid env variable: DELIVERY_FREE_FROM needs DELIVERY_FLAT_PRICE',
    );
  });

  it('stop the start on a free-from sum that is not money', async () => {
    expect(await messageOf({ DELIVERY_FLAT_PRICE: '4.99', DELIVERY_FREE_FROM: '0' })).toMatch(
      /^Invalid env variable: DELIVERY_FREE_FROM /,
    );
  });

  it.each(['US', 'UKR', 'U', 'UA,US', 'UA,UA', 'UA,', '1A'])(
    'stop the start on the countries %p',
    async (value) => {
      expect(await messageOf({ DELIVERY_COUNTRIES: value })).toMatch(
        /^Invalid env variable: DELIVERY_COUNTRIES /,
      );
    },
  );

  // without a list nobody could confirm a manual delivery: no environment starts so
  it.each(['development', 'test', 'production'])(
    'stop the start in %s when the manual method has no countries',
    async (mode) => {
      expect(await messageOf({ NODE_ENV: mode, DELIVERY_COUNTRIES: '' })).toBe(
        'Missing required env variable: DELIVERY_COUNTRIES',
      );
    },
  );

  it('do not ask for countries of a shop that only has a pickup', async () => {
    const env = await loadEnv({
      NODE_ENV: 'production',
      DELIVERY_METHODS: 'pickup',
      DELIVERY_COUNTRIES: '',
      PICKUP_ADDRESS: 'Main street 1',
      PICKUP_HOURS: 'daily 9-17',
    });

    expect(env.DELIVERY_COUNTRIES).toEqual([]);
  });

  it.each([
    ['without an address', { PICKUP_HOURS: 'daily 9-17' }, 'PICKUP_ADDRESS'],
    ['without hours', { PICKUP_ADDRESS: 'Main street 1' }, 'PICKUP_HOURS'],
  ])('stop the start on a pickup %s', async (_name, values, key) => {
    expect(await messageOf({ DELIVERY_METHODS: 'pickup', ...values })).toBe(
      `Missing required env variable: ${key}`,
    );
  });

  it('stop the start on a pickup place of more than 300 characters', async () => {
    expect(
      await messageOf({
        DELIVERY_METHODS: 'pickup',
        PICKUP_ADDRESS: 'a'.repeat(301),
        PICKUP_HOURS: 'daily',
      }),
    ).toMatch(/^Invalid env variable: PICKUP_ADDRESS /);
  });
});
