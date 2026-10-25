import { getRedis, isRedisReady } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';
import { ServiceUnavailableError, isAppError } from '@utils/errors.js';

// the cases of alerts an admin or root put aside, each one their own, in redis: a hash of the
// actor, a field <kind>:<id> with the time it was put aside. A case is aside only while its kind
// counts it; the reads of the alerts take the rest away. The hash lives DISMISSALS_TTL_SECONDS
// after its last change: a case put aside that long ago and still waiting alerts again

export type Dismissal = { kind: string; id: string; dismissedAt: string };

const DISMISSALS_TTL_SECONDS = 180 * 24 * 3600;

const keyOf = (userId: number) => `${redisKeys.adminAlertDismissalsPrefix}${userId}`;

export const dismissalFieldOf = (kind: string, id: string) => `${kind}:${id}`;

// a field is <kind>:<id>; a kind has no colon, an id of a case has none either
const dismissalOf = (field: string, dismissedAt: string): Dismissal | null => {
  const at = field.indexOf(':');
  if (at <= 0 || at === field.length - 1) return null;
  return { kind: field.slice(0, at), id: field.slice(at + 1), dismissedAt };
};

// report redis command failures to api callers as a stable 503
function toRedisUnavailableError(err: unknown): unknown {
  if (isAppError(err)) return err;

  return new ServiceUnavailableError('REDIS_UNAVAILABLE', undefined, err);
}

async function readAll(userId: number): Promise<Dismissal[]> {
  const redis = await getRedis();
  const fields = await redis.hGetAll(keyOf(userId));

  return Object.entries(fields)
    .map(([field, dismissedAt]) => dismissalOf(field, String(dismissedAt)))
    .filter((dismissal): dismissal is Dismissal => dismissal !== null);
}

// every case the actor put aside; REDIS_UNAVAILABLE without redis
export async function listDismissals(userId: number): Promise<Dismissal[]> {
  try {
    return await readAll(userId);
  } catch (err: unknown) {
    throw toRedisUnavailableError(err);
  }
}

// the same for counting the alerts, which go on without redis: null when redis cannot say
export async function readDismissals(userId: number): Promise<Dismissal[] | null> {
  if (!isRedisReady()) return null;

  try {
    return await readAll(userId);
  } catch {
    return null;
  }
}

// a case put aside again keeps the time it was put aside first
export async function putCaseAside(userId: number, kind: string, id: string): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.hSetNX(keyOf(userId), dismissalFieldOf(kind, id), new Date().toISOString());
    await redis.expire(keyOf(userId), DISMISSALS_TTL_SECONDS);
  } catch (err: unknown) {
    throw toRedisUnavailableError(err);
  }
}

export async function takeCaseBack(userId: number, kind: string, id: string): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.hDel(keyOf(userId), dismissalFieldOf(kind, id));
  } catch (err: unknown) {
    throw toRedisUnavailableError(err);
  }
}

// the marks of cases that are over (fields); a failure leaves them for the next read
export async function dropDismissals(userId: number, fields: string[]): Promise<void> {
  if (!fields.length || !isRedisReady()) return;

  try {
    const redis = await getRedis();
    await redis.hDel(keyOf(userId), fields);
  } catch {
    // the next read of the alerts drops them
  }
}
