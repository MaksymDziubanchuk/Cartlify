import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import notFoundHandler from '@middlewares/notFoundHandler.js';

const app = fastify({ logger: false });

beforeAll(async () => {
  app.get('/exists', async () => ({ ok: true }));
  // registered the same way as in src/app.ts
  app.register(notFoundHandler);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('notFoundHandler', () => {
  it('answers an unknown route with 404 and says which request it was', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/nope?x=1' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 404, method: 'DELETE', url: '/nope?x=1' });
  });

  it('does not touch existing routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/exists' });

    expect(res.statusCode).toBe(200);
  });

  // every other api error carries errorCode, clients branch on it
  it('uses the same error shape as other api errors', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });

    expect(res.json()).toMatchObject({
      code: 404,
      errorCode: 'ROUTE_NOT_FOUND',
      message: 'Not Found',
      reqId: expect.any(String),
    });
  });
});
