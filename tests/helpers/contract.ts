import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import ajvModule, { type ValidateFunction } from 'ajv';
import ajvFormatsModule from 'ajv-formats';

// Every answer the app gives in the integration tests is held against the swagger document the
// frontend reads (GET /documentation/json) and the response schemas of its route:
// - the status is one the route lists;
// - an error names its errorCode in the description of that status;
// - the content type is one the document gives for that status;
// - the body passes the response schema;
// - the serializer neither drops a field the route returned nor turns its null into a value.
// A test that got such an answer fails (tests/setup/integration.contract.ts), so the document
// keeps up with the code by the tests, not by hand.

// both packages are commonjs; their default export is the module, the class and the plugin are
// its default property
const Ajv = ajvModule.default;
const addFormats = ajvFormatsModule.default;
type AjvInstance = InstanceType<typeof Ajv>;

type Violation = string;

type DocResponse = { description?: string; content?: Record<string, unknown> };
type DocOperation = { responses?: Record<string, DocResponse> };
type SwaggerDocument = { paths?: Record<string, Record<string, DocOperation>> };

type SchemaNode = Record<string, unknown>;

// the raw payload of a request, before the serializer shaped it
const RAW_PAYLOAD = Symbol('contractRawPayload');
type WithRawPayload = FastifyRequest & { [RAW_PAYLOAD]?: unknown };

const violations: Violation[] = [];

// what the current test got wrong so far; the setup file takes it after every test
export function takeContractViolations(): Violation[] {
  return violations.splice(0);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// /api/users/:userId -> /api/users/{userId}, the way @fastify/swagger names the path
const docPathOf = (url: string) => url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

// the entry of a status: the exact code, then 4XX-like ranges, then default
function entryOf<T>(entries: Record<string, T> | undefined, status: number): T | undefined {
  if (!entries) return undefined;

  return (
    entries[String(status)] ??
    entries[`${String(status)[0]}XX`] ??
    entries[`${String(status)[0]}xx`] ??
    entries.default
  );
}

// a body that is not json (csv, an empty 204) is not read as json
function jsonOf(payload: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof payload !== 'string' || payload === '') return { ok: false };

  try {
    return { ok: true, value: JSON.parse(payload) };
  } catch {
    return { ok: false };
  }
}

// the fields the serializer dropped, and the nulls it turned into a value, as paths
function shapeLosses(raw: unknown, sent: unknown, path = ''): string[] {
  if (Array.isArray(raw) && Array.isArray(sent)) {
    return raw.flatMap((item, index) => shapeLosses(item, sent[index], `${path}[${index}]`));
  }
  if (!isRecord(raw) || !isRecord(sent)) return [];

  return Object.entries(raw).flatMap(([key, value]) => {
    const at = path ? `${path}.${key}` : key;

    if (!(key in sent)) return [`field ${at} is dropped by the schema`];
    if (value === null && sent[key] !== null) {
      return [`field ${at} is null but the schema has no null, it is sent as ${JSON.stringify(sent[key])}`];
    }

    return shapeLosses(value, sent[key], at);
  });
}

export function installContractCheck(app: FastifyInstance): void {
  let doc: SwaggerDocument | undefined;
  let ajv: AjvInstance | undefined;
  const validators = new Map<string, ValidateFunction | null>();

  // the shared schemas of the app, by their $id, so the $refs of a route resolve
  const ajvOf = (): AjvInstance => {
    if (ajv) return ajv;

    ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const schema of Object.values(app.getSchemas())) ajv.addSchema(schema as SchemaNode);

    return ajv;
  };

  // the response schema of a route for a status and a content type, null when it has none
  const validatorOf = (req: FastifyRequest, status: number, contentType: string) => {
    const key = `${req.method} ${req.routeOptions.url} ${status} ${contentType}`;
    if (validators.has(key)) return validators.get(key)!;

    const responses = req.routeOptions.schema?.response as Record<string, unknown> | undefined;
    let node = entryOf(responses, status) as SchemaNode | undefined;
    if (isRecord(node?.content)) {
      const byType = (node.content as Record<string, { schema?: SchemaNode }>)[contentType];
      node = byType?.schema;
    }

    const validate = node ? ajvOf().compile(node) : null;
    validators.set(key, validate);
    return validate;
  };

  const report = (req: FastifyRequest, status: number, problem: string) => {
    const line = `${req.method} ${req.routeOptions.url} ${status}: ${problem}`;
    if (!violations.includes(line)) violations.push(line);
  };

  app.addHook('preSerialization', async (req, _reply, payload) => {
    (req as WithRawPayload)[RAW_PAYLOAD] = payload;
    return payload;
  });

  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload) => {
    const url = req.routeOptions.url;
    const method = req.method.toLowerCase();

    // no route (404 of an unknown address), the documentation itself, files, preflights
    if (!url || url.startsWith('/documentation') || url.startsWith('/static')) return payload;
    if (method === 'options' || method === 'head') return payload;
    if (req.routeOptions.schema?.hide) return payload;

    doc ??= app.swagger() as SwaggerDocument;
    const status = reply.statusCode;
    // a route of a prefix ('/' under /api/products) answers with and without the slash, the
    // document names it with one
    const path = docPathOf(url);
    const operation = [path, `${path}/`, path.replace(/\/$/, '')]
      .map((candidate) => doc!.paths?.[candidate]?.[method])
      .find(Boolean);

    if (!operation) {
      report(req, status, 'the route is missing from the swagger document');
      return payload;
    }

    const documented = entryOf(operation.responses, status);
    if (!documented) {
      report(req, status, `status ${status} is not among the answers of the route`);
      return payload;
    }

    const contentType = String(reply.getHeader('content-type') ?? '').split(';')[0]!.trim();
    const body = jsonOf(payload);

    // a body of a type the document does not give for this status
    if (contentType && documented.content && !(contentType in documented.content)) {
      report(req, status, `the answer is ${contentType}, the document gives ${Object.keys(documented.content).join(', ')}`);
    }
    if (!documented.content && typeof payload === 'string' && payload !== '') {
      report(req, status, 'the answer has a body, the document gives none');
    }

    if (body.ok && status >= 400 && isRecord(body.value)) {
      const errorCode = body.value.errorCode;
      if (typeof errorCode === 'string' && !(documented.description ?? '').includes(errorCode)) {
        report(req, status, `error code ${errorCode} is not named in the description of ${status}`);
      }
    }

    if (body.ok && contentType === 'application/json') {
      const validate = validatorOf(req, status, contentType);
      if (validate && !validate(body.value)) {
        for (const error of validate.errors ?? []) {
          report(req, status, `the body does not pass the schema: ${error.instancePath || '/'} ${error.message}`);
        }
      }

      const raw = (req as WithRawPayload)[RAW_PAYLOAD];
      if (validate && raw !== undefined) {
        // what the route returned, the way json writes it (dates as strings, decimals as text)
        const returned: unknown = JSON.parse(JSON.stringify(raw));
        for (const loss of shapeLosses(returned, body.value)) report(req, status, loss);
      }
    }

    return payload;
  });
}
