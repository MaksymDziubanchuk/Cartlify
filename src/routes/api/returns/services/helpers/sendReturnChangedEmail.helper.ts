import { Prisma } from '@prisma/client';

import { shopSettings } from '@config/shopSettings.js';
import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { failureOf } from '@helpers/failureOf.js';
import { mailLocaleOf } from '@helpers/locale.js';
import { returnCodeOf } from '@helpers/returns.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';
import { buildReturnChangedTemplate } from '@services/email/templates/returns/returnChanged.template.js';

import type { ReturnMailLogger } from './sendReturnByShopEmail.helper.js';

// the statements of the form without the code of an order that gave units up in this transaction:
// create_return of a statement of the account or of the code marks the rows it took over with the
// code stated_again and the moment of the transaction
export async function manualStatementsTakenOf(
  db: Prisma.TransactionClient,
  orderId: number,
): Promise<number[]> {
  const rows = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
    select distinct r.id
    from cartlify.returns as r
    join cartlify.return_items as i on i."returnId" = r.id
    where r."orderId" = ${orderId}::int
      and r.source = 'form_manual'
      and i."refusedCode" = 'stated_again'
      and i."goodsSetAt" = (now() at time zone 'UTC')::timestamp(3)
    order by r.id
  `);
  return rows.map((row) => row.id);
}

// the statement as the mail tells it; read after the commit, as the system
function loadReturn(returnId: number) {
  return prisma.$transaction(async (tx) => {
    await setAdminContext(tx);

    const row = await tx.orderReturn.findUnique({
      where: { id: returnId },
      select: {
        orderId: true,
        number: true,
        basis: true,
        contactName: true,
        contactEmail: true,
        items: { select: { money: true } },
      },
    });
    return row;
  });
}

// mails the person of a statement of the form without the code that its units are handled in another
// statement of the order (one of the buyer took them over): not who made it and not the units, the
// person of the form may not be the buyer. The new statement is kept before this runs, so a mail
// that fails is only logged
export async function sendReturnChangedEmail(
  returnId: number,
  log: ReturnMailLogger,
): Promise<void> {
  try {
    const row = await loadReturn(returnId);

    if (!row) {
      log.warn({ returnId }, 'return mail skipped: the statement is gone');
      return;
    }

    const logo = await shopLogoAttachment(log);

    const { subject, text, html } = buildReturnChangedTemplate({
      appName: shopSettings().shopName,
      orderId: row.orderId,
      code: returnCodeOf(row.basis, row.orderId, row.number),
      // nothing of it is left to handle: every row is refused
      allTaken: row.items.every((item) => item.money === 'refused'),
      supportEmail: shopSettings().emailReplyTo,
      // the form has no account to read a language from: the mail goes in the shop's language
      locale: mailLocaleOf(null),
      ...(row.contactName ? { userName: row.contactName } : {}),
      ...(logo ? { logoCid: SHOP_LOGO_CID } : {}),
    });

    await sendEmail({
      to: row.contactEmail,
      subject,
      text,
      html,
      attachments: logo ? [logo] : [],
    });
  } catch (err) {
    log.error({ ...failureOf(err), returnId }, 'return changed mail was not sent');
  }
}
