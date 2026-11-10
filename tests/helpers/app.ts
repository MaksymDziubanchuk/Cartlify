import type { FastifyInstance } from 'fastify';
import { SerializerSelector } from '@fastify/fast-json-stringify-compiler';

import { app } from '../../src/app.js';
import { loadShopSettings } from '@config/shopSettings.js';
import { connectRedis, closeRedis } from '@redis/client.js';
import { prisma } from '@db/client.js';

import { captureLogs } from './logs.js';
import { installContractCheck } from './contract.js';
import { applyTestShopSettingsBaseline, INTEGRATION_SHOP_BASELINE } from './shopSettings.js';

// the server builds a serializer for every answer of every route when it starts, about 3 s of
// every test file; a file calls a few routes, so here each one is built on its first use. It is
// the compiler fastify uses, with the same shared schemas, so an answer is the same; the start
// the way the server does it (serializers: 'all') is checked in system/startup.test.ts
function buildSerializersOnFirstUse(instance: FastifyInstance): void {
  const buildCompiler = SerializerSelector();

  instance.setSerializerCompiler((routeSchema) => {
    let serialize: ((data: unknown) => string) | undefined;

    return (data: unknown) => {
      // src/app.ts sets no serializerOpts, fastify passes none either
      const compile = buildCompiler(instance.getSchemas());
      serialize ??= compile(routeSchema as Parameters<typeof compile>[0]) as (
        data: unknown,
      ) => string;
      return serialize(data);
    };
  });
}

// start the app the way src/index.ts does, without the http listener and the order timeout worker;
// every test file gets its own module registry, so its own app instance
export async function startApp(
  opts: { serializers?: 'on-first-use' | 'all' } = {},
): Promise<FastifyInstance> {
  // request logs are noise in test output, TEST_LOG_LEVEL=info brings them back
  app.log.level = process.env.TEST_LOG_LEVEL ?? 'warn';
  // the lines go to the tests, which check the expected ones (tests/helpers/logs.ts)
  captureLogs(app.log);

  if ((opts.serializers ?? 'on-first-use') === 'on-first-use') buildSerializersOnFirstUse(app);

  // every answer is held against the swagger document (tests/helpers/contract.ts)
  installContractCheck(app);

  await connectRedis(app.log);
  // the test database of every integration file starts without a row (tests/setup): this fills
  // in the server's defaults the same way src/index.ts does, so routes that read shopSettings()
  // have something to read
  await loadShopSettings();
  // the server defaults alone give no delivery and no seller; the shop every integration test
  // starts with (tests/helpers/shopSettings.ts)
  applyTestShopSettingsBaseline(INTEGRATION_SHOP_BASELINE);
  await app.ready();

  return app;
}

// close everything startApp opened, so jest exits without open handles
export async function stopApp(): Promise<void> {
  await app.close();
  await closeRedis();
  await prisma.$disconnect();
}
