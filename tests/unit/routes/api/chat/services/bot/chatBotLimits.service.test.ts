import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import env from '@config/env.js';
import { addressKeyOf, botLimits } from '@routes/api/chat/services/bot/chatBotLimits.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let ipLimit: number;
let shopLimit: number;

beforeEach(() => {
  ipLimit = env.CHAT_BOT_IP_DAILY_TURNS;
  shopLimit = env.CHAT_BOT_SHOP_DAILY_TURNS;
  botLimits.reset();
});

afterEach(() => {
  env.CHAT_BOT_IP_DAILY_TURNS = ipLimit;
  env.CHAT_BOT_SHOP_DAILY_TURNS = shopLimit;
  jest.useRealTimers();
});

describe('addressKeyOf', () => {
  it('keeps an IPv4 address as it is', () => {
    expect(addressKeyOf('203.0.113.7')).toBe('v4:203.0.113.7');
  });

  it('reads an IPv4-mapped IPv6 address as the IPv4 address', () => {
    expect(addressKeyOf('::ffff:203.0.113.7')).toBe(addressKeyOf('203.0.113.7'));
    expect(addressKeyOf('::FFFF:203.0.113.7')).toBe(addressKeyOf('203.0.113.7'));
  });

  // a subscriber has a whole /64 and takes any address of it
  it('names an IPv6 address by its network, the first 64 bits', () => {
    const key = addressKeyOf('2001:db8:85a3:8d3:1319:8a2e:370:7344');

    expect(key).toBe('v6:2001:0db8:85a3:08d3');
    expect(addressKeyOf('2001:db8:85a3:8d3:ffff:ffff:ffff:ffff')).toBe(key);
    expect(addressKeyOf('2001:DB8:85A3:8D3::1')).toBe(key);
    expect(addressKeyOf('2001:db8:85a3:8d4::1')).not.toBe(key);
  });

  it('expands the shortened forms before it takes the network', () => {
    expect(addressKeyOf('::1')).toBe('v6:0000:0000:0000:0000');
    expect(addressKeyOf('2001:db8::1')).toBe('v6:2001:0db8:0000:0000');
    expect(addressKeyOf('fe80::1%eth0')).toBe('v6:fe80:0000:0000:0000');
  });

  it('has no key for an address the request does not have', () => {
    expect(addressKeyOf(null)).toBeNull();
    expect(addressKeyOf(undefined)).toBeNull();
    expect(addressKeyOf('  ')).toBeNull();
  });
});

describe('botLimits.takeAddressTurn', () => {
  it('lets an address have its turns of the day and refuses the next one', () => {
    env.CHAT_BOT_IP_DAILY_TURNS = 3;

    const taken = [1, 2, 3, 4, 5].map(() => botLimits.takeAddressTurn('203.0.113.7'));

    expect(taken).toEqual([true, true, true, false, false]);
  });

  it('counts each address on its own', () => {
    env.CHAT_BOT_IP_DAILY_TURNS = 1;

    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(true);
    expect(botLimits.takeAddressTurn('203.0.113.8')).toBe(true);
    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(false);
  });

  it('counts the addresses of one IPv6 network as one', () => {
    env.CHAT_BOT_IP_DAILY_TURNS = 2;

    expect(botLimits.takeAddressTurn('2001:db8:1:1::1')).toBe(true);
    expect(botLimits.takeAddressTurn('2001:db8:1:1::2')).toBe(true);
    expect(botLimits.takeAddressTurn('2001:db8:1:1:aaaa::3')).toBe(false);
  });

  it('counts nothing for a request without an address', () => {
    env.CHAT_BOT_IP_DAILY_TURNS = 1;

    for (let i = 0; i < 5; i += 1) expect(botLimits.takeAddressTurn(null)).toBe(true);
  });

  // the day starts with the first turn of the address, not at midnight
  it('starts the day of an address again 24 hours after its first turn', () => {
    jest.useFakeTimers({ now: new Date('2026-11-01T10:00:00Z') });
    env.CHAT_BOT_IP_DAILY_TURNS = 2;

    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(true);
    jest.setSystemTime(Date.now() + DAY_MS - 1_000);
    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(true);
    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(false);

    jest.setSystemTime(Date.now() + 1_000);
    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(true);
    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(true);
    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(false);
  });

  it('reads the limit on each turn, so a changed setting counts at once', () => {
    env.CHAT_BOT_IP_DAILY_TURNS = 1;
    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(true);
    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(false);

    env.CHAT_BOT_IP_DAILY_TURNS = 5;
    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(true);
  });
});

describe('botLimits.takeShopTurn', () => {
  it('lets the shop have its turns of the day and refuses the next one', () => {
    env.CHAT_BOT_SHOP_DAILY_TURNS = 2;

    expect([1, 2, 3, 4].map(() => botLimits.takeShopTurn())).toEqual([true, true, false, false]);
  });

  it('counts the addresses apart from the shop', () => {
    env.CHAT_BOT_SHOP_DAILY_TURNS = 1;
    env.CHAT_BOT_IP_DAILY_TURNS = 1;

    expect(botLimits.takeShopTurn()).toBe(true);
    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(true);
    expect(botLimits.takeShopTurn()).toBe(false);
    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(false);
  });

  it('starts the day of the shop again 24 hours after its first turn', () => {
    jest.useFakeTimers({ now: new Date('2026-11-01T10:00:00Z') });
    env.CHAT_BOT_SHOP_DAILY_TURNS = 1;

    expect(botLimits.takeShopTurn()).toBe(true);
    expect(botLimits.takeShopTurn()).toBe(false);

    jest.setSystemTime(Date.now() + DAY_MS);
    expect(botLimits.takeShopTurn()).toBe(true);
  });

  it('forgets every count when it is reset', () => {
    env.CHAT_BOT_SHOP_DAILY_TURNS = 1;
    env.CHAT_BOT_IP_DAILY_TURNS = 1;
    botLimits.takeShopTurn();
    botLimits.takeAddressTurn('203.0.113.7');

    botLimits.reset();

    expect(botLimits.takeShopTurn()).toBe(true);
    expect(botLimits.takeAddressTurn('203.0.113.7')).toBe(true);
  });
});
