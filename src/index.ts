import { app } from './app.js';
import env from './config/env.js';

// pick protocol for log url
const protocol = env.NODE_ENV === 'production' ? 'https' : 'http';

// start server listener
app
  .listen({ port: env.PORT, host: env.HOST })
  .then(() => {
    // log server address
    app.log.info(`Server is running on: ${protocol}://${env.HOST}:${env.PORT}`);
  })
  // crash on bind failure
  .catch((error: any) => {
    app.log.error(error);
    process.exit(1);
  });

// handle shutdown signals
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, async () => {
    // close server gracefully
    try {
      app.log.info(`Received ${sig}, shutting down...`);
      await app.close();

      // flush logs before exit
      if (typeof (app.log as any).flush === 'function') {
        (app.log as any).flush();
      }

      process.exit(0);
      // exit with failure on error
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  });
});
