// test launcher: pick test parts in a checkbox list or by name, build the docker test database
// when an integration part is picked, run jest, remove the database and print a summary per part
//
// usage:
//   npm test                          checkbox list (all parts without an interactive terminal)
//   npm test -- unit api:orders       named parts, also the groups: all, unit, integration, api
//   npm test -- --failed              rerun only the tests that failed in the last selection
//   npm test -- api:orders --keep-db  leave the test database running after the tests
//   npm test -- unit -- -t "cursor"   everything after a second -- goes to jest unchanged

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(rootDir, 'node_modules', '.cache', 'cartlify-tests');
const selectionFile = path.join(cacheDir, 'selection.json');
const resultFile = path.join(cacheDir, 'last-run.json');

// flags the launcher handles itself, they never reach jest
const LAUNCHER_FLAGS = ['--failed', '--keep-db'];

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

  return {
    failedOnly: own.includes('--failed'),
    keepDb: own.includes('--keep-db'),
    // flags without values may also stay before the second --
    jestFlags: [
      ...own.filter((arg) => arg.startsWith('-') && !LAUNCHER_FLAGS.includes(arg)),
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

function loadSelection() {
  try {
    return JSON.parse(readFileSync(selectionFile, 'utf8'));
  } catch {
    // first run or a broken file, start with unit only
    return ['unit'];
  }
}

function saveSelection(selected) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(selectionFile, JSON.stringify(selected.map((part) => part.name)));
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
    });

    return parts.filter((part) => names.includes(part.name));
  } catch (err) {
    // ctrl+c closes the prompt with this error
    if (err?.name === 'ExitPromptError') {
      console.log('Cancelled.');
      process.exit(130);
    }

    throw err;
  }
}

async function chooseParts(parts, { words, failedOnly }) {
  if (words.length) {
    const selected = resolveWords(words, parts);
    saveSelection(selected);
    return selected;
  }

  // --failed repeats the last selection, failed tests are taken from the jest cache
  if (failedOnly) {
    const saved = loadSelection();
    return parts.filter((part) => saved.includes(part.name));
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const selected = await promptSelection(parts);
    saveSelection(selected);
    return selected;
  }

  console.log('No interactive terminal, running all test parts (pass part names to choose).');
  return parts;
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

function runJest(selected, { failedOnly, jestFlags }) {
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
    // integration tests share one database and redis, run them one by one
    ...(needsDb ? ['--runInBand'] : []),
    ...(failedOnly ? ['--onlyFailures'] : []),
    '--json',
    `--outputFile=${resultFile}`,
    ...jestFlags,
    // a trailing slash keeps api/order from matching api/orders
    ...selected.map((part) => `${part.dir}/`),
  ];

  console.log(`\n> Running: ${selected.map((part) => part.name).join(', ')}\n`);

  const result = spawnSync(process.execPath, args, { cwd: rootDir, stdio: 'inherit' });

  return result.status ?? 1;
}

function readResults() {
  try {
    return JSON.parse(readFileSync(resultFile, 'utf8'));
  } catch {
    return null;
  }
}

function printSummary(selected, parts, results, { failedOnly, jestFlags }) {
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
const selected = await chooseParts(parts, options);

if (!selected.length) fail('No test parts selected.');

const needsDb = selected.some((part) => part.integration);

if (needsDb) buildTestDatabase();

const status = runJest(selected, options);

if (needsDb && !options.keepDb) removeTestDatabase();

printSummary(selected, parts, readResults(), options);

if (needsDb && options.keepDb) {
  console.log('The test database is still running, remove it with: npm run db:test:down\n');
}

process.exit(status);
