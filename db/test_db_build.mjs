// builds a throwaway test database from scratch inside docker
// usage: node db/test_db_build.mjs up | down  (npm run db:test:up / db:test:down)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = 'docker-compose.test.yml';

// local container address, must match docker-compose.test.yml
const DB = { host: '127.0.0.1', port: 54329, name: 'cartlify_test' };
const REDIS = { host: '127.0.0.1', port: 63799 };

// throwaway passwords: roles get them only inside the test container
const ROLES = ['cartlify_owner', 'cartlify_app', 'cartlify_readonly'];

const dbUrl = (role) =>
  `postgresql://${role}:${role}@${DB.host}:${DB.port}/${DB.name}?schema=cartlify`;

// keep docker compose away from the project .env: it holds real credentials
const baseEnv = { ...process.env, COMPOSE_DISABLE_ENV_FILE: '1' };

// run one step and stop the whole build on the first failure
function run(title, command, args, extraEnv = {}, input) {
  console.log(`\n== ${title}`);

  const res = spawnSync(command, args, {
    cwd: rootDir,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    env: { ...baseEnv, ...extraEnv },
    ...(input === undefined ? {} : { input }),
  });

  if (res.error) {
    console.error(`\ncannot start "${command}": ${res.error.message}`);
    process.exit(1);
  }

  if (res.status !== 0) {
    console.error(`\ntest database build failed at step: ${title}`);
    process.exit(res.status ?? 1);
  }
}

const compose = (...args) => ['compose', '-f', composeFile, ...args];

// psql runs inside the container as superuser, the same way db/01 and db/02 need it
const psql = (...args) =>
  compose(
    'exec',
    '-T',
    // hide notices like "policy does not exist, skipping" on a fresh database
    '-e',
    'PGOPTIONS=--client-min-messages=warning',
    'postgres',
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
    '-U',
    'postgres',
    '-d',
    DB.name,
    ...args,
  );

// feed the script through stdin with unix line endings: a windows checkout has crlf,
// and function bodies would differ from the ones created on railway from a linux runner
function sqlFile(file) {
  const sql = readFileSync(path.join(rootDir, 'db', file), 'utf8').replace(/\r\n/g, '\n');

  run(file, 'docker', psql('-f', '-'), {}, sql);
}

function down() {
  // remove containers together with their data
  run('remove test containers', 'docker', compose('down', '-v', '--remove-orphans'));
}

function up() {
  // always start from an empty database
  down();
  run('start postgres and redis', 'docker', compose('up', '-d', '--wait'));

  // roles and schema must exist before prisma creates tables
  sqlFile('01_roles_and_schemas.sql');

  run(
    'set container passwords for roles',
    'docker',
    psql('-c', ROLES.map((role) => `ALTER ROLE ${role} PASSWORD '${role}';`).join(' ')),
  );

  // tables are created by the owner role, the same way migrations run on railway
  run(
    'prisma migrate deploy',
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    { DATABASE_URL: dbUrl('cartlify_owner') },
  );

  // search index in db/02 needs the products table
  sqlFile('02_extensions.sql');

  // policies in db/03 call functions from db/05
  sqlFile('05_fn_and_triggers.sql');
  sqlFile('03_policies_and_rls.sql');
  sqlFile('04_views.sql');
  sqlFile('06_indexes_and_constraints.sql');

  // rerun: grants for the migration table and functions created after the first run
  sqlFile('01_roles_and_schemas.sql');

  // the built database must match the saved reference (db/structure_snapshot.txt)
  run('compare structure with the reference', process.execPath, [
    'db/structure_snapshot.mjs',
    'check',
  ]);

  console.log('\ntest database is ready');
  console.log(`  DATABASE_URL=${dbUrl('cartlify_app')}`);
  console.log(`  REDIS_URL=redis://${REDIS.host}:${REDIS.port}`);
}

const command = process.argv[2];

if (command === 'up') up();
else if (command === 'down') down();
else {
  console.error('usage: node db/test_db_build.mjs up | down');
  process.exit(1);
}
