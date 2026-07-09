import type { FastifySchema } from 'fastify';

// Fastify route schema extended with OpenAPI tags
type OpenApiRouteSchema = FastifySchema & {
    tags?: readonly string[];
};

// Object with route schema names as keys
type RouteSchemas = Record<string, OpenApiRouteSchema>;

// Add one OpenAPI tag to all schemas in a module
export const withOpenApiTag = <T extends RouteSchemas>(schemas: T, tag: string): T => {
    return Object.fromEntries(
        Object.entries(schemas).map(([schemaName, schema]) => [
            schemaName,
            {
                ...schema,
                tags: schema.tags ?? [tag],
            },
        ]),
    ) as T;
};