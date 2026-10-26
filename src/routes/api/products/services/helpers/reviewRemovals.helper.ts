import env from '@config/env.js';
import type { Prisma } from '@prisma/client';

import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { buildReviewRemovedTemplate } from '@services/email/templates/users/reviewRemoved.template.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';

// a review an admin or root deletes is a removal of the author: a line of the journal of the admins
// (REVIEW_DELETE, the author as the old userId of its changes). The journal keeps them for good, so
// the removals of an author are these lines; an author who deletes an own review writes none

export type ReviewRemovalLogger = { warn: (obj: unknown, msg?: string) => void };

export async function countReviewRemovals(
  tx: Prisma.TransactionClient,
  userId: number,
): Promise<number> {
  const author = JSON.stringify([{ field: 'userId', old: userId }]);
  const [row] = await tx.$queryRaw<{ count: number }[]>`
    select count(*)::int as count
    from cartlify.admin_audit_log
    where "entityType" = 'review'::cartlify."AdminAuditEntityType"
      and action = 'REVIEW_DELETE'::cartlify."AdminAuditAction"
      and meta @> ${author}::jsonb
  `;

  return row?.count ?? 0;
}

// tells the author which removal this is; the review is gone already, so a mail that fails is only
// logged, with the id of the account and never its address
export async function sendReviewRemovedEmail(
  args: {
    userId: number;
    to: string;
    userName: string | null;
    productName: string;
    removals: number;
    limit: number;
  },
  log: ReviewRemovalLogger,
): Promise<void> {
  try {
    const { subject, text, html } = buildReviewRemovedTemplate({
      // the name of the shop the mail is from
      appName: env.SHOP_NAME,
      productName: args.productName,
      removals: args.removals,
      limit: args.limit,
      userName: args.userName,
      logoCid: SHOP_LOGO_CID,
    });

    await sendEmail({
      to: args.to,
      subject,
      text,
      html,
      attachments: [await shopLogoAttachment()],
    });
  } catch (err) {
    log.warn({ err, userId: args.userId }, 'review removed mail was not sent');
  }
}
