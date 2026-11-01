import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import ajvModule from 'ajv';
import ajvFormatsModule from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import {
  ADMIN_ALERT_KINDS,
  ROOT_ALERT_KINDS,
} from '@routes/api/admin/services/helpers/alertKinds.helper.js';

import { startApp, stopApp } from '../../../helpers/app.js';

// What the contract check of the integration tests cannot see: it holds the answers the tests happen
// to get against the swagger document, so a route nobody calls, a code no test provokes and an
// example nobody sends can drift. These checks read the whole document (GET /documentation/json).

const Ajv = ajvModule.default;
const addFormats = ajvFormatsModule.default;

type Content = { schema?: unknown; example?: unknown; examples?: Record<string, unknown> };
type Operation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: { in: string; name: string; description?: string }[];
  requestBody?: { content?: Record<string, Content> };
  responses?: Record<string, { description?: string; content?: Record<string, Content> }>;
};
type Document = {
  paths: Record<string, Record<string, Operation>>;
  components: Record<string, unknown>;
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

let app: FastifyInstance;
let doc: Document;

const operations = (): { name: string; operation: Operation }[] =>
  Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, operation]) => ({ name: `${method.toUpperCase()} ${path}`, operation })),
  );

// every string of the document: the texts of the operations and of the schemas
function stringsOf(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((item) => stringsOf(item, out));
  else if (node && typeof node === 'object') {
    Object.values(node).forEach((item) => stringsOf(item, out));
  }

  return out;
}

const WORDS = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

// the upper case words of the source, without the files that hold the swagger texts themselves
function wordsOfSource(dir: string, found = new Set<string>()): Set<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) wordsOfSource(path, found);
    else if (
      /\.ts$/.test(entry.name) &&
      !/\.schemas\.ts$|\.docs\.ts$|dtoSchemas\.ts$|openapi/.test(entry.name)
    ) {
      for (const word of readFileSync(path, 'utf8').matchAll(WORDS)) found.add(word[0]);
    }
  }

  return found;
}

beforeAll(async () => {
  app = await startApp();
  doc = (await app.inject({ method: 'GET', url: '/documentation/json' })).json();
});

afterAll(async () => {
  await stopApp();
});

describe('every operation of the swagger document', () => {
  it('has a summary, a tag, a description and an operation id of its own', () => {
    const gaps: string[] = [];
    const ids = new Set<string>();

    for (const { name, operation } of operations()) {
      if (!operation.summary?.trim()) gaps.push(`${name}: no summary`);
      if (!operation.tags?.length) gaps.push(`${name}: no tag`);
      if (!operation.description?.trim()) gaps.push(`${name}: no description`);
      if (!operation.operationId) gaps.push(`${name}: no operation id`);
      else if (ids.has(operation.operationId)) gaps.push(`${name}: operation id taken`);
      else ids.add(operation.operationId);
    }

    expect(gaps).toEqual([]);
  });

  it('describes its parameters', () => {
    const gaps = operations().flatMap(({ name, operation }) =>
      (operation.parameters ?? [])
        .filter((parameter) => !parameter.description?.trim())
        .map((parameter) => `${name}: ${parameter.in} ${parameter.name}`),
    );

    expect(gaps).toEqual([]);
  });

  it('describes each answer it lists', () => {
    const gaps = operations().flatMap(({ name, operation }) =>
      Object.entries(operation.responses ?? {})
        .filter(([, response]) => !response.description?.trim())
        .map(([status]) => `${name}: ${status}`),
    );

    expect(gaps).toEqual([]);
  });
});

describe('the codes the swagger document names', () => {
  // a code the code never throws is a refusal nobody can get: it is a word of the source (a
  // literal, a message of a database function) or a name of a setting of .env.example
  it('are words of the source or settings', () => {
    const known = wordsOfSource('src');
    for (const line of readFileSync('.env.example', 'utf8').matchAll(/^([A-Z][A-Z0-9_]+)=/gm)) {
      known.add(line[1]!);
    }
    // built in attributeFields.ts as `${kind}_FIELDS_INVALID`
    for (const built of ['ATTRIBUTE_GROUP_FIELDS_INVALID', 'ATTRIBUTE_OPTION_FIELDS_INVALID']) {
      known.add(built);
    }

    const named = new Set(
      stringsOf(doc).flatMap((text) => [...text.matchAll(WORDS)].map((m) => m[0])),
    );

    expect([...named].filter((word) => !known.has(word)).sort()).toEqual([]);
  });
});

describe('the lists of values the swagger document gives', () => {
  // the schema keeps its own list of the kinds of alerts; a kind the app has and the list lacks
  // would be refused by the schema of the route that follows it
  it('name the kinds of alerts the app has', () => {
    const lists: string[][] = [];
    const find = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(find);
      else if (node && typeof node === 'object') {
        const list = (node as { enum?: unknown }).enum;
        if (Array.isArray(list) && list.includes('paid_orders_waiting'))
          lists.push(list as string[]);
        Object.values(node).forEach(find);
      }
    };
    find(doc);

    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect([...list].sort()).toEqual([...ADMIN_ALERT_KINDS, ...ROOT_ALERT_KINDS].sort());
    }
  });
});

describe('the examples of the swagger document', () => {
  // an example is what a frontend developer copies: a field the schema asks for and the example
  // lacks, or the other way round, is a stale example
  it('pass the schema they sit next to', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const withoutIds = (node: unknown) =>
      JSON.parse(
        JSON.stringify(node, (key, value: unknown) => (key === '$id' ? undefined : value)),
      );
    const components = withoutIds(doc.components);
    const failures: string[] = [];

    const check = (where: string, schema: unknown, example: unknown) => {
      const validate = ajv.compile({ allOf: [withoutIds(schema)], components });

      if (!validate(example)) {
        const error = validate.errors![0]!;
        failures.push(`${where}: ${error.instancePath || '/'} ${error.message}`);
      }
    };

    for (const { name, operation } of operations()) {
      const bodies: [string, Content][] = [
        ...Object.entries(operation.requestBody?.content ?? {}).map(
          ([type, content]) => [`${name} request ${type}`, content] as [string, Content],
        ),
        ...Object.entries(operation.responses ?? {}).flatMap(([status, response]) =>
          Object.entries(response.content ?? {}).map(
            ([type, content]) => [`${name} ${status} ${type}`, content] as [string, Content],
          ),
        ),
      ];

      for (const [where, content] of bodies) {
        if (!content.schema) continue;
        if (content.example !== undefined)
          check(`${where} example`, content.schema, content.example);
        for (const [key, example] of Object.entries(content.examples ?? {})) {
          const value = (example as { value?: unknown } | null)?.value ?? example;
          check(`${where} examples.${key}`, content.schema, value);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
