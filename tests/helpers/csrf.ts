import type { FastifyInstance } from 'fastify';

export type Csrf = {
  // goes to the x-csrf-token header
  token: string;
  // name=value of the secret cookie, the browser sends it back by itself
  cookie: string;
};

// what a page holds after GET /api/auth/csrf, needed by every POST, PUT, PATCH and DELETE
export async function getCsrf(app: FastifyInstance): Promise<Csrf> {
  const res = await app.inject({ method: 'GET', url: '/api/auth/csrf' });

  const cookie = [res.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map(String)
    .find((line) => line.startsWith('csrf='));

  if (res.statusCode !== 200 || !cookie) {
    throw new Error(`GET /api/auth/csrf gave no token (status ${res.statusCode})`);
  }

  return { token: res.json().csrfToken, cookie: cookie.split(';')[0]! };
}

// headers of a request that changes data: the other cookies of the request plus the csrf pair
export const withCsrf = (csrf: Csrf, cookie = '') => ({
  cookie: [cookie, csrf.cookie].filter(Boolean).join('; '),
  'x-csrf-token': csrf.token,
});
