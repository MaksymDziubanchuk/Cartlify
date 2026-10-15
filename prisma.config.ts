import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// prisma 7 takes the connection urls for the cli (migrate, db pull) from here, not from
// schema.prisma, and loads no .env by itself. Migrations run with DATABASE_URL: the workflows
// and the test database build pass the owner role there.
// process.env, not env() from prisma/config: env() throws on a missing variable, and
// `prisma generate` in postinstall runs where no database url is set (ci)
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    shadowDatabaseUrl: process.env.DEV_SHADOW_DATABASE_URL,
  },
});
