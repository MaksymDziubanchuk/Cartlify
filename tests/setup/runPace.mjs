// How long a run of the tests takes, told before it starts. Jest guesses from the time each file
// took the last time, added up and shared among its workers; here that guess is far off: the
// shopwide files run one by one at the end, the time such a file took holds its wait for the files
// before it. So the launcher keeps its own record (node_modules/.cache/cartlify-tests/pace.json,
// outside git) and makes its own guess of the tests:
//   - the time every file took the last time it ran whole, apart for the mocks and for each set of
//     real services (a file that asks the real Stripe takes minutes, its mock seconds);
//   - how long the last run of the same parts with the same workers took: the guess of the next one;
//   - for any other selection, the files added up, shared among the workers and corrected by how
//     far that sum was off in the last run with as many workers, with the time jest takes to start
//     and to write its report (what a run took beyond its files).
// The guess goes to jest (tests/setup/sequencer.mjs), whose "estimated" tells it; the launcher
// prints nothing of its own. The build of the test database is before jest starts and is not in it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// fewer files than this say little of how the workers share them
const FILES_FOR_A_FACTOR = 8;

export function readPace(file) {
  try {
    const pace = JSON.parse(readFileSync(file, 'utf8'));
    return pace && typeof pace === 'object' ? pace : {};
  } catch {
    // the first run, or a broken file
    return {};
  }
}

export function writePace(file, pace) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(pace, null, 2));
}

// the mocks, or the real services of the run by their names
export const modeOf = (realServices) =>
  realServices.length ? [...realServices].sort().join('+') : 'mock';

export const runKeyOf = (parts, workers) => `${parts.join(',')}|${workers}`;

// The guess of the tests: { ms, same } with same true when it is the
// time of the last run of these parts; null while no file of the selection has a time.
//   files: the test files of the selection, from the root, with forward slashes
//   workers: how many files jest runs at a time
//   runKey: the key of a run of whole parts (runKeyOf), none for a run with filters
export function guessOf(pace, { mode, files, workers, runKey }) {
  const kept = pace[mode] ?? {};

  const last = runKey ? kept.runs?.[runKey] : undefined;
  if (Number.isFinite(last) && last > 0) return { ms: last, same: true };

  const known = files.map((file) => kept.files?.[file]).filter((ms) => Number.isFinite(ms));
  if (!known.length) return null;

  // a file that never ran takes what the others take on average
  const sum = known.reduce((total, ms) => total + ms, 0);
  const all = sum + (files.length - known.length) * (sum / known.length);
  const factor = kept.factors?.[String(workers)] ?? 1;
  const around = Number.isFinite(kept.aroundMs) ? kept.aroundMs : 0;

  return { ms: Math.max((all / workers) * factor, Math.max(...known)) + around, same: false };
}

// What a run that ended tells the next one.
//   results: the json jest wrote; wallMs: how long jest ran
//   whole: every file ran whole (no filter of jest inside the files, not only the failed ones)
//   runKey: the key of a run of whole parts, none when files were picked by hand
export function recordRun(pace, { mode, results, rootDir, workers, wallMs, whole, runKey }) {
  if (!whole || !results?.testResults?.length) return pace;

  const kept = { files: {}, factors: {}, runs: {}, ...pace[mode] };
  let sum = 0;
  let count = 0;
  let first = Infinity;
  let last = 0;

  for (const file of results.testResults) {
    const took = file.endTime - file.startTime;
    if (!Number.isFinite(took) || took <= 0) continue;

    const relative = path.relative(rootDir, file.name).split(path.sep).join('/');
    kept.files = { ...kept.files, [relative]: took };
    sum += took;
    count += 1;
    first = Math.min(first, file.startTime);
    last = Math.max(last, file.endTime);
  }

  if (count) {
    // from the first file to the last one, and what jest took around them
    const span = last - first;
    kept.aroundMs = Math.max(0, wallMs - span);
    if (count >= FILES_FOR_A_FACTOR && sum > 0) {
      kept.factors = { ...kept.factors, [String(workers)]: span / (sum / workers) };
    }
  }
  if (runKey) kept.runs = { ...kept.runs, [runKey]: wallMs };

  return { ...pace, [mode]: kept };
}

// The times jest reads to tell its "estimated": every file gets the same share of the guess, so
// that jest's own sum (the times added up and shared among the workers, at least the longest of
// them) gives the guess back. Jest also reads the times to choose between its workers and one
// process: a run of at most 20 files that all took under a second goes in one process. The times
// are left alone wherever the new ones would change that choice.
const JEST_SLOW_MS = 1000;
const JEST_FEW_FILES = 20;

export function pacedTests(tests, guessMs, workers) {
  if (!Number.isFinite(guessMs) || guessMs <= 0 || !Number.isFinite(workers) || workers < 1) {
    return tests;
  }
  // with a worker for every file jest tells the longest of them
  const share =
    tests.length <= workers ? Math.round(guessMs) : Math.round((guessMs * workers) / tests.length);

  if (tests.length <= JEST_FEW_FILES) {
    const timed = tests.filter((test) => test.duration);
    const wereFast = timed.length > 0 && timed.every((test) => test.duration < JEST_SLOW_MS);
    if (wereFast || share < JEST_SLOW_MS) return tests;
  }

  return tests.map((test) => ({ ...test, duration: share }));
}

// The line "Time:" of jest tells seconds only (1251.77 s, estimated 1290 s), hard to read for a run
// of many minutes: from a minute on it becomes 20 min 52 s. The other lines are left as they are
const TIME_LINE = /^.*Time:.*$/gm;
const SECONDS = /(\d+(?:\.\d+)?) s\b/g;

export function timeInMinutes(text) {
  if (typeof text !== 'string') return text;

  return text.replace(TIME_LINE, (line) =>
    line.replace(SECONDS, (told, value) => {
      const seconds = Math.round(Number(value));
      return seconds < 60 ? told : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
    }),
  );
}
