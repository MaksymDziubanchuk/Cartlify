// the right to handle the money the way root does in an answer that names an account (src/helpers/
// moneyManager.ts): every answer that carries the role of an account gives it next to the role

export const canManageMoneyField = {
  type: 'boolean',
  description:
    'May the account handle the money the way root does (money sent outside the app, rows of a ' +
    'statement closed without money, the decisions on refunds made by hand in the dashboard of ' +
    'the payment provider and on the money of a bank, the holds root lets go): always true for ' +
    'root, true for an admin whom root allowed, false for a user and for an admin root did not ' +
    'allow. The page shows those actions by it. Do not keep it for long: read it again from GET ' +
    '/api/users/me at every opening of the app, because root can take the right away at any time ' +
    '(the server checks it in the database at every request, never from this answer).',
} as const;
