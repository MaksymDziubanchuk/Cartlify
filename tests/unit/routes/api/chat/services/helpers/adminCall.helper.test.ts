import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// The mark of the button "call an admin" in redis. The answer of the bot never fails for it (every
// failure of redis is "no mark, no button"), the reads that only show the button go on without
// redis, and the route that gives the chat to the admins needs redis (REDIS_UNAVAILABLE). Redis is
// replaced here; the whole way through a real redis is in api/chat/callAdmin.test.ts
const redis = {
  set: jest.fn<(key: string, value: string, options: { EX: number }) => Promise<string | null>>(),
  del: jest.fn<(key: string) => Promise<number>>(),
  exists: jest.fn<(key: string) => Promise<number>>(),
};
const isRedisReady = jest.fn<() => boolean>();
const getRedis = jest.fn<() => Promise<typeof redis>>();

jest.unstable_mockModule('@redis/client.js', () => ({ getRedis, isRedisReady }));

const {
  ADMIN_CALL_TTL_SECONDS,
  isAdminCallOffered,
  offerAdminCall,
  readAdminCallOffer,
  withdrawAdminCall,
} = await import('@routes/api/chat/services/helpers/adminCall.helper.js');

const THREAD = '6f1f3a52-0d8e-4c6c-9a57-0a3a6c2f9b11';
const KEY = `chat:admin-call:${THREAD}`;

beforeEach(() => {
  redis.set.mockReset().mockResolvedValue('OK');
  redis.del.mockReset().mockResolvedValue(1);
  redis.exists.mockReset().mockResolvedValue(1);
  isRedisReady.mockReset().mockReturnValue(true);
  getRedis.mockReset().mockResolvedValue(redis);
});

describe('the mark of the button "call an admin"', () => {
  it('lasts 30 minutes', () => {
    expect(ADMIN_CALL_TTL_SECONDS).toBe(1800);
  });

  describe('offerAdminCall', () => {
    it('sets the mark of the chat for 30 minutes and says it is set', async () => {
      await expect(offerAdminCall(THREAD)).resolves.toBe(true);

      expect(redis.set).toHaveBeenCalledWith(KEY, '1', { EX: 1800 });
    });

    it('sets nothing and says so when redis is not ready', async () => {
      isRedisReady.mockReturnValue(false);

      await expect(offerAdminCall(THREAD)).resolves.toBe(false);

      expect(getRedis).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    // the answer of the bot is already written: a failure of redis must not turn it into an error
    it('says no mark when redis fails, and does not throw', async () => {
      redis.set.mockRejectedValue(new Error('Socket closed unexpectedly'));

      await expect(offerAdminCall(THREAD)).resolves.toBe(false);
    });

    it('says no mark when the connection cannot be taken', async () => {
      getRedis.mockRejectedValue(new Error('no connection'));

      await expect(offerAdminCall(THREAD)).resolves.toBe(false);
    });
  });

  describe('withdrawAdminCall', () => {
    it('takes the mark away and says there was one', async () => {
      await expect(withdrawAdminCall(THREAD)).resolves.toBe(true);

      expect(redis.del).toHaveBeenCalledWith(KEY);
    });

    // a turn that is answered by the model has nothing to tell the chat when there was no button
    it('says there was none when nothing was deleted', async () => {
      redis.del.mockResolvedValue(0);

      await expect(withdrawAdminCall(THREAD)).resolves.toBe(false);
    });

    it('says there was none when redis is not ready, and when it fails', async () => {
      isRedisReady.mockReturnValue(false);
      await expect(withdrawAdminCall(THREAD)).resolves.toBe(false);
      expect(redis.del).not.toHaveBeenCalled();

      isRedisReady.mockReturnValue(true);
      redis.del.mockRejectedValue(new Error('Socket closed unexpectedly'));
      await expect(withdrawAdminCall(THREAD)).resolves.toBe(false);
    });
  });

  describe('isAdminCallOffered', () => {
    it('says whether the chat has the mark', async () => {
      await expect(isAdminCallOffered(THREAD)).resolves.toBe(true);
      expect(redis.exists).toHaveBeenCalledWith(KEY);

      redis.exists.mockResolvedValue(0);
      await expect(isAdminCallOffered(THREAD)).resolves.toBe(false);
    });

    it('is false when redis is not ready, and when it fails, with no error', async () => {
      isRedisReady.mockReturnValue(false);
      await expect(isAdminCallOffered(THREAD)).resolves.toBe(false);
      expect(redis.exists).not.toHaveBeenCalled();

      isRedisReady.mockReturnValue(true);
      redis.exists.mockRejectedValue(new Error('Socket closed unexpectedly'));
      await expect(isAdminCallOffered(THREAD)).resolves.toBe(false);
    });
  });

  describe('readAdminCallOffer', () => {
    it('says whether the chat has the mark', async () => {
      await expect(readAdminCallOffer(THREAD)).resolves.toBe(true);
      expect(redis.exists).toHaveBeenCalledWith(KEY);

      redis.exists.mockResolvedValue(0);
      await expect(readAdminCallOffer(THREAD)).resolves.toBe(false);
    });

    // the route cannot guess: without redis the call is refused, not given or denied by chance
    it('stops with REDIS_UNAVAILABLE when redis fails', async () => {
      redis.exists.mockRejectedValue(new Error('Socket closed unexpectedly'));

      await expect(readAdminCallOffer(THREAD)).rejects.toMatchObject({
        statusCode: 503,
        errorCode: 'REDIS_UNAVAILABLE',
      });
    });

    it('stops with REDIS_UNAVAILABLE when redis is not ready, as it is', async () => {
      const { ServiceUnavailableError } = await import('@utils/errors.js');
      getRedis.mockRejectedValue(new ServiceUnavailableError('REDIS_UNAVAILABLE'));

      await expect(readAdminCallOffer(THREAD)).rejects.toMatchObject({
        statusCode: 503,
        errorCode: 'REDIS_UNAVAILABLE',
      });
    });
  });
});
