import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { FastifyRequest } from 'fastify';

import { ForbiddenError } from '@utils/errors.js';

import { rejectedBy } from '../../helpers/errors.js';

// the database is replaced: the guard asks it, at every request, whether the account may handle the
// money (the real question is in tests/integration/db/moneyManager.test.ts)
const askMock = jest.fn<(actor: { userId: number; role: string }) => Promise<boolean>>();

jest.unstable_mockModule('@db/moneyManager.helper.js', () => ({
  isMoneyManager: askMock,
}));

const { default: requireMoneyManager } = await import('@middlewares/requireMoneyManager.js');

const requestAs = (user: unknown) => ({ user }) as unknown as FastifyRequest;

beforeEach(() => {
  askMock.mockReset();
});

describe('requireMoneyManager', () => {
  it('lets root through without asking the database', async () => {
    await expect(requireMoneyManager(requestAs({ id: 1, role: 'ROOT' }))).resolves.toBeUndefined();

    expect(askMock).not.toHaveBeenCalled();
  });

  it('lets an admin through when the database says root allowed the account', async () => {
    askMock.mockResolvedValue(true);

    await expect(requireMoneyManager(requestAs({ id: 7, role: 'ADMIN' }))).resolves.toBeUndefined();

    expect(askMock).toHaveBeenCalledTimes(1);
    expect(askMock).toHaveBeenCalledWith({ userId: 7, role: 'ADMIN' });
  });

  it('refuses an admin the database does not allow, with MONEY_MANAGER_REQUIRED', async () => {
    askMock.mockResolvedValue(false);

    const err = await rejectedBy(() => requireMoneyManager(requestAs({ id: 7, role: 'ADMIN' })));

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({ statusCode: 403, errorCode: 'MONEY_MANAGER_REQUIRED' });
  });

  // the answer of the database is read again at every request: the right taken away stops at once
  it('asks at every request and follows the answer of the moment', async () => {
    const admin = requestAs({ id: 7, role: 'ADMIN' });
    askMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(requireMoneyManager(admin)).resolves.toBeUndefined();
    await expect(requireMoneyManager(admin)).rejects.toMatchObject({
      errorCode: 'MONEY_MANAGER_REQUIRED',
    });
    await expect(requireMoneyManager(admin)).resolves.toBeUndefined();

    expect(askMock).toHaveBeenCalledTimes(3);
  });

  // the token names the role and nothing of the right: a claim of the right put into the user of the
  // request means nothing
  it('ignores a right the user of the request claims', async () => {
    askMock.mockResolvedValue(false);

    const err = await rejectedBy(() =>
      requireMoneyManager(requestAs({ id: 7, role: 'ADMIN', canManageMoney: true })),
    );

    expect(err).toMatchObject({ errorCode: 'MONEY_MANAGER_REQUIRED' });
  });

  it.each(['USER', 'GUEST'])('refuses a %s without asking the database', async (role) => {
    const err = await rejectedBy(() => requireMoneyManager(requestAs({ id: 5, role })));

    expect(err).toMatchObject({ statusCode: 403, errorCode: 'MONEY_MANAGER_REQUIRED' });
    expect(askMock).not.toHaveBeenCalled();
  });

  it('refuses a request without a user', async () => {
    const err = await rejectedBy(() => requireMoneyManager(requestAs(undefined)));

    expect(err).toMatchObject({ errorCode: 'MONEY_MANAGER_REQUIRED' });
    expect(askMock).not.toHaveBeenCalled();
  });

  it('refuses an admin whose id is no account id, without asking the database', async () => {
    const err = await rejectedBy(() =>
      requireMoneyManager(requestAs({ id: 'not-a-number', role: 'ADMIN' })),
    );

    expect(err).toMatchObject({ errorCode: 'MONEY_MANAGER_REQUIRED' });
    expect(askMock).not.toHaveBeenCalled();
  });

  it('passes on a failure of the database instead of letting the request through', async () => {
    askMock.mockRejectedValue(new Error('database down'));

    await expect(requireMoneyManager(requestAs({ id: 7, role: 'ADMIN' }))).rejects.toThrow(
      'database down',
    );
  });
});
