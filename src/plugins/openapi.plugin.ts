import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { requiresCsrfToken } from './csrf.plugin.js';

import {
    openApiInfo,
    openApiSecuritySchemes,
    openApiServers,
    openApiTags,
} from '@config/openapi.js';

// Swagger generator drops every key placed next to $ref, including route examples.
// Wrap such references in allOf for documentation only, so examples reach the generated spec.
const keepExamplesNextToRef = (node: unknown): unknown => {
    if (typeof node !== 'object' || node === null) return node;

    const { $ref, ...rest } = node as Record<string, unknown>;

    if (typeof $ref !== 'string' || !Array.isArray(rest.examples)) return node;

    return { ...rest, allOf: [{ $ref }] };
};

const isSchemaNode = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Parameters are documented one by one, so a single example object is spread over its properties.
// The referenced schema is inlined for documentation only.
const spreadExampleOverParams = (
    node: unknown,
    getSchema: (schemaId: string) => unknown,
): unknown => {
    if (!isSchemaNode(node) || !Array.isArray(node.examples)) return node;

    const example: unknown = node.examples[0];
    const target = typeof node.$ref === 'string' ? getSchema(node.$ref.split('#')[0]) : node;

    if (!isSchemaNode(example) || !isSchemaNode(target) || !isSchemaNode(target.properties)) {
        return node;
    }

    return {
        ...Object.fromEntries(
            Object.entries(target).filter(([key]) => key !== '$id' && key !== 'examples'),
        ),
        properties: Object.fromEntries(
            Object.entries(target.properties).map(([name, property]) => [
                name,
                name in example && isSchemaNode(property)
                    ? keepExamplesNextToRef({ ...property, examples: [example[name]] })
                    : property,
            ]),
        ),
    };
};

type SecurityRequirement = { readonly [securityLabel: string]: readonly string[] };

// A route that changes data also needs the csrf header, next to whatever cookie it needs
const withCsrfToken = (security?: readonly SecurityRequirement[]): SecurityRequirement[] =>
    security?.length
        ? security.map((requirement) => ({ ...requirement, csrfTokenHeader: [] }))
        : [{ csrfTokenHeader: [] }];

const CSRF_REFUSAL =
    'CSRF_TOKEN_INVALID: the x-csrf-token header is missing or does not match the csrf cookie; ' +
    'take a new token from GET /api/auth/csrf and repeat the request.';

// Every such route can also refuse a request for its csrf token, next to its own 403 reasons
const withCsrfRefusal = (response: Record<string, unknown>): Record<string, unknown> => {
    const forbidden = response['403'] as { description?: string } | undefined;

    return {
        ...response,
        403: forbidden
            ? { ...forbidden, description: `${forbidden.description ?? ''} Or ${CSRF_REFUSAL}`.trim() }
            : { description: CSRF_REFUSAL, $ref: 'errorResponseSchema#' },
    };
};

// Swagger UI runs in the browser, this function is copied into its page as source:
// a request that changes data first takes a csrf token, the same way the frontend does
const addCsrfToken = async (request: { method?: string; headers?: Record<string, string> }) => {
    const method = (request.method ?? 'GET').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return request;

    const res = await fetch('/api/auth/csrf', { credentials: 'include' });
    const body = (await res.json()) as { csrfToken?: string };
    if (body.csrfToken) request.headers = { ...request.headers, 'x-csrf-token': body.csrfToken };

    return request;
};

// Register OpenAPI specification and Swagger UI
const openApiPlugin: FastifyPluginAsync = async (app) => {
    // Register OpenAPI generator before API routes are registered
    await app.register(swagger, {
        openapi: {
            openapi: '3.0.3',

            info: openApiInfo,

            servers: [...openApiServers],

            tags: [...openApiTags],

            components: {
                securitySchemes: openApiSecuritySchemes,
            },
        },

        // Adjust route schemas for documentation only, validation and serialization keep the originals
        transform: ({ schema, url, route }) => {
            if (!schema) return { schema, url };

            const getSchema = (schemaId: string) => app.getSchema(schemaId);
            const needsCsrf = [route.method]
                .flat()
                .some((method) => requiresCsrfToken(method, route.config));
            const ownResponse = schema.response as Record<string, unknown> | undefined;
            const response = ownResponse && needsCsrf ? withCsrfRefusal(ownResponse) : ownResponse;

            return {
                url,
                schema: {
                    ...schema,
                    ...(needsCsrf ? { security: withCsrfToken(schema.security) } : {}),
                    ...(schema.params
                        ? { params: spreadExampleOverParams(schema.params, getSchema) }
                        : {}),
                    ...(schema.querystring
                        ? { querystring: spreadExampleOverParams(schema.querystring, getSchema) }
                        : {}),
                    ...(schema.headers
                        ? { headers: spreadExampleOverParams(schema.headers, getSchema) }
                        : {}),
                    ...(schema.body ? { body: keepExamplesNextToRef(schema.body) } : {}),
                    ...(response
                        ? {
                              response: Object.fromEntries(
                                  Object.entries(response).map(([statusCode, node]) => [
                                      statusCode,
                                      keepExamplesNextToRef(node),
                                  ]),
                              ),
                          }
                        : {}),
                },
            };
        },
    });

    // Register Swagger UI page
    await app.register(swaggerUi, {
        routePrefix: '/documentation',

        uiConfig: {
            docExpansion: 'list',
            deepLinking: true,
            requestInterceptor: addCsrfToken,
        },
    });
};

// Export as fastify-plugin to avoid plugin encapsulation issues
export default fp(openApiPlugin, {
    name: 'openapi-plugin',
});