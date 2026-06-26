export const openApiInfo = {
    title: 'Cartlify REST API',
    description: 'OpenAPI documentation for the Cartlify REST API.',
    version: '1.0.0',
} as const;

export const openApiTags = [
    { name: 'system', description: 'System status and project information' },
    { name: 'auth', description: 'Authentication and authorization' },
    { name: 'users', description: 'User management' },
    { name: 'products', description: 'Product management' },
    { name: 'categories', description: 'Category management' },
    { name: 'orders', description: 'Order management' },
    { name: 'payments', description: 'Payment processing' },
    { name: 'favorites', description: 'User favorites' },
    { name: 'reviews', description: 'Product reviews and votes' },
    { name: 'chat', description: 'User, bot and administrator chats' },
    { name: 'admin', description: 'Administrator operations' },
    { name: 'root', description: 'Root administrator operations' },
] as const;