import type { Role } from 'types/user.js';

// What an answer about an account says of the right to handle the money the way root does (money sent
// outside the app, rows closed without money, the decisions on refunds made by hand and on the money
// of a bank, the holds root lets go): root has it always, an admin has it when root allowed the
// account (users."canManageMoney") and the account is not deleted, nobody else has it. It is the same
// rule as cartlify.money_manager() of the database (db/05), which every route of the money asks; this
// one only fills the answers of the profile, so a page knows what to show. The routes never trust it:
// they ask the database at every request
export function canManageMoneyOf(user: {
  role: Role;
  canManageMoney: boolean;
  deletedAt?: Date | null;
}): boolean {
  if (user.role === 'ROOT') return true;
  if (user.role !== 'ADMIN') return false;

  return user.canManageMoney && !user.deletedAt;
}
