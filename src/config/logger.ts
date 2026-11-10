import type { LoggerOptions, TransportSingleOptions } from 'pino';

import env from '@config/env.js';

// allow pino transport type
type LoggerOptionsWithTransport = LoggerOptions & { transport?: TransportSingleOptions };

// The logger config of the server (src/app.ts) and of the commands that run beside it (the pass of
// the newsletters, src/jobs/newsletterRun.ts): the same level, the same hidden headers, pretty lines
// while developing
export function loggerOptions(): LoggerOptionsWithTransport {
  // base logger config
  const options: LoggerOptionsWithTransport = {
    level: 'info',
    // hide sensitive headers
    redact: ['req.headers.authorization', 'request.headers.cookie', "res.headers['set-cookie']"],
  };

  // dev pretty logs
  if (env.NODE_ENV === 'development') {
    options.transport = {
      // pretty log options
      target: 'pino-pretty',
      options: { singleLine: true },
    };
  }

  return options;
}
