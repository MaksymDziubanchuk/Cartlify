import type { FastifyInstance } from 'fastify';

import env from '@config/env.js';

import settings from '../../../../package.json' with { type: 'json' };
import { systemSchemas } from './system.schemas.js';

export default async function getProjectInfoRouter(app: FastifyInstance) {
  app.get(
    '/',
    {
      schema: systemSchemas.infoSchema,
    },
    async () => {
      return {
        name: settings.name,
        version: settings.version,
        env: env.NODE_ENV,
      };
    },
  );
}