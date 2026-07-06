import type { FastifySchema } from 'fastify';

type OpenApiRouteSchema = FastifySchema & {
    tags?: readonly string[];
};

type RouteSchemas = Record<string, OpenApiRouteSchema>;

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