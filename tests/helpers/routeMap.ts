import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect } from '@jest/globals';

// TEST_ROUTE_MAP=<folder> writes down which route, actor role and answer (status and error code)
// each test file got: one json line per distinct answer, a file per jest worker, and the swagger
// document once. The route x role x case map is built from these lines; without the variable
// nothing is kept.
const folder = process.env.TEST_ROUTE_MAP;
const answers = new Set<string>();

export function recordAnswer(answer: {
  method: string;
  url: string;
  role: string;
  status: number;
  code: string | null;
}): void {
  if (!folder) return;

  const testPath = expect.getState().testPath ?? '';
  const file = path.relative(process.cwd(), testPath).replaceAll('\\', '/');
  answers.add(JSON.stringify({ file, ...answer }));
}

export function recordDocument(document: unknown): void {
  if (!folder) return;

  const target = path.join(folder, 'openapi.json');
  if (existsSync(target)) return;
  mkdirSync(folder, { recursive: true });
  writeFileSync(target, JSON.stringify(document));
}

// after each test file, so a worker that dies keeps what the files before it got
export function flushRouteMap(): void {
  if (!folder || answers.size === 0) return;

  mkdirSync(folder, { recursive: true });
  appendFileSync(path.join(folder, `answers-${process.pid}.jsonl`), [...answers].join('\n') + '\n');
  answers.clear();
}
