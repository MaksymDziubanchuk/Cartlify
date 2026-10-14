import { describe, expect, it } from '@jest/globals';

import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError, ForbiddenError } from '@utils/errors.js';

import { thrownBy } from '../../helpers/errors.js';

import type { Role } from 'types/user.js';

describe('assertAdminActor', () => {
  it.each<Role>(['ADMIN', 'ROOT'])('lets an %s through', (role) => {
    expect(() => assertAdminActor(10, role)).not.toThrow();
  });

  it.each<Role>(['USER', 'GUEST'])('forbids a %s', (role) => {
    const err = thrownBy(() => assertAdminActor(10, role));

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({ statusCode: 403, errorCode: 'FORBIDDEN_ROLE' });
  });

  it.each([
    ['a numeric string', '10'],
    ['a fraction', 1.5],
    ['a guest uuid', '7f6c0c8e-4b9b-4c55-9d2c-0f0e7b0b1a11'],
    ['undefined', undefined],
  ])('rejects the actor id when it is %s, even for an admin', (_case, actorId) => {
    const err = thrownBy(() => assertAdminActor(actorId, 'ADMIN'));

    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ errorCode: 'ACTOR_ID_INVALID' });
  });
});
