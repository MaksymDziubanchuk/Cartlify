// a copy of prod for dev with made-up people, not a backup (a backup keeps the real data):
// prod is read into a throwaway postgres container (in memory, no port open), anonymized there by
// db/tools/anonymize_prod_copy.sql, dumped into db/restore/ (git ignores it) and restored into dev.
// The data of the people of prod reaches no file, no dev and no terminal.
// usage:
//   PROD_URL=<url> DEV_URL=<url> node db/tools/dev_restore_from_prod.mjs   prod -> dump -> dev
//   PROD_URL=<url> node db/tools/dev_restore_from_prod.mjs --dump-only     the dump only
//   DEV_URL=<url> node db/tools/dev_restore_from_prod.mjs --from <dump>    dev from a dump made before
// both urls of a superuser: the tables force row level security, only a superuser reads every row
// of prod, and dev gets its roles and extensions back the way db/schema/01 builds them.
// DEV_USERS_PASSWORD (optional): the password of every buyer of the copy who had one, without it
// no buyer logs in with a password; the staff (ADMIN, ROOT) keep their accounts.
// The urls are read only from the environment of the command (not from .env) and never printed.
// Needs docker; the postgres tools come from the image, of the version of the servers
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const restoreDir = path.join(rootDir, 'db', 'restore');

// the version of the servers, the same as docker-compose.test.yml
const IMAGE = 'postgres:17.11';
const COPY_DB = 'prod_copy';
const CONTAINER = `cartlify-prod-copy-${randomBytes(4).toString('hex')}`;
const EXTENSIONS_SCRIPT = 'db/schema/02_extensions.sql';
const DUMP_IN_CONTAINER = '/tmp/copy.dump';
const LIST_IN_CONTAINER = '/tmp/copy.list';

// parameters prisma reads from a url and libpq does not know
const PRISMA_PARAMS = [
  'schema',
  'connection_limit',
  'pool_timeout',
  'pgbouncer',
  'socket_timeout',
  'statement_cache_size',
];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const args = process.argv.slice(2);
const dumpOnly = args.includes('--dump-only');
const fromIndex = args.indexOf('--from');
const fromDump = fromIndex === -1 ? null : args[fromIndex + 1];

const hidden = new Set();

// every part of both urls, and the addresses their hosts resolve to, is hidden in what is printed:
// the errors of the tools quote the server. Any other ip address goes too: inside the container a
// host may resolve to another one
const IP_ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi;

function hide(text) {
  const parts = [...hidden].filter((part) => part.length >= 3).sort((a, b) => b.length - a.length);
  return parts
    .reduce((out, part) => out.split(part).join('***'), String(text))
    .replace(IP_ADDRESS, '***');
}

function stop(message) {
  console.error(`\n${hide(message)}`);
  removeContainer();
  process.exit(1);
}

// a url for the tools inside the container: no prisma parameters, a database of this machine is
// reached through the host of docker
async function readUrl(name) {
  const value = process.env[name];
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    stop(`${name} is not a url`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    stop(`${name} is not a postgres url`);
  }

  for (const part of [
    url.username,
    decodeURIComponent(url.username),
    url.password,
    decodeURIComponent(url.password),
    url.hostname,
    url.port,
    url.pathname.slice(1),
    decodeURIComponent(url.pathname.slice(1)),
  ]) {
    if (part) hidden.add(part);
  }
  try {
    for (const { address } of await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })) {
      hidden.add(address);
    }
  } catch {
    // a host that does not resolve here fails in the container, its name is hidden already
  }

  const key = `${url.hostname}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}`;
  for (const param of PRISMA_PARAMS) url.searchParams.delete(param);
  if (LOCAL_HOSTS.has(url.hostname)) url.hostname = 'host.docker.internal';
  hidden.add('host.docker.internal');

  return { name, key, value: url.toString() };
}

function docker(dockerArgs, { input, env = {}, quiet = false } = {}) {
  const res = spawnSync('docker', dockerArgs, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) stop(`cannot start docker: ${res.error.message}`);
  if (res.status !== 0 && !quiet) {
    stop(`failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
  return res;
}

// a command inside the container; a url goes in through the environment, never in the arguments
function inContainer(command, { input, url } = {}) {
  return docker(
    [
      'exec',
      ...(input === undefined ? [] : ['-i']),
      ...(url ? ['-e', 'TARGET_URL'] : []),
      CONTAINER,
      'bash',
      '-c',
      `set -o pipefail; ${command}`,
    ],
    { input, env: url ? { TARGET_URL: url.value } : {} },
  );
}

let containerStarted = false;

function removeContainer() {
  if (!containerStarted) return;
  containerStarted = false;
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    removeContainer();
    process.exit(130);
  });
}

function step(title) {
  console.log(`== ${title}`);
}

function sqlFile(relative) {
  return readFileSync(path.join(rootDir, relative), 'utf8').replace(/\r\n/g, '\n');
}

function startContainer() {
  step('starting a throwaway database for the copy');
  docker(
    [
      'run',
      '-d',
      '--rm',
      '--name',
      CONTAINER,
      '--tmpfs',
      '/var/lib/postgresql/data',
      '--add-host',
      'host.docker.internal:host-gateway',
      '-e',
      `POSTGRES_PASSWORD=${randomBytes(16).toString('hex')}`,
      '-e',
      `POSTGRES_DB=${COPY_DB}`,
      IMAGE,
    ],
    { quiet: false },
  );
  containerStarted = true;

  // over tcp: while the image sets the server up it listens on the unix socket only
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const res = docker(
      ['exec', CONTAINER, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', COPY_DB],
      {
        quiet: true,
      },
    );
    if (res.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  stop('the throwaway database did not start in 60 s');
}

async function passwordHash() {
  const password = process.env.DEV_USERS_PASSWORD;
  if (!password) return '';
  const { default: bcrypt } = await import('bcrypt');
  return bcrypt.hash(password, 10);
}

// prod into the copy database and the anonymization over it; the data goes from pg_dump to psql
// inside the container, the anonymization in its own transaction stops the copy on a miss
async function copyProd(prod) {
  step('copying prod into the throwaway database');
  // the policies name the roles of the shop
  inContainer(
    `psql -v ON_ERROR_STOP=1 -q -U postgres -d ${COPY_DB} -c "CREATE ROLE cartlify_owner; CREATE ROLE cartlify_app; CREATE ROLE cartlify_readonly;"`,
  );
  inContainer(
    `pg_dump --format=plain --no-owner --no-privileges --dbname="$TARGET_URL" | psql -v ON_ERROR_STOP=1 -q --single-transaction -U postgres -d ${COPY_DB} > /dev/null`,
    { url: prod },
  );

  step('anonymizing the people of the copy');
  const hash = await passwordHash();
  inContainer(`psql -v ON_ERROR_STOP=1 -q -U postgres -d ${COPY_DB} > /dev/null`, {
    input: `\\set password_hash '${hash}'\n${sqlFile('db/tools/anonymize_prod_copy.sql')}`,
  });

  inContainer(
    `pg_dump --format=custom --no-owner --no-privileges -U postgres -d ${COPY_DB} -f ${DUMP_IN_CONTAINER}`,
  );
}

// the dump goes only where git ignores it
function saveDump() {
  mkdirSync(restoreDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const file = path.join(restoreDir, `prod_copy_${stamp}.dump`);
  const relative = path.relative(rootDir, file).split(path.sep).join('/');

  const ignored = spawnSync('git', ['check-ignore', '-q', relative], { cwd: rootDir });
  if (ignored.status !== 0)
    stop(`git does not ignore ${relative}: the dump would reach the repository`);

  docker(['cp', `${CONTAINER}:${DUMP_IN_CONTAINER}`, file]);
  console.log(`== the anonymized dump: ${relative}`);
}

function loadDump(file) {
  if (!existsSync(file)) stop(`no dump at ${file}`);
  docker(['cp', file, `${CONTAINER}:${DUMP_IN_CONTAINER}`]);
}

// dev from the dump: its schema goes and comes back the way the scripts build it (db/schema/01,
// the extensions), every object of the dump is made by cartlify_owner, the owner of the objects
// of the scripts, then 02 and 01 give the rights again, the order of db/tools/test_db_build.mjs
function restoreDev(dev) {
  step('restoring dev from the dump');
  const psql = 'psql -v ON_ERROR_STOP=1 -q --dbname="$TARGET_URL" > /dev/null';

  inContainer(psql, { url: dev, input: 'DROP SCHEMA IF EXISTS cartlify CASCADE;\n' });
  inContainer(psql, { url: dev, input: sqlFile('db/schema/01_roles_and_schemas.sql') });
  inContainer(psql, {
    url: dev,
    input:
      'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA cartlify;\n' +
      'CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA cartlify;\n',
  });

  // the schema and the extensions are there already, made by a superuser
  const list = inContainer(`pg_restore --list ${DUMP_IN_CONTAINER}`).stdout;
  const kept = list
    .split('\n')
    .filter((line) => !/^\d+; \d+ \d+ (SCHEMA|EXTENSION) /.test(line))
    .filter((line) => !/^\d+; \d+ \d+ COMMENT - (SCHEMA|EXTENSION) /.test(line))
    .join('\n');
  inContainer(`cat > ${LIST_IN_CONTAINER}`, { input: kept });

  inContainer(
    `pg_restore --dbname="$TARGET_URL" --role=cartlify_owner --no-owner --no-privileges --exit-on-error --single-transaction --use-list=${LIST_IN_CONTAINER} ${DUMP_IN_CONTAINER}`,
    { url: dev },
  );
  // the rights of the extensions and the search helper, then the rights of the new objects
  inContainer(psql, { url: dev, input: sqlFile(EXTENSIONS_SCRIPT) });
  inContainer(psql, { url: dev, input: sqlFile('db/schema/01_roles_and_schemas.sql') });
}

async function main() {
  if (fromIndex !== -1 && !fromDump) stop('--from needs the path of a dump');
  if (fromDump && dumpOnly) stop('--from and --dump-only do not go together');

  const prod = fromDump ? null : await readUrl('PROD_URL');
  const dev = dumpOnly ? null : await readUrl('DEV_URL');

  if (!fromDump && !prod) stop('PROD_URL is not set');
  if (!dumpOnly && !dev) stop('DEV_URL is not set');
  if (prod && dev && prod.key === dev.key) stop('PROD_URL and DEV_URL name the same database');

  startContainer();
  try {
    if (fromDump) {
      loadDump(path.resolve(fromDump));
    } else {
      await copyProd(prod);
      saveDump();
    }

    if (dev) {
      restoreDev(dev);
      console.log(
        '== done: dev has the structure of prod now; run the migrations and the scripts of the code ' +
          'dev runs, then npm run db:snapshot:check:db',
      );
    } else {
      console.log('== done, dev was not touched');
    }
  } finally {
    removeContainer();
  }
}

main().catch((err) => stop(`failed: ${err?.message ?? err}`));
