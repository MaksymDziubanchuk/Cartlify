import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  await stopApp();
});

describe('GET /health', () => {
  it('returns ok with redis features available when redis is connected', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      env: 'test',
      redis: 'ready',
      features: {
        orderConfirmation: 'available',
        checkout: 'available',
        orderTimeoutQueue: 'running',
      },
    });
  });

  // the pulse of the reservation worker: an old time means it stopped; the tests do not start it
  it('tells when the reservation worker last ran and how many jobs wait', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.json().orderTimeoutWorker).toEqual({ lastRunAt: null, queued: expect.any(Number) });
  });
});

describe('GET /ready', () => {
  it('returns ok when the database and redis both answer', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', checks: { db: 'ok', cache: 'ok' } });
  });
});
