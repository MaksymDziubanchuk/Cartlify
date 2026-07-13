// OpenAPI general project information
export const openApiInfo = {
    title: 'Cartlify REST API',
    description: 'REST API documentation for Cartlify.',
    version: '1.0.0',
} as const;

// OpenAPI server list for deployed and local environments
export const openApiServers = [
    {
        url: 'https://cartlify.up.railway.app',
        description: 'Railway deployment',
    },
    {
        url: 'http://localhost:3000',
        description: 'Local development server',
    },
] as const;

// OpenAPI route groups shown in Swagger UI
export const openApiTags = [
    { name: 'system', description: 'System health, readiness and project information' },
    { name: 'auth', description: 'Registration, login, logout, refresh and OAuth flows' },
    { name: 'users', description: 'User profile and account operations' },
    { name: 'products', description: 'Product catalog, product details and product reviews' },
    { name: 'categories', description: 'Product categories' },
    { name: 'orders', description: 'Cart and order operations' },
    { name: 'payments', description: 'Checkout sessions and payment webhooks' },
    { name: 'favorites', description: 'User favorites' },
    { name: 'reviews', description: 'Review votes and review actions' },
    { name: 'chat', description: 'Bot, user and admin chat operations' },
    { name: 'admin', description: 'Admin dashboard and management operations' },
    { name: 'root', description: 'Root-only administrator management' },
] as const;

// Cookie-based security schemes used by Swagger authorization UI
export const openApiSecuritySchemes = {
    accessTokenCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'accessToken',
        description: 'JWT access token stored in an HTTP-only cookie.',
    },

    refreshTokenCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'refreshToken',
        description: 'JWT refresh token stored in an HTTP-only cookie.',
    },

    guestIdCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'guestId',
        description: 'Guest session identifier stored in an HTTP-only cookie.',
    },
} as const;

// Reusable OpenAPI security presets for route schemas
export const openApiSecurity = {
    accessTokenCookie: [{ accessTokenCookie: [] }],
    refreshTokenCookie: [{ refreshTokenCookie: [] }],
    authCookies: [{ accessTokenCookie: [] }, { refreshTokenCookie: [] }],
    guestIdCookie: [{ guestIdCookie: [] }],
    userOrGuestCookie: [{ accessTokenCookie: [] }, { guestIdCookie: [] }],
} as const;