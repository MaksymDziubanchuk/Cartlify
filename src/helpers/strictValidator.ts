import ajvModule from 'ajv';
import type { FastifySchemaCompiler } from 'fastify';

// ajv is a CommonJS package that puts its class in `default` as well
const Ajv = ajvModule.default;

// The validator of a route whose body must be taken exactly as it was sent. The validator of the app
// (src/app.ts) turns "5" into 5 and takes away a field the schema does not name, which suits a form
// and is wrong for a document that is stored as it is: a block of a newsletter with a wrong type or
// a field of its own has to be refused, not mended on the way to the database. A schema that picks
// one of several shapes (oneOf) is also unsafe with removal of fields, because a shape that does not
// match would take fields away before the next shape is tried.
//
// `schemas` are the shared schemas (with $id) the route schemas refer to. Used as
// `validatorCompiler` of a route; the answer of a refusal is the one of every route (the errors of
// ajv, normalized by errorNormalizer)
export function strictValidatorCompiler(
  schemas: readonly object[],
): FastifySchemaCompiler<unknown> {
  const ajv = new Ajv({
    strict: false,
    allErrors: false,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  });

  for (const schema of schemas) ajv.addSchema(schema);

  // the function ajv makes answers true or false and keeps its errors in `errors`, which is what
  // the framework reads
  return ({ schema }) => ajv.compile(schema as object) as never;
}
