import env from '@config/env.js';

// The limits of the bot that no cookie or chat resets. The limit of a guest by its guest id alone is
// void: a new cookie is a new guest. So a customer who is no confirmed account (a guest, or a user
// who has not confirmed the email) is counted by the address too, and the whole shop has a ceiling
// of turns a day that no number of addresses lifts. Each turn that reaches the model is a paid call.
// The counts live in the memory of this copy of the server, as those of requestLimits.ts do; with
// several copies they move to redis. A restart forgets them.

const DAY_MS = 24 * 60 * 60 * 1000;

// how many requests go by before the counts that are over are cleared
const SWEEP_EVERY = 1000;

// the most keys kept: a script that comes from a new address each time cannot grow the memory
const MAX_KEYS = 100_000;

const SHOP_KEY = 'shop';

// the turns of each key in a window of a day that starts with its first turn
class TurnCounter {
  private windows = new Map<string, { count: number; resetAt: number }>();
  private calls = 0;

  // counts one more turn of the key; false once the key is past `max` turns in its day
  take(key: string, max: number, now = Date.now()): boolean {
    if ((this.calls += 1) % SWEEP_EVERY === 0) this.sweep(now);

    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      if (!window && this.windows.size >= MAX_KEYS) this.makeRoom(now);

      window = { count: 0, resetAt: now + DAY_MS };
      this.windows.set(key, window);
    }

    window.count += 1;
    return window.count <= max;
  }

  clear(): void {
    this.windows.clear();
    this.calls = 0;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }

  // the days that are over go first, then the key that came first
  private makeRoom(now: number): void {
    this.sweep(now);
    if (this.windows.size < MAX_KEYS) return;

    const oldest = this.windows.keys().next();
    if (!oldest.done) this.windows.delete(oldest.value);
  }
}

// an IPv6 address as its network of a customer: the first 4 of the 8 groups, the /64 a provider gives
// one subscriber, who can take any address of it
function ipv6NetworkOf(address: string): string {
  const [head = '', tail = ''] = address.split('::');
  const hasGap = address.includes('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = hasGap && tail ? tail.split(':') : [];
  const gap = hasGap
    ? Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0')
    : [];

  return [...headGroups, ...gap, ...tailGroups]
    .slice(0, 4)
    .map((group) => group.padStart(4, '0'))
    .join(':');
}

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

// what the count of an address is kept under: an IPv4 address as it is (an IPv4-mapped IPv6 one
// too), an IPv6 address by its network; null for an address the request has not
export function addressKeyOf(ip: string | null | undefined): string | null {
  const address = ip?.trim().toLowerCase().split('%')[0];
  if (!address) return null;

  const mapped = IPV4_MAPPED.exec(address);
  if (mapped) return `v4:${mapped[1]}`;

  return address.includes(':') ? `v6:${ipv6NetworkOf(address)}` : `v4:${address}`;
}

const addresses = new TurnCounter();
const shop = new TurnCounter();

export const botLimits = {
  // one more turn of a customer who is no confirmed account, from the address; false past
  // CHAT_BOT_IP_DAILY_TURNS in the day. A request with no address has nothing to count
  takeAddressTurn(ip: string | null | undefined): boolean {
    const key = addressKeyOf(ip);
    return key === null ? true : addresses.take(key, env.CHAT_BOT_IP_DAILY_TURNS);
  },

  // one more turn of the whole shop that is to call the model; false past CHAT_BOT_SHOP_DAILY_TURNS
  // in the day
  takeShopTurn(): boolean {
    return shop.take(SHOP_KEY, env.CHAT_BOT_SHOP_DAILY_TURNS);
  },

  // forgets every count (a test starts from none)
  reset(): void {
    addresses.clear();
    shop.clear();
  },
};
