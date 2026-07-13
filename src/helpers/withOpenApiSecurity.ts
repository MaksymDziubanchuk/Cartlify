import type { FastifySchema } from 'fastify';

// OpenAPI security requirement array
type OpenApiSecurity = NonNullable<FastifySchema['security']>;

// Fastify route schema extended with OpenAPI security
type OpenApiRouteSchema = FastifySchema & {
    security?: OpenApiSecurity;
};

// Object with route schema names as keys
type RouteSchemas = Record<string, OpenApiRouteSchema>;

// Add OpenAPI security to all schemas in a module
export const withOpenApiSecurity = <T extends RouteSchemas>(
    schemas: T,
    security: OpenApiSecurity,
): T => {
    return Object.fromEntries(
        Object.entries(schemas).map(([schemaName, schema]) => [
            schemaName,
            {
                ...schema,
                security: schema.security ?? security,
            },
        ]),
    ) as T;
};

// Add OpenAPI security only to selected schemas in a module
export const withOpenApiSecurityFor = <T extends RouteSchemas>(
    schemas: T,
    security: OpenApiSecurity,
    schemaNames: readonly (keyof T)[],
): T => {
    const protectedSchemaNames = new Set<keyof T>(schemaNames);

    return Object.fromEntries(
        Object.entries(schemas).map(([schemaName, schema]) => [
            schemaName,
            protectedSchemaNames.has(schemaName as keyof T)
                ? {
                    ...schema,
                    security: schema.security ?? security,
                }
                : schema,
        ]),
    ) as T;
};