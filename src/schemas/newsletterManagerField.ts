// the right to run the newsletters in an answer that names an account (src/helpers/
// newsletterManager.ts): every answer that carries the role of an account gives it next to the role

export const canManageNewslettersField = {
  type: 'boolean',
  description:
    'May the account run the newsletters: always true for root, true for an admin whom root ' +
    'allowed, false for a user and for an admin root did not allow. The page shows the section of ' +
    'the newsletters by it. Do not keep it for long: read it again from GET /api/users/me at every ' +
    'opening of the app, because root can take the right away at any time (the server checks it ' +
    'in the database at every request, never from this answer).',
} as const;
