import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import authGuard, { authGuardWithoutRefresh } from '@middlewares/auth.js';
import { isRateLimitFree } from '@helpers/rateLimitFree.js';

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

// A route that takes a multipart form besides its json body lists both media types, each with its
// own schema (a file field cannot be part of the json one). For documentation only: validation
// keeps the body schema of the route, a request with a form does not pass through it.
const withFormBody = (body: unknown, formSchemaId: string): unknown => ({
    content: {
        'application/json': { schema: keepExamplesNextToRef(body) },
        'multipart/form-data': { schema: { $ref: `${formSchemaId}#` } },
    },
});

// a route that takes only a form has no json body schema, its form is all there is
const formOnlyBody = (formSchemaId: string): unknown => ({
    content: {
        'multipart/form-data': { schema: { $ref: `${formSchemaId}#` } },
    },
});

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

// A refusal that comes from a shared part of a route, not from its own code
type Refusal = { status: string; code: string; text: string };

type RouteHandlers = {
    onRequest?: unknown;
    preValidation?: unknown;
    preHandler?: unknown;
};

const hooksOf = (route: RouteHandlers): unknown[] =>
    [route.onRequest, route.preValidation, route.preHandler].flat().filter(Boolean);

// validateId and requireRole mark the guards they build with what they check
const idParamOf = (hook: unknown): string | undefined => {
    const idParam = (hook as { idParam?: unknown } | null)?.idParam;
    return typeof hook === 'function' && typeof idParam === 'string' ? idParam : undefined;
};

const allowedRolesOf = (hook: unknown): readonly string[] | undefined => {
    const roles = (hook as { allowedRoles?: unknown } | null)?.allowedRoles;
    return typeof hook === 'function' && Array.isArray(roles) ? (roles as string[]) : undefined;
};

// The refusals of the parts every route is built from: its request schema, the body parser, the
// id and role guards, the session guard, the csrf check, the rate limit and the error handler.
// They are written here once instead of in every route schema, and the contract check of the
// integration tests (tests/helpers/contract.ts) holds every answer against them
const sharedRefusals = (
    url: string,
    schema: Record<string, unknown>,
    route: RouteHandlers,
    needsCsrf: boolean,
): Refusal[] => {
    const hooks = hooksOf(route);
    const refusals: Refusal[] = [];

    if (schema.body || schema.querystring || schema.params || schema.headers) {
        refusals.push({
            status: '400',
            code: 'VALIDATION_ERROR',
            text: 'the request does not match the schema of the route; `details` names every field that failed (in, field, message).',
        });
    }
    if (schema.body) {
        refusals.push(
            { status: '400', code: 'BAD_REQUEST', text: 'the body is not valid json.' },
            {
                status: '400',
                code: 'TEXT_NUL_FORBIDDEN',
                text: 'a text of the json body holds a NUL sign, which the database keeps in no text.',
            },
            { status: '413', code: 'PAYLOAD_TOO_LARGE', text: 'the json body is over 1 MB.' },
            {
                status: '415',
                code: 'UNSUPPORTED_MEDIA_TYPE',
                text: 'the body comes in a content type the route does not read.',
            },
        );
    }
    for (const param of hooks.map(idParamOf).filter((name) => name !== undefined)) {
        refusals.push({
            status: '400',
            code: 'INVALID_ID_PARAM',
            text: `\`${param}\` is not a whole number from 1 to 2147483647.`,
        });
    }
    if (hooks.includes(authGuard)) {
        refusals.push(
            {
                status: '401',
                code: 'LOGIN_REQUIRED',
                text: 'the session cookies are not valid any more (an expired or closed session); log in again.',
            },
            {
                status: '503',
                code: 'AUTH_TEMPORARILY_UNAVAILABLE',
                text: 'the session could not be renewed right now, try again.',
            },
            {
                status: '401',
                code: 'ACCESS_TOKEN_EXPIRED',
                text: 'the access cookie names a role the account no longer has (root changed it) and the rights refused the request; renew the session with POST /api/auth/refresh, a role change closes the sessions, so the person logs in again.',
            },
        );
    }
    if (hooks.includes(authGuardWithoutRefresh)) {
        refusals.push({
            status: '401',
            code: 'ACCESS_TOKEN_EXPIRED',
            text: 'the access cookie is missing or over while a session cookie is there; renew the session with POST /api/auth/refresh and connect again.',
        });
    }
    for (const roles of hooks.map(allowedRolesOf).filter((list) => list !== undefined)) {
        refusals.push({
            status: '403',
            code: 'INSUFFICIENT_ROLE',
            text: `the route is for ${roles.join(', ')} only (a visitor without a login is GUEST).`,
        });
    }
    if (needsCsrf) {
        refusals.push({
            status: '403',
            code: 'CSRF_TOKEN_INVALID',
            text: 'the x-csrf-token header is missing or does not match the csrf cookie; take a new token from GET /api/auth/csrf and repeat the request.',
        });
    }
    if (!isRateLimitFree(url)) {
        refusals.push({
            status: '429',
            code: 'RATE_LIMITED',
            text: 'too many requests from this address in a minute; the retry-after header tells how many seconds to wait.',
        });
    }
    refusals.push({
        status: '500',
        code: 'INTERNAL_ERROR',
        text: 'an unexpected failure of the server; `reqId` of the answer finds it in the logs.',
    });

    return refusals;
};

// Each refusal goes into the description of its status next to the reasons of the route itself;
// a status the route does not list yet gets the common error answer
const withRefusals = (
    response: Record<string, unknown>,
    refusals: Refusal[],
): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...response };

    for (const { status, code, text } of refusals) {
        const entry = out[status] as { description?: string } | undefined;
        const line = `${code}: ${text}`;

        if (!entry) {
            out[status] = { description: line, $ref: 'errorResponseSchema#' };
        } else if (!(entry.description ?? '').includes(code)) {
            out[status] = { ...entry, description: `${entry.description ?? ''} ${line}`.trim() };
        }
    }

    return out;
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
            const ownResponse = (schema.response ?? {}) as Record<string, unknown>;
            const response = withRefusals(
                ownResponse,
                sharedRefusals(url, schema as Record<string, unknown>, route, needsCsrf),
            );

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
                    ...(schema.body
                        ? {
                              body: route.config?.formBodySchema
                                  ? withFormBody(schema.body, route.config.formBodySchema)
                                  : keepExamplesNextToRef(schema.body),
                          }
                        : route.config?.formBodySchema
                          ? { body: formOnlyBody(route.config.formBodySchema) }
                          : {}),
                    response: Object.fromEntries(
                        Object.entries(response).map(([statusCode, node]) => [
                            statusCode,
                            keepExamplesNextToRef(node),
                        ]),
                    ),
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