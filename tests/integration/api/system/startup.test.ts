import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';

// the other test files build the serializer of an answer on its first use (tests/helpers/app.ts);
// the server builds all of them when it starts, and a response schema that cannot be built stops
// the start. This file starts the app that way

let app: FastifyInstance;

beforeAll(async () => {
  app = await startApp({ serializers: 'all' });
});

afterAll(async () => {
  await stopApp();
});

describe('the start of the server', () => {
  it('builds a serializer for every answer of every route', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
  });
});
