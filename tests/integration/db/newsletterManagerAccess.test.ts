import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { isNewsletterManager } from '@db/newsletterManager.helper.js';

import { testTx } from '../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';
import { giveNewsletterRight } from '../../helpers/newsletterManager.js';

// the question the guard of the newsletter routes asks the database at every request: may this
// account, with the role its token names, run the newsletters? The answer is the function of the
// database (newsletter_manager), read in the context of the account

let root: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  root = await newUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await prisma.$disconnect();
  }
});

// root changes an account the way its routes do, in the context of root
const asRoot = (fn: Parameters<typeof testTx>[0]) =>
  testTx(async (tx) => {
    await setUserContext(tx, { userId: root.id, role: 'ROOT' });
    return fn(tx);
  });

describe('isNewsletterManager', () => {
  it('is true for root', async () => {
    expect(await isNewsletterManager({ userId: root.id, role: 'ROOT' })).toBe(true);
  });

  it('is false for an admin root did not allow', async () => {
    const admin = await newUser({ role: 'ADMIN' });

    expect(await isNewsletterManager({ userId: admin.id, role: 'ADMIN' })).toBe(false);
  });

  it('is true for an admin root allowed', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    await giveNewsletterRight(root.id, admin.id);

    expect(await isNewsletterManager({ userId: admin.id, role: 'ADMIN' })).toBe(true);
  });

  // the right is read at every call: what root does works at once, with no session to renew
  it('follows the right as root gives it and takes it away', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const ask = () => isNewsletterManager({ userId: admin.id, role: 'ADMIN' });

    expect(await ask()).toBe(false);
    await giveNewsletterRight(root.id, admin.id);
    expect(await ask()).toBe(true);
    await asRoot(
      (tx) => tx.$executeRaw`select cartlify.newsletter_set_manager(${admin.id}::int, false)`,
    );
    expect(await ask()).toBe(false);
  });

  it('is false for a user', async () => {
    const user = await newUser();

    expect(await isNewsletterManager({ userId: user.id, role: 'USER' })).toBe(false);
  });

  // an old token still names the role the account had: the database knows the role it has now
  it('is false for an account that was an admin when its token was made and is not any more', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    await giveNewsletterRight(root.id, admin.id);
    await asRoot((tx) => tx.user.update({ where: { id: admin.id }, data: { role: 'USER' } }));

    expect(await isNewsletterManager({ userId: admin.id, role: 'ADMIN' })).toBe(false);
  });

  it('is false for an admin whose account was deleted', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    await giveNewsletterRight(root.id, admin.id);
    await asRoot((tx) =>
      tx.user.update({ where: { id: admin.id }, data: { deletedAt: new Date() } }),
    );

    expect(await isNewsletterManager({ userId: admin.id, role: 'ADMIN' })).toBe(false);
  });

  it('is false for an account that does not exist', async () => {
    expect(await isNewsletterManager({ userId: 2147483647, role: 'ADMIN' })).toBe(false);
  });
});
