import { app } from './app.js';
import env from './config/env.js';

const protocol = env.NODE_ENV === 'production' ? 'https' : 'http';

app
  .listen({ port: env.PORT, host: env.HOST })
  .then(() => {
    app.log.info(`Server is running on: ${protocol}://${env.HOST}:${env.PORT}`);
  })
  .catch((error: any) => {
    app.log.error(error);
    process.exit(1);
  });

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, async () => {
    try {
      app.log.info(`Received ${sig}, shutting down...`);
      await app.close();

      if (typeof (app.log as any).flush === 'function') {
        (app.log as any).flush();
      }

      process.exit(0);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  });
});
