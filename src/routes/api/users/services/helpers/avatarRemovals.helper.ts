import env from '@config/env.js';
import type { Prisma } from '@prisma/client';

import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { buildAvatarRemovedTemplate } from '@services/email/templates/users/avatarRemoved.template.js';
import { deleteImage, isOwnFile } from '@utils/cloudinary.util.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';

// the avatar of an account taken away: by its owner through PATCH /api/users/me, or by a moderator
// through DELETE /api/users/:userId/avatar. A removal by a moderator is a line of the journal of the
// admins (the action OTHER, the change of the field avatar to null): the journal keeps them for
// good, so the number of the removals of an account is the number of these lines

export type AvatarLogger = { warn: (obj: unknown, msg?: string) => void };

// the change a removal by a moderator writes to the journal
export const avatarRemovalChange = (old: string | null) => ({
  field: 'avatar',
  old,
  new: null,
});

export async function countAvatarRemovals(
  tx: Prisma.TransactionClient,
  userId: number,
): Promise<number> {
  const removal = JSON.stringify([{ field: 'avatar', new: null }]);
  const [row] = await tx.$queryRaw<{ count: number }[]>`
    select count(*)::int as count
    from cartlify.admin_audit_log
    where "entityType" = 'user'::cartlify."AdminAuditEntityType"
      and "entityId" = ${userId}::int
      and action = 'OTHER'::cartlify."AdminAuditAction"
      and meta @> ${removal}::jsonb
  `;

  return row?.count ?? 0;
}

// the file of the avatar goes once the row is written; only a file of the folder of this
// environment (dev is restored from a copy of prod, its rows can point to the files of prod).
// It never throws: the avatar is gone from the profile already, a file left goes to the log
export async function deleteAvatarFile(publicId: string | null, log: AvatarLogger): Promise<void> {
  if (!isOwnFile(publicId)) return;

  try {
    await deleteImage(publicId);
  } catch (err) {
    log.warn({ err, publicId }, 'avatar file was not deleted');
  }
}

// tells the person which removal by a moderator this is; the avatar is gone already, so a mail
// that fails is only logged, with the id of the account and never its address
export async function sendAvatarRemovedEmail(
  args: { userId: number; to: string; userName: string | null; removals: number; limit: number },
  log: AvatarLogger,
): Promise<void> {
  try {
    const { subject, text, html } = buildAvatarRemovedTemplate({
      // the name of the shop the mail is from
      appName: env.SHOP_NAME,
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
    log.warn({ err, userId: args.userId }, 'avatar removed mail was not sent');
  }
}
