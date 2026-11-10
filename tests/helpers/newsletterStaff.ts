import { asAdmin } from './db.js';
import { closeSessions, createUser, type TestUser } from './factories.js';
import { giveNewsletterRight } from './newsletterManager.js';

// The people who run the newsletters and the people who must not, for the tests of the routes of the
// subscribers and of the blocklist: root, an admin whom root allowed (the right is given by the
// function of the database, the way the route of root does it), an admin without the right and a
// user. Every account is made once for the file; closeStaff closes their sessions at its end

export type NewsletterStaff = {
  root: TestUser;
  manager: TestUser;
  plainAdmin: TestUser;
  user: TestUser;
};

export async function createNewsletterStaff(): Promise<NewsletterStaff> {
  const root = await createUser({ role: 'ROOT' });
  const manager = await createUser({ role: 'ADMIN' });
  const plainAdmin = await createUser({ role: 'ADMIN' });
  const user = await createUser();

  await giveNewsletterRight(root.id, manager.id);

  return { root, manager, plainAdmin, user };
}

export const closeStaff = (staff: NewsletterStaff) =>
  closeSessions([staff.root.id, staff.manager.id, staff.plainAdmin.id, staff.user.id]);

// the lines of the admin log about one subscriber or one blocked address, the oldest first
export const auditLinesOf = (
  entityType: 'newsletter_subscriber' | 'newsletter_block',
  entityId: number,
) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType, entityId },
      orderBy: { id: 'asc' },
      select: {
        actorId: true,
        actorRole: true,
        entityType: true,
        entityId: true,
        action: true,
        event: true,
        meta: true,
      },
    }),
  );
