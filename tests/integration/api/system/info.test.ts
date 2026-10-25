import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import settings from '../../../../package.json' with { type: 'json' };

import { startApp, stopApp } from '../../../helpers/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  await stopApp();
});

describe('GET /info', () => {
  it('names the project, its version and the environment it runs in', async () => {
    const res = await app.inject({ method: 'GET', url: '/info' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: settings.name, version: settings.version, env: 'test' });
  });
});
