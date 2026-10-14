import { describe, expect, it } from '@jest/globals';
import type { FastifyRequest } from 'fastify';

import requireRole from '@middlewares/requireRole.js';
import { ForbiddenError } from '@utils/errors.js';

import { rejectedBy } from '../../helpers/errors.js';

const requestAs = (user: unknown) => ({ user }) as unknown as FastifyRequest;

describe('requireRole', () => {
  const adminsOnly = requireRole(['ADMIN', 'ROOT']);

  it.each(['ADMIN', 'ROOT'])('lets a %s through', async (role) => {
    await expect(adminsOnly(requestAs({ id: 1, role }))).resolves.toBeUndefined();
  });

  it.each(['USER', 'GUEST'])('forbids a %s', async (role) => {
    const err = await rejectedBy(() => adminsOnly(requestAs({ id: 1, role })));

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({ statusCode: 403, errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('forbids a request without a user', async () => {
    await expect(adminsOnly(requestAs(undefined))).rejects.toMatchObject({
      errorCode: 'INSUFFICIENT_ROLE',
    });
  });

  it('forbids everyone when no role is allowed', async () => {
    await expect(requireRole([])(requestAs({ id: 1, role: 'ROOT' }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
