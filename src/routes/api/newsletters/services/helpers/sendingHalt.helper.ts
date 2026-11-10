import { getRedis, isRedisReady } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';

// The mark of the last stop of the sending worker: the pass of the newsletters (a command of its own,
// run by a cron of the host, not the server) stops when the whole stream has a problem (the key of the
// provider is refused, a setting is missing, ten mails in a row are refused or find the provider
// busy), and the alert "the sending worker stopped" tells the admins who run the newsletters. The pass
// and the server share only redis, so the mark lives there: one key, the time of the last stop and
// why. A pass that goes through takes the mark away (the problem is over), a new stop writes over it
// (the time is the last one). It lives SENDING_HALT_TTL_SECONDS at most, so a mark nobody ever clears
// (the cron was taken away) does not alert for ever.

export type SendingHalt = {
  at: Date;
  why: string;
};

const SENDING_HALT_TTL_SECONDS = 30 * 24 * 3600;

// writes the stop; throws when redis cannot be asked (the pass logs it and goes on)
export async function markSendingHalted(why: string, at: Date): Promise<void> {
  const redis = await getRedis();
  await redis.set(redisKeys.newsletterSendingHalt, JSON.stringify({ at: at.toISOString(), why }), {
    EX: SENDING_HALT_TTL_SECONDS,
  });
}

// takes the mark away; throws when redis cannot be asked
export async function clearSendingHalt(): Promise<void> {
  const redis = await getRedis();
  await redis.del(redisKeys.newsletterSendingHalt);
}

// The last stop, or null: none, a value that is no stop, or redis cannot say (the alerts go on without
// redis). Never throws.
export async function readSendingHalt(): Promise<SendingHalt | null> {
  if (!isRedisReady()) return null;

  try {
    const redis = await getRedis();
    const raw = await redis.get(redisKeys.newsletterSendingHalt);
    if (!raw) return null;

    const value = JSON.parse(raw) as { at?: unknown; why?: unknown } | null;
    if (typeof value?.at !== 'string' || typeof value.why !== 'string') return null;

    const at = new Date(value.at);
    return Number.isNaN(at.getTime()) ? null : { at, why: value.why };
  } catch {
    return null;
  }
}
