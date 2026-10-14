// builds a throwaway test database from scratch inside docker
// usage: node db/tools/test_db_build.mjs up | down [--verbose]  (npm run db:test:up / db:test:down)
// docker steps always print their output, the database preparation steps run behind one
// progress line and print their output only when they fail or with --verbose
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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

const verbose = process.argv.includes('--verbose');

// a progress line can be redrawn in place only in a terminal, ci logs get one line per step
const interactive = process.stdout.isTTY === true;

// number of prepare() calls in up(), keep in sync when adding a step
const PREPARE_STEPS = 10;
let preparedSteps = 0;

function spawnStep(command, args, extraEnv, input, stdio) {
  return spawnSync(command, args, {
    cwd: rootDir,
    stdio,
    env: { ...baseEnv, ...extraEnv },
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
}

// stop the whole build on the first failure
function stopOnFailure(title, command, res) {
  if (res.error) {
    console.error(`\ncannot start "${command}": ${res.error.message}`);
    process.exit(1);
  }

  if (res.status !== 0) {
    console.error(`\ntest database build failed at step: ${title}`);
    process.exit(res.status ?? 1);
  }
}

// run one step with its output on screen
function run(title, command, args, extraEnv = {}, input) {
  console.log(`\n== ${title}`);

  const stdio = [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'];
  const res = spawnStep(command, args, extraEnv, input, stdio);

  stopOnFailure(title, command, res);

  return res;
}

function showProgress(title) {
  const width = 10;
  const done = Math.round(((preparedSteps - 1) / PREPARE_STEPS) * width);
  const bar = `[${'#'.repeat(done)}${'-'.repeat(width - done)}]`;
  const line = `Preparing the test database ${bar} ${preparedSteps}/${PREPARE_STEPS}  ${title}`;

  // \r returns to the line start, \x1b[K clears what is left of the previous step name
  if (interactive) process.stdout.write(`\r${line}\x1b[K`);
  else console.log(line);
}

// run one database preparation step quietly behind the progress line
function prepare(title, command, args, extraEnv = {}, input) {
  if (verbose) return run(title, command, args, extraEnv, input);

  preparedSteps += 1;
  if (preparedSteps === 1) console.log('');
  showProgress(title);

  const res = spawnStep(command, args, extraEnv, input, 'pipe');

  if (res.error || res.status !== 0) {
    // a failed step shows everything it printed
    if (interactive) process.stdout.write('\n');
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  }

  stopOnFailure(title, command, res);

  return res;
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
  const sql = readFileSync(path.join(rootDir, 'db', 'schema', file), 'utf8').replace(/\r\n/g, '\n');

  prepare(file, 'docker', psql('-f', '-'), {}, sql);
}

function down() {
  // remove containers together with their data
  run('remove test containers', 'docker', compose('down', '-v', '--remove-orphans'));
}

function up() {
  const startedAt = Date.now();

  // always start from an empty database
  down();
  run('start postgres and redis', 'docker', compose('up', '-d', '--wait'));

  // roles and schema must exist before prisma creates tables
  sqlFile('01_roles_and_schemas.sql');

  prepare(
    'set container passwords for roles',
    'docker',
    psql('-c', ROLES.map((role) => `ALTER ROLE ${role} PASSWORD '${role}';`).join(' ')),
  );

  // tables are created by the owner role, the same way migrations run on railway
  prepare(
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

  // the built database must match the saved reference (db/tools/structure_snapshot.txt)
  const check = prepare('compare structure with the reference', process.execPath, [
    'db/tools/structure_snapshot.mjs',
    'check',
  ]);

  // the check prints "structure matches the reference: <n> lines" on success
  const lines = check.stdout?.match(/matches the reference: (\d+) lines/)?.[1];
  const seconds = Math.round((Date.now() - startedAt) / 1000);

  // replace the progress line with the result
  if (interactive && !verbose) process.stdout.write('\r\x1b[K');
  else console.log('');

  console.log(
    `Test database is ready in ${seconds} s` +
      (lines ? `, structure matches the reference (${lines} lines)` : ''),
  );
  console.log(`  DATABASE_URL=${dbUrl('cartlify_app')}`);
  console.log(`  REDIS_URL=redis://${REDIS.host}:${REDIS.port}`);
}

const command = process.argv[2];

if (command === 'up') up();
else if (command === 'down') down();
else {
  console.error('usage: node db/tools/test_db_build.mjs up | down');
  process.exit(1);
}
