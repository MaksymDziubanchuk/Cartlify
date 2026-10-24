// test launcher: pick test parts in a checkbox list or by name, build the docker test database
// when an integration part is picked, run jest, remove the database and print a summary per part
//
// usage:
//   npm test                          checkbox list (all parts without an interactive terminal)
//   npm test -- unit api:orders       named parts, also the groups: all, unit, integration, api
//   npm test -- --failed              rerun only the tests that failed in the last selection
//   npm test -- api:orders --keep-db  leave the test database running after the tests
//   npm test -- --workers=1           integration files one by one (up to 6 at a time by default)
//   npm test -- api:auth service:sendgrid   a service of SERVICES for real instead of its mock
//   npm test -- unit -- -t "cursor"   everything after a second -- goes to jest unchanged

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(rootDir, 'node_modules', '.cache', 'cartlify-tests');
const selectionFile = path.join(cacheDir, 'selection.json');
const resultFile = path.join(cacheDir, 'last-run.json');

// flags the launcher handles itself, they never reach jest
const LAUNCHER_FLAGS = ['--failed', '--keep-db'];
const WORKERS_FLAG = /^--workers=(\d+)$/;

// integration files share one database and redis; every test makes and checks only its own rows,
// so a few files run at once, one per core and at most 6: more wait for the same database
// (measured 18.10.2026: 4 files at a time 93 s, 6 at a time 81 s; one by one on github 360 s)
const DEFAULT_WORKERS = Math.min(6, availableParallelism());

// external services the tests answer from a mock unless the run names them (a checkbox under
// Services, service:<name> in the arguments); jest gets the named ones in TEST_REAL_SERVICES.
// real: false means the real mode is not set up yet, the mock answers all the same
const SERVICES = [
  { name: 'sendgrid', real: true },
  { name: 'cloudinary', real: true },
  { name: 'stripe', real: true },
  { name: 'openai', real: true },
];
const SERVICE_PREFIX = 'service:';

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
    if (word.startsWith(SERVICE_PREFIX)) continue;

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

// the services named for real among the words, or among the names of a saved selection
function resolveServices(words) {
  const names = words
    .filter((word) => word.startsWith(SERVICE_PREFIX))
    .map((word) => word.slice(SERVICE_PREFIX.length));

  for (const name of names) {
    if (!SERVICES.some((service) => service.name === name)) {
      fail(
        `Unknown service "${name}".\n` +
          `Services: ${SERVICES.map((service) => `${SERVICE_PREFIX}${service.name}`).join(', ')}`,
      );
    }
  }

  return SERVICES.filter((service) => names.includes(service.name));
}

function loadSelection() {
  try {
    return JSON.parse(readFileSync(selectionFile, 'utf8'));
  } catch {
    // first run or a broken file, start with unit only
    return ['unit'];
  }
}

function saveSelection({ selected, services }) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    selectionFile,
    JSON.stringify([
      ...selected.map((part) => part.name),
      ...services.map((service) => `${SERVICE_PREFIX}${service.name}`),
    ]),
  );
}

async function promptSelection(parts) {
  const { checkbox, Separator } = await import('@inquirer/prompts');
  const saved = loadSelection();

  const toChoice = (part) => ({
    name: part.name.replace(/^api:/, 'api: ') + (part.files ? '' : '  (no tests yet)'),
    value: part.name,
    checked: saved.includes(part.name),
  });

  const choices = [
    ...parts.filter((part) => !part.integration).map(toChoice),
    new Separator('-- integration (builds the docker test database, removes it after) --'),
    ...parts.filter((part) => part.integration).map(toChoice),
    new Separator('-- services (checked: the real service, unchecked: its mock) --'),
    ...SERVICES.map((service) => ({
      name: service.name + (service.real ? '' : '  (real mode not set up yet)'),
      value: `${SERVICE_PREFIX}${service.name}`,
      checked: saved.includes(`${SERVICE_PREFIX}${service.name}`),
    })),
  ];

  // a list taller than the terminal cannot be redrawn in place and leaves copies on screen,
  // so it scrolls inside the rows left after the question, the key help and one spare line
  const rows = process.stdout.rows || 24;
  const pageSize = Math.max(3, Math.min(choices.length, rows - 4));

  try {
    const names = await checkbox({
      message: 'Select test parts to run',
      choices,
      pageSize,
      // stop at the first and last part instead of jumping around a scrolled list
      loop: false,
      required: true,
      // plain check boxes instead of the default circles
      theme: {
        icon: {
          checked: styleText('green', '[x]'),
          unchecked: '[ ]',
          disabledChecked: styleText('green', '[x]'),
          disabledUnchecked: '[-]',
        },
      },
    });

    return {
      selected: parts.filter((part) => names.includes(part.name)),
      services: resolveServices(names),
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

// the parts to run and the services to take for real
async function chooseParts(parts, { words, failedOnly }) {
  if (words.length) {
    const choice = { selected: resolveWords(words, parts), services: resolveServices(words) };
    saveSelection(choice);
    return choice;
  }

  // --failed repeats the last selection, failed tests are taken from the jest cache
  if (failedOnly) {
    const saved = loadSelection();
    return {
      selected: parts.filter((part) => saved.includes(part.name)),
      services: resolveServices(saved),
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
  return { selected: parts, services: [] };
}

// which services answer for real and which from a mock
function describeServices(services) {
  return SERVICES.map((service) => {
    if (!services.includes(service)) return `${service.name}: mock`;
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

function runJest(selected, services, { failedOnly, jestFlags, workers }) {
  const needsDb = selected.some((part) => part.integration);

  rmSync(resultFile, { force: true });
  mkdirSync(cacheDir, { recursive: true });

  const args = [
    // jest needs vm modules to run the app as native esm
    '--experimental-vm-modules',
    '--disable-warning=ExperimentalWarning',
    path.join('node_modules', 'jest', 'bin', 'jest.js'),
    '--coverage',
    // empty folders are parts too, they must not fail the run
    '--passWithNoTests',
    // integration files share one database and redis: a few at a time (unit tests alone take
    // every core jest gives them)
    ...(needsDb ? [workers === 1 ? '--runInBand' : `--maxWorkers=${workers}`] : []),
    ...(failedOnly ? ['--onlyFailures'] : []),
    '--json',
    `--outputFile=${resultFile}`,
    ...jestFlags,
    // a trailing slash keeps api/order from matching api/orders
    ...selected.map((part) => `${part.dir}/`),
  ];

  console.log(`\n> Running: ${selected.map((part) => part.name).join(', ')}`);
  console.log(`> Services: ${describeServices(services)}\n`);

  // only the services with a real mode; set here and not left to the shell
  const real = services.filter((service) => service.real).map((service) => service.name);

  const result = spawnSync(process.execPath, args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, TEST_REAL_SERVICES: real.join(',') },
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

function printSummary(selected, services, parts, results, { failedOnly, jestFlags }) {
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
    console.log(`\nServices: ${describeServices(services)}`);
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
const { selected, services } = await chooseParts(parts, options);

if (!selected.length) fail('No test parts selected.');

const needsDb = selected.some((part) => part.integration);

if (needsDb) buildTestDatabase();

const status = runJest(selected, services, options);

if (needsDb && !options.keepDb) removeTestDatabase();

printSummary(selected, services, parts, readResults(), options);

if (needsDb && options.keepDb) {
  console.log('The test database is still running, remove it with: npm run db:test:down\n');
}

process.exit(status);
