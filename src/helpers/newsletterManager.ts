import type { Role } from 'types/user.js';

// What an answer about an account says of the right to run the newsletters: root has it always, an
// admin has it when root allowed the account (users."canManageNewsletters") and the account is not
// deleted, nobody else has it. It is the same rule as cartlify.newsletter_manager() of the database
// (db/05), which every route of the newsletters asks; this one only fills the answers of the profile,
// so a page knows what to show. The routes never trust it: they ask the database at every request
export function canManageNewslettersOf(user: {
  role: Role;
  canManageNewsletters: boolean;
  deletedAt?: Date | null;
}): boolean {
  if (user.role === 'ROOT') return true;
  if (user.role !== 'ADMIN') return false;

  return user.canManageNewsletters && !user.deletedAt;
}
