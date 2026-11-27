// test launcher: pick test parts in a list or by name, build the docker test database
// when an integration part is picked, run jest, remove the database and print a summary per part
//
// usage:
//   npm test                          a list: a part checked or not, a service skip, mock or real,
//                                     a for all (all parts without an interactive terminal)
//   npm test -- unit api:orders       named parts, also the groups: all, unit, integration, api
//   npm test -- --failed              rerun only the tests that failed in the last selection
//   npm test -- api:orders --keep-db  leave the test database running after the tests
//   npm test -- --workers=1           integration files one by one (by default by the cores docker
//                                     has and the ones left to the machine, at most 6 at a time:
//                                     defaultWorkers; more than the memory takes runs out of time)
//   npm test -- api:auth service:sendgrid   a service of SERVICES for real instead of its mock
//   npm test -- integration skip:stripe       its own files left out (mock:<name> keeps the mock,
//                                     as every service not named in the words)
//   npm test -- unit -- -t "cursor"   everything after a second -- goes to jest unchanged

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudinaryQuota } from './setup/cloudinaryQuota.mjs';
import { guessOf, modeOf, readPace, recordRun, runKeyOf, writePace } from './setup/runPace.mjs';
import { Separator, selectPrompt } from './setup/selectPrompt.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(rootDir, 'node_modules', '.cache', 'cartlify-tests');
const selectionFile = path.join(cacheDir, 'selection.json');
const resultFile = path.join(cacheDir, 'last-run.json');
const cloudinaryUseFile = path.join(cacheDir, 'cloudinary-use.json');
// how long the files and the runs took the last time (tests/setup/runPace.mjs)
const paceFile = path.join(cacheDir, 'pace.json');

// flags the launcher handles itself, they never reach jest
const LAUNCHER_FLAGS = ['--failed', '--keep-db'];
const WORKERS_FLAG = /^--workers=(\d+)$/;

// integration files share one database and redis; every test makes and checks only its own rows,
// so a few files run at once. The database is what they wait for: one file more than the cores
// docker gives it, at most one per core and at most 6. With more, transactions of the app and of
// the tests run out of their 5 s on a busy database (measured 28.10.2026, docker with 2 cores: 6
// files at a time 488-632 s with such failures, 3 at a time 522 s and none).
// Docker Desktop keeps cores of its own (WSL2 or Hyper-V: fewer than the machine has); the files
// get what is left but two, for the rest of the machine (docker with 6 of 12 cores: 6 files and
// the database took all 12 and transactions ran out). On Linux (GitHub) docker runs on the cores
// of the machine itself and shows all of them: nothing is taken off there
function dockerCpus() {
  const result = spawnSync('docker', ['info', '--format', '{{.NCPU}}'], {
    encoding: 'utf8',
    env: { ...process.env, COMPOSE_DISABLE_ENV_FILE: '1' },
  });
  const cpus = Number(result.stdout?.trim());
  return result.status === 0 && Number.isInteger(cpus) && cpus > 0 ? cpus : null;
}

function defaultWorkers() {
  const cores = availableParallelism();
  const docker = dockerCpus();
  const ownCores = docker !== null && docker < cores;
  const leftToFiles = ownCores ? cores - docker - 2 : cores;

  return Math.max(1, Math.min(6, cores, (docker ?? 5) + 1, leftToFiles));
}

const DEFAULT_WORKERS = defaultWorkers();

// external services the tests answer from a mock unless the run takes them for real. Each is in one
// of three states: not run (skip: its own files are left out, the contract of its kind, the check
// of its mock against the real service, its webhook; every other test that goes through it takes
// the mock), its mock, or the real service; jest gets the real ones in TEST_REAL_SERVICES and the
// files left out in TEST_SKIP_FILES (jest.config.js). In the list a service is not run unless the
// selection saved says otherwise; by the words of a run it is the mock unless they name it
// (service:<name> real, mock:<name>, skip:<name>); without a terminal (GitHub) every one is the mock.
// real: false means the real mode is not set up yet, the mock answers all the same
const SERVICES = [
  {
    name: 'sendgrid',
    real: true,
    files: [
      'tests/integration/providers/mail.contract.test.ts',
      'tests/integration/api/newsletters/sendgridWebhook.test.ts',
    ],
  },
  { name: 'cloudinary', real: true, files: ['tests/integration/providers/files.contract.test.ts'] },
  {
    name: 'stripe',
    real: true,
    files: [
      'tests/integration/providers/payments.contract.test.ts',
      'tests/integration/api/payments/stripeAnswers.test.ts',
      'tests/integration/api/payments/webhook.test.ts',
    ],
  },
  { name: 'openai', real: true, files: ['tests/integration/providers/ai.contract.test.ts'] },
  // the dummy secrets of Cloudflare need no account and no secret: nothing is taken from .env
  {
    name: 'turnstile',
    real: true,
    files: ['tests/integration/providers/captcha.contract.test.ts'],
  },
  // ShippyPro has no sandbox: the real mode asks the account all it can without a label, every
  // parcel is made by the mock in both modes (tests/helpers/shippyPro.ts)
  {
    name: 'shippypro',
    real: true,
    files: [
      'tests/integration/providers/delivery.contract.test.ts',
      'tests/integration/providers/deliveryMock.test.ts',
      'tests/integration/api/delivery/webhook.test.ts',
    ],
  },
  // fiskaly SIGN ES in TEST: the receipts go to the test of the tax authority of Spain, nothing
  // reaches a real one
  {
    name: 'fiskaly',
    real: true,
    files: ['tests/integration/providers/receipts.contract.test.ts'],
  },
];
// the words of a run that set a service: real, its mock, not run
const SERVICE_PREFIX = 'service:';
const MODE_PREFIXES = { [SERVICE_PREFIX]: 'real', 'mock:': 'mock', 'skip:': 'skip' };
const modeWordOf = (word) => Object.keys(MODE_PREFIXES).find((prefix) => word.startsWith(prefix));

// one part per test folder: unit, api:<module>, then every other integration folder
function discoverParts() {
  const listDirs = (dir) =>
    existsSync(path.join(rootDir, dir))
      ? readdirSync(path.join(rootDir, dir), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : [];

  const parts = [{ name: 'unit', dir: 'tests/unit', integration: false }];

  for (const name of listDirs('tests/integration/api')) {
    parts.push({ name: `api:${name}`, dir: `tests/integration/api/${name}`, integration: true });
  }

  for (const name of listDirs('tests/integration')) {
    if (name === 'api') continue;
    parts.push({ name, dir: `tests/integration/${name}`, integration: true });
  }

  for (const part of parts) {
    part.files = existsSync(path.join(rootDir, part.dir))
      ? readdirSync(path.join(rootDir, part.dir), { recursive: true }).filter((file) =>
          String(file).endsWith('.test.ts'),
        ).length
      : 0;
  }

  return parts;
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

// launcher words before a second --, jest options after it
function parseArgs(argv) {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const passThrough = split === -1 ? [] : argv.slice(split + 1);

  const workersFlag = own.map((arg) => WORKERS_FLAG.exec(arg)).find(Boolean);
  const workers = workersFlag ? Number(workersFlag[1]) : DEFAULT_WORKERS;
  if (!Number.isInteger(workers) || workers < 1) fail('--workers takes a whole number from 1');

  return {
    failedOnly: own.includes('--failed'),
    keepDb: own.includes('--keep-db'),
    workers,
    // flags without values may also stay before the second --
    jestFlags: [
      ...own.filter(
        (arg) => arg.startsWith('-') && !LAUNCHER_FLAGS.includes(arg) && !WORKERS_FLAG.test(arg),
      ),
      ...passThrough,
    ],
    words: own.filter((arg) => !arg.startsWith('-')),
  };
}

function resolveWords(words, parts) {
  const groups = {
    all: () => parts,
    unit: () => parts.filter((part) => !part.integration),
    integration: () => parts.filter((part) => part.integration),
    api: () => parts.filter((part) => part.name.startsWith('api:')),
  };

  const picked = new Set();

  for (const word of words) {
    if (modeWordOf(word)) continue;

    const matched = groups[word]?.() ?? parts.filter((part) => part.name === word);

    if (!matched.length) {
      fail(
        `Unknown test part "${word}".\n` +
          `Parts: ${parts.map((part) => part.name).join(', ')}\n` +
          `Groups: ${Object.keys(groups).join(', ')}\n` +
          'Jest options with a value go after a second --, for example: npm test -- unit -- -t "name"',
      );
    }

    matched.forEach((part) => picked.add(part.name));
  }

  return parts.filter((part) => picked.has(part.name));
}

// the state of every service: the one the words (or the names of a saved selection) give it, else
// the one given; a name in a saved selection the list no longer has is left out (a run never stops on
// a file of an older launcher)
function resolveServices(words, fallback, { saved = false } = {}) {
  const modes = Object.fromEntries(SERVICES.map((service) => [service.name, fallback]));

  for (const word of words) {
    const prefix = modeWordOf(word);
    if (!prefix) continue;
    const name = word.slice(prefix.length);
    const service = SERVICES.find((one) => one.name === name);
    if (!service && saved) continue;
    if (!service) {
      fail(
        `Unknown service "${name}".\n` +
          `Services: ${SERVICES.map((one) => one.name).join(', ')} ` +
          '(service:<name> real, mock:<name>, skip:<name>)',
      );
    }
    modes[name] = MODE_PREFIXES[prefix];
  }

  return modes;
}

const realServices = (modes) =>
  SERVICES.filter((service) => modes[service.name] === 'real' && service.real);
const skippedFiles = (modes) =>
  SERVICES.filter((service) => modes[service.name] === 'skip').flatMap((service) => service.files);

function loadSelection() {
  try {
    return JSON.parse(readFileSync(selectionFile, 'utf8'));
  } catch {
    // first run or a broken file, start with unit only
    return ['unit'];
  }
}

// the parts and the services that run, each in its state
function saveSelection({ selected, modes }) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    selectionFile,
    JSON.stringify([
      ...selected.map((part) => part.name),
      ...SERVICES.flatMap((service) => {
        const mode = modes[service.name];
        if (mode === 'real') return [`${SERVICE_PREFIX}${service.name}`];
        return mode === 'skip' ? [] : [`mock:${service.name}`];
      }),
    ]),
  );
}

async function promptSelection(parts) {
  const saved = loadSelection();
  const savedModes = resolveServices(saved, 'skip', { saved: true });

  const toChoice = (part) => ({
    name: part.name.replace(/^api:/, 'api: ') + (part.files ? '' : '  (no tests yet)'),
    value: part.name,
    checked: saved.includes(part.name),
  });

  const choices = [
    ...parts.filter((part) => !part.integration).map(toChoice),
    new Separator('-- integration (builds the docker test database, removes it after) --'),
    ...parts.filter((part) => part.integration).map(toChoice),
    new Separator('-- services (skip: its own files are left out, mock, real) --'),
    ...SERVICES.map((service) => ({
      name: service.name + (service.real ? '' : '  (real mode not set up yet)'),
      value: service.name,
      states: ['skip', 'mock', 'real'],
      state: savedModes[service.name],
    })),
  ];

  // a list taller than the terminal cannot be redrawn in place and leaves copies on screen,
  // so it scrolls inside the rows left after the question, the key help and one spare line
  const rows = process.stdout.rows || 24;
  const pageSize = Math.max(3, Math.min(choices.length, rows - 4));

  try {
    const answer = await selectPrompt({ message: 'Select test parts to run', choices, pageSize });

    return {
      selected: parts.filter((part) => answer.parts.includes(part.name)),
      modes: answer.services,
    };
  } catch (err) {
    // ctrl+c closes the prompt with this error
    if (err?.name === 'ExitPromptError') {
      console.log('Cancelled.');
      process.exit(130);
    }

    throw err;
  }
}

// the parts to run and the state of each service
async function chooseParts(parts, { words, failedOnly }) {
  if (words.length) {
    const choice = { selected: resolveWords(words, parts), modes: resolveServices(words, 'mock') };
    saveSelection(choice);
    return choice;
  }

  // --failed repeats the last selection, failed tests are taken from the jest cache
  if (failedOnly) {
    const saved = loadSelection();
    return {
      selected: parts.filter((part) => saved.includes(part.name)),
      modes: resolveServices(saved, 'skip', { saved: true }),
    };
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const choice = await promptSelection(parts);
    saveSelection(choice);
    return choice;
  }

  console.log(
    'No interactive terminal, running all test parts with mocked services ' +
      '(pass part names and service:<name> to choose).',
  );
  return { selected: parts, modes: resolveServices([], 'mock') };
}

// which services answer for real, which from a mock and which are not run
function describeServices(modes) {
  return SERVICES.map((service) => {
    const mode = modes[service.name];
    if (mode === 'skip') return `${service.name}: not run`;
    if (mode === 'mock') return `${service.name}: mock`;
    return service.real
      ? `${service.name}: real`
      : `${service.name}: mock (real asked for, its real mode is not set up yet)`;
  }).join(', ');
}

function buildTestDatabase() {
  console.log('\n> Building the test database (npm run db:test:up)\n');

  const result = spawnSync(process.execPath, ['db/tools/test_db_build.mjs', 'up'], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    fail('The test database was not built, tests were not started.');
  }
}

// the containers keep the database in memory, free it unless --keep-db asks to look inside
function removeTestDatabase() {
  console.log('\n> Removing the test database (--keep-db leaves it running)');

  // output only on failure, so the summary stays the last thing on screen
  const result = spawnSync(process.execPath, ['db/tools/test_db_build.mjs', 'down'], {
    cwd: rootDir,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    console.error('The test database was not removed, run: npm run db:test:down');
  }
}

// Cloudinary answers a few hundred calls of its admin api an hour, and the tests read the files they
// check through it: a run with the real service asks what is left before it starts, and stops when
// a run of the same parts took more the last time; after the run it tells what the run took (a dev
// server on the same account in that time counts in too)
const partsKey = (selected) => selected.map((part) => part.name).join(',');
const utcTime = (date) => `${date.toISOString().slice(11, 16)} UTC`;

function readCloudinaryUse() {
  try {
    return JSON.parse(readFileSync(cloudinaryUseFile, 'utf8'));
  } catch {
    return {};
  }
}

async function checkCloudinaryQuota(selected) {
  const quota = await cloudinaryQuota(rootDir);
  if (quota.error) {
    fail(
      `Cloudinary did not tell what is left of its admin api: ${quota.error}\n` +
        'Run without service:cloudinary to take its mock.',
    );
  }

  const need = readCloudinaryUse()[partsKey(selected)];
  console.log(
    `> Cloudinary admin api: ${quota.remaining} of ${quota.allowed} calls left until ` +
      utcTime(quota.resetAt) +
      (need === undefined ? '' : `, the last run of these parts took ${need}`),
  );
  if (need !== undefined && quota.remaining < need) {
    fail(
      'Too few Cloudinary admin api calls are left for these parts: run after ' +
        `${utcTime(quota.resetAt)}, or without service:cloudinary to take its mock.`,
    );
  }

  return quota;
}

// the line of the summary on what the run took of the admin api
async function cloudinaryUseOf(selected, before, { failedOnly, jestFlags }) {
  const after = await cloudinaryQuota(rootDir);
  if (after.error) return `Cloudinary admin api after the run: ${after.error}`;

  const left = `${after.remaining} of ${after.allowed} left until ${utcTime(after.resetAt)}`;
  // a new hour gave the account its calls back, the difference tells nothing
  if (after.resetAt.getTime() !== before.resetAt.getTime()) return `Cloudinary admin api: ${left}`;

  // the ping that asks takes none of the calls
  const calls = before.remaining - after.remaining;
  // only a run of whole parts tells what the next run of them takes
  if (!failedOnly && !jestFlags.length) {
    mkdirSync(cacheDir, { recursive: true });
    const use = { ...readCloudinaryUse(), [partsKey(selected)]: calls };
    writeFileSync(cloudinaryUseFile, JSON.stringify(use, null, 2));
  }

  return `Cloudinary admin api: the run took ${calls} calls, ${left}`;
}

// The test files the run takes: the ones jest is handed by path (--runTestsByPath), or every file
// of the parts picked. filtered: another option of jest goes with them (a name of a test, a
// pattern), so the files do not run whole and the run tells nothing of their time
function filesOf(selected, jestFlags, skipped) {
  const slashes = (file) => String(file).split(path.sep).join('/');
  const at = jestFlags.indexOf('--runTestsByPath');

  if (at !== -1) {
    const rest = jestFlags.slice(at + 1);
    const end = rest.findIndex((arg) => arg.startsWith('-'));
    const paths = end === -1 ? rest : rest.slice(0, end);
    return {
      files: paths.map((file) => slashes(path.relative(rootDir, path.resolve(rootDir, file)))),
      byHand: true,
      filtered: jestFlags.length > paths.length + 1,
    };
  }

  const files = selected
    .flatMap((part) =>
      existsSync(path.join(rootDir, part.dir))
        ? readdirSync(path.join(rootDir, part.dir), { recursive: true })
            .filter((file) => String(file).endsWith('.test.ts'))
            .map((file) => `${part.dir}/${slashes(file)}`)
        : [],
    )
    .filter((file) => !skipped.includes(file));

  return { files, byHand: false, filtered: jestFlags.length > 0 };
}

function runJest(selected, modes, { failedOnly, jestFlags, workers }, guess) {
  const needsDb = selected.some((part) => part.integration);

  rmSync(resultFile, { force: true });
  mkdirSync(cacheDir, { recursive: true });

  const args = [
    // jest needs vm modules to run the app as native esm
    '--experimental-vm-modules',
    // the integration files free the modules of the file before them with a collection of their own
    // (tests/setup/integration.gc.ts), the workers get the flag from this process
    '--expose-gc',
    '--disable-warning=ExperimentalWarning',
    path.join('node_modules', 'jest', 'bin', 'jest.js'),
    '--coverage',
    // empty folders are parts too, they must not fail the run
    '--passWithNoTests',
    // integration files share one database and redis: a few at a time (unit tests alone take
    // every core jest gives them). One at a time is one worker and not --runInBand: a worker is
    // replaced when it has grown too big (workerIdleMemoryLimit in jest.config.js), the main
    // process cannot be
    ...(needsDb ? [`--maxWorkers=${workers}`] : []),
    ...(failedOnly ? ['--onlyFailures'] : []),
    '--json',
    `--outputFile=${resultFile}`,
    ...jestFlags,
    // a trailing slash keeps api/order from matching api/orders
    ...selected.map((part) => `${part.dir}/`),
  ];

  console.log(`\n> Running: ${selected.map((part) => part.name).join(', ')}`);
  console.log(`> Services: ${describeServices(modes)}`);
  if (needsDb) console.log(`> Integration files at a time: ${workers}`);
  console.log('');

  // only the services with a real mode; set here and not left to the shell
  const real = realServices(modes).map((service) => service.name);

  const result = spawnSync(process.execPath, args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      TEST_REAL_SERVICES: real.join(','),
      TEST_SKIP_FILES: skippedFiles(modes).join(','),
      // the guess of the launcher, for the "estimated" of jest (tests/setup/sequencer.mjs)
      ...(guess
        ? { TEST_GUESS_MS: String(guess.ms), TEST_GUESS_WORKERS: String(guess.workers) }
        : {}),
    },
  });

  return result.status ?? 1;
}

function readResults() {
  try {
    return JSON.parse(readFileSync(resultFile, 'utf8'));
  } catch {
    return null;
  }
}

function printSummary(selected, modes, parts, results, { failedOnly, jestFlags, cloudinaryUse }) {
  const rows = selected.map((part) => {
    const row = { part: part.name, files: 0, passed: 0, failed: 0, skipped: 0, note: '' };

    for (const file of results?.testResults ?? []) {
      const relative = path.relative(rootDir, file.name).split(path.sep).join('/');
      if (!relative.startsWith(`${part.dir}/`)) continue;

      row.files += 1;

      // a file that crashed before its tests ran has no assertion results
      if (file.status === 'failed' && !file.assertionResults.length) row.failed += 1;

      for (const test of file.assertionResults) {
        if (test.status === 'passed') row.passed += 1;
        else if (test.status === 'failed') row.failed += 1;
        else row.skipped += 1;
      }
    }

    if (!part.files) row.note = 'no tests yet';
    else if (!row.files) row.note = 'nothing ran';

    return row;
  });

  const width = Math.max(...rows.map((row) => row.part.length), 'part'.length) + 2;
  const cell = (value) => String(value).padStart(8);

  console.log('\nSummary by part');
  console.log(
    `  ${'part'.padEnd(width)}${cell('files')}${cell('passed')}${cell('failed')}${cell('skipped')}`,
  );

  for (const row of rows) {
    const counts = row.note
      ? `  ${row.note}`
      : `${cell(row.files)}${cell(row.passed)}${cell(row.failed)}${cell(row.skipped)}`;
    console.log(`  ${row.part.padEnd(width)}${counts}`);
  }

  if (selected.some((part) => part.integration)) {
    console.log(`\nServices: ${describeServices(modes)}`);
    if (cloudinaryUse) console.log(cloudinaryUse);
  }

  const partial = selected.length < parts.length || failedOnly || jestFlags.length > 0;

  console.log(
    partial
      ? `\nCoverage above is partial: only ${selected.map((part) => part.name).join(', ')} ran` +
          (failedOnly || jestFlags.length ? ' with filters' : '') +
          '.'
      : '\nCoverage above covers all test parts.',
  );
  console.log('Full coverage report: tests/coverage/lcov-report/index.html\n');
}

const options = parseArgs(process.argv.slice(2));
const parts = discoverParts();
const { selected, modes } = await chooseParts(parts, options);

if (!selected.length) fail('No test parts selected.');

const needsDb = selected.some((part) => part.integration);
const realCloudinary = needsDb && modes.cloudinary === 'real';

const quotaBefore = realCloudinary ? await checkCloudinaryQuota(selected) : null;

// how long the tests take, for the "estimated" of jest: by the record of the runs before, the mocks
// and each set of real services apart
const pace = readPace(paceFile);
const mode = modeOf(needsDb ? realServices(modes).map((service) => service.name) : []);
// unit files alone take the workers jest gives them: every core but one
const jestWorkers = needsDb ? options.workers : Math.max(1, availableParallelism() - 1);
const picked = filesOf(selected, options.jestFlags, skippedFiles(modes));
const whole = !options.failedOnly && !picked.filtered;
const runKey =
  whole && !picked.byHand
    ? runKeyOf(
        selected.map((part) => part.name),
        jestWorkers,
      )
    : undefined;
const guessed = guessOf(pace, { mode, files: picked.files, workers: jestWorkers, runKey });

if (needsDb) buildTestDatabase();

const startedAt = Date.now();

const status = runJest(
  selected,
  modes,
  options,
  guessed ? { ms: guessed.ms, workers: jestWorkers } : null,
);

const testsMs = Date.now() - startedAt;
const results = readResults();

writePace(paceFile, {
  ...recordRun(pace, {
    mode,
    results,
    rootDir,
    workers: jestWorkers,
    wallMs: testsMs,
    whole,
    runKey,
  }),
});

const cloudinaryUse = quotaBefore ? await cloudinaryUseOf(selected, quotaBefore, options) : null;

if (needsDb && !options.keepDb) removeTestDatabase();

printSummary(selected, modes, parts, results, { ...options, cloudinaryUse });

if (needsDb && options.keepDb) {
  console.log('The test database is still running, remove it with: npm run db:test:down\n');
}

process.exit(status);
