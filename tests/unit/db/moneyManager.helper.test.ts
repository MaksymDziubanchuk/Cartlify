import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// the database is replaced by a transaction that records what is asked of it: the context the
// question is asked in, and the question itself
const queryMock =
  jest.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>>();
const contextMock =
  jest.fn<(db: unknown, args: { userId: number; role: string }) => Promise<void>>();
const order: string[] = [];

jest.unstable_mockModule('@db/client.js', () => ({
  tx: async (fn: (db: unknown) => Promise<unknown>) => fn({ $queryRaw: queryMock }),
}));
jest.unstable_mockModule('@db/dbContext.service.js', () => ({
  setUserContext: contextMock,
}));

const { isMoneyManager } = await import('@db/moneyManager.helper.js');

beforeEach(() => {
  queryMock.mockReset();
  contextMock.mockReset();
  order.length = 0;
  contextMock.mockImplementation(async () => {
    order.push('context');
  });
  queryMock.mockImplementation(async () => {
    order.push('question');
    return [{ allowed: true }];
  });
});

describe('isMoneyManager', () => {
  it('asks the function of the database in the context of the account, after setting it', async () => {
    const allowed = await isMoneyManager({ userId: 7, role: 'ADMIN' });

    expect(allowed).toBe(true);
    expect(order).toEqual(['context', 'question']);
    expect(contextMock).toHaveBeenCalledWith(expect.anything(), { userId: 7, role: 'ADMIN' });
    const [strings] = queryMock.mock.calls[0]!;
    expect(strings.join('?')).toContain('cartlify.money_manager()');
  });

  it('is what the database says: false is false', async () => {
    queryMock.mockResolvedValue([{ allowed: false }]);

    expect(await isMoneyManager({ userId: 7, role: 'ADMIN' })).toBe(false);
  });

  it.each([[[]], [[{ allowed: null }]], [[{ allowed: 'yes' }]]])(
    'is false when the database gives %j: only a plain true allows',
    async (rows) => {
      queryMock.mockResolvedValue(rows);

      expect(await isMoneyManager({ userId: 7, role: 'ADMIN' })).toBe(false);
    },
  );
});
