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

describe('GET /static/*', () => {
  // the frontend lives on another origin, an <img> there needs the api to allow it
  it('lets pages of other origins show a public image', async () => {
    const res = await app.inject({ method: 'GET', url: '/static/images/logo3.png' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('keeps the api answers to its own origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});
