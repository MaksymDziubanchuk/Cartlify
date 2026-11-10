import pino from 'pino';

import { loggerOptions } from '@config/logger.js';
import { loadShopSettings } from '@config/shopSettings.js';
import { prisma } from '@db/client.js';
import { failureOf } from '@helpers/failureOf.js';
import { closeRedis, connectRedis, isRedisReady } from '@redis/client.js';

import { runNewsletterPass } from './newsletterPass.job.js';

// The command that runs one pass of the newsletters and exits (`npm run newsletter:run`, built to
// dist/jobs/newsletterRun.js). The service of periodic tasks calls it on a schedule; until that exists
// it is run by hand. It starts nothing else of the server: no http, no workers. The exit code is 0
// when the pass ran (also when it found another one running, or had nothing to do), 1 when it could
// not do its work: redis or the database are out of reach, or the stream has a problem the pass
// stopped on (SendGrid refuses the key, a setting is missing: the log says which), so a schedule
// that shows the exit codes shows the run that needs a look.

// how long to wait for redis, which holds the lock of the pass
const REDIS_WAIT_MS = 5000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function run(): Promise<number> {
  const log = pino(loggerOptions());

  try {
    // the data of the shop (the language of the shop, its name, its logo), as the server reads it
    await loadShopSettings();

    await Promise.race([connectRedis(log).catch(() => undefined), sleep(REDIS_WAIT_MS)]);
    if (!isRedisReady()) {
      log.error('redis is unavailable, the pass of the newsletters does not run without its lock');
      return 1;
    }

    const summary = await runNewsletterPass({ log });
    return summary.reason === 'halted' ? 1 : 0;
  } catch (err) {
    log.error(failureOf(err), 'newsletter pass failed');
    return 1;
  } finally {
    await closeRedis().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

// the lines are written already (stdout is synchronous); a socket left open must not keep the process
process.exit(await run());
