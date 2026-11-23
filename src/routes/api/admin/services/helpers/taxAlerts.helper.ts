import { getRedis, isRedisReady } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';

// What the alerts of the tax keep in redis (docs/taxes.md), shared by the server and its workers:
// - the sales a threshold stopped: the first time an order to a country was refused for the threshold
//   of its group in a period (a field a threshold, with the start of its period); a new period
//   starts it again;
// - the orders refused within the limit of a parcel: a count a country a day of the shop, 30 days
//   (the longest window), up to 1001 (more than 1000), counted only while a root follows the kind
//   with both numbers (a mark the writes of its settings keep);
// - what a person saw of a kind that only informs: a hash of the person, a field a kind with the
//   time of Close.
// Redis that cannot be asked changes nothing of the request a refusal comes from; the alerts say
// nothing of it then.

const DAY_SECONDS = 24 * 3600;
const PARCEL_TTL_SECONDS = 30 * DAY_SECONDS;
const PARCEL_CAP = 1001;
const STOPS_TTL_SECONDS = 400 * DAY_SECONDS;
const SEEN_TTL_SECONDS = 400 * DAY_SECONDS;

const parcelKey = (country: string, day: string) =>
  `${redisKeys.taxParcelRefusalsPrefix}${country}:${day}`;
const seenKey = (userId: number) => `${redisKeys.adminAlertSeenPrefix}${userId}`;

// an order to a country was refused for the threshold of its group: the first time of the period stays
export async function noteSalesStopped(
  threshold: string,
  periodStart: Date | null,
  at: Date,
): Promise<void> {
  if (!isRedisReady()) return;
  try {
    const redis = await getRedis();
    const period = periodStart ? periodStart.toISOString() : '';
    const raw = await redis.hGet(redisKeys.taxSalesStopped, threshold);
    const kept = raw ? (JSON.parse(raw) as { period: string; at: string }) : null;
    if (kept?.period === period) return;
    await redis.hSet(
      redisKeys.taxSalesStopped,
      threshold,
      JSON.stringify({ period, at: at.toISOString() }),
    );
    await redis.expire(redisKeys.taxSalesStopped, STOPS_TTL_SECONDS);
  } catch {
    // the alert waits for redis, the refusal goes on
  }
}

// the thresholds that stopped sales, each with the start of its period and the time; empty when
// redis cannot say. Never throws
export async function readSalesStopped(): Promise<Map<string, { period: string; at: Date }>> {
  const out = new Map<string, { period: string; at: Date }>();
  if (!isRedisReady()) return out;
  try {
    const redis = await getRedis();
    for (const [threshold, raw] of Object.entries(await redis.hGetAll(redisKeys.taxSalesStopped))) {
      const kept = JSON.parse(String(raw)) as { period: string; at: string };
      out.set(threshold, { period: kept.period, at: new Date(kept.at) });
    }
  } catch {
    return new Map();
  }
  return out;
}

// an order to the country refused within the limit of a parcel, on the day of the shop; counted only
// while a root follows the kind
export async function noteParcelRefusal(country: string, day: string): Promise<void> {
  if (!isRedisReady()) return;
  try {
    const redis = await getRedis();
    if ((await redis.get(redisKeys.taxParcelRefusalsOn)) !== '1') return;
    const key = parcelKey(country, day);
    // the count and its time to live in one step: a key is never left without its end
    await redis.multi().incr(key).expire(key, PARCEL_TTL_SECONDS).exec();
  } catch {
    // the alert waits for redis, the refusal goes on
  }
}

// whether the refusals are counted: some root follows the kind with both numbers
export async function setParcelRefusalsCounted(on: boolean): Promise<void> {
  if (!isRedisReady()) return;
  try {
    const redis = await getRedis();
    if (on) await redis.set(redisKeys.taxParcelRefusalsOn, '1');
    else await redis.del(redisKeys.taxParcelRefusalsOn);
  } catch {
    // the next write of the settings of the kind tries again
  }
}

// the refusals of each country on each of the days given (yyyy-mm-dd of the shop); empty when redis
// cannot say. Never throws
export async function readParcelRefusals(
  countries: readonly string[],
  days: readonly string[],
): Promise<Map<string, { day: string; count: number }[]>> {
  const out = new Map<string, { day: string; count: number }[]>();
  if (!isRedisReady() || !countries.length || !days.length) return out;
  try {
    const redis = await getRedis();
    for (const country of countries) {
      const keys = days.map((day) => parcelKey(country, day));
      const values = await redis.mGet(keys);
      const counted = days
        // the count stops at the cap: refusals at once may pass it by a few
        .map((day, i) => ({ day, count: Math.min(Number(values[i] ?? 0), PARCEL_CAP) }))
        .filter((entry) => entry.count > 0);
      if (counted.length) out.set(country, counted);
    }
  } catch {
    return new Map();
  }
  return out;
}

// the time a person closed each kind that only informs; null when redis cannot say. Never throws
export async function readSeen(userId: number): Promise<Map<string, Date> | null> {
  if (!isRedisReady()) return null;
  try {
    const redis = await getRedis();
    const fields = await redis.hGetAll(seenKey(userId));
    return new Map(Object.entries(fields).map(([kind, at]) => [kind, new Date(String(at))]));
  } catch {
    return null;
  }
}

// the person closed a kind that only informs at the time given
export async function writeSeen(userId: number, kind: string, at: Date): Promise<void> {
  const redis = await getRedis();
  await redis.hSet(seenKey(userId), kind, at.toISOString());
  await redis.expire(seenKey(userId), SEEN_TTL_SECONDS);
}
