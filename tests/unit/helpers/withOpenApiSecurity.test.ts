import { describe, expect, it } from '@jest/globals';

import { withOpenApiSecurity, withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';

const cookieAuth = [{ cookieAuth: [] }];
const bearerAuth = [{ bearerAuth: [] }];

describe('withOpenApiSecurity', () => {
  it('adds the security to every schema that has none', () => {
    const out = withOpenApiSecurity({ list: { summary: 'list' }, get: {} }, cookieAuth);

    expect(out.list).toEqual({ summary: 'list', security: cookieAuth });
    expect(out.get).toEqual({ security: cookieAuth });
  });

  it('keeps a security that a schema already declares, including an empty public one', () => {
    const out = withOpenApiSecurity(
      { custom: { security: bearerAuth }, open: { security: [] } },
      cookieAuth,
    );

    expect(out.custom.security).toBe(bearerAuth);
    expect(out.open.security).toEqual([]);
  });

  it('does not change the schemas it was given', () => {
    const schemas = { list: { summary: 'list' } };

    withOpenApiSecurity(schemas, cookieAuth);

    expect(schemas.list).toEqual({ summary: 'list' });
  });
});

describe('withOpenApiSecurityFor', () => {
  it('adds the security only to the named schemas', () => {
    const out = withOpenApiSecurityFor({ list: {}, create: {}, remove: {} }, cookieAuth, [
      'create',
      'remove',
    ]);

    // the empty schemas are typed as {}, read the added field through a wider type
    const secured = out as Record<string, { security?: unknown }>;

    expect(out.list).toEqual({});
    expect(secured.create?.security).toBe(cookieAuth);
    expect(secured.remove?.security).toBe(cookieAuth);
  });

  it('keeps an existing security on a named schema', () => {
    const out = withOpenApiSecurityFor({ create: { security: bearerAuth } }, cookieAuth, [
      'create',
    ]);

    expect(out.create.security).toBe(bearerAuth);
  });
});
