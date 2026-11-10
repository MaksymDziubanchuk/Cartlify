import type { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { writeNewsletterAuditLog, type AuditChange } from '@db/adminAudit.helper.js';
import { setUserContext } from '@db/dbContext.service.js';
import { emailHmacOf, normalizeEmail } from '@helpers/newsletterTokens.js';
import { isEmail } from '@helpers/validateEmail.js';
import { NEWSLETTER_EMAIL_MAX_LENGTH } from '@schemas/dto/newsletters.dtoSchemas.js';
import { BadRequestError, InternalError, NotFoundError } from '@utils/errors.js';
import type {
  AddBlockDto,
  FindBlockedDto,
  NewsletterBlockAddedResponseDto,
  NewsletterBlockEntryDto,
  NewsletterBlockLookupResponseDto,
  NewsletterBlockRemovedResponseDto,
  RemoveBlockDto,
} from 'types/dto/newsletters.dto.js';

import { withNewsletterErrors } from './helpers/newsletterErrors.helper.js';

type Tx = Prisma.TransactionClient;

// The blocklist of the public form for the people who run the newsletters (root, and an admin whom
// root allowed). The list holds the HMAC of an address and no address, so an admin finds an entry by
// typing the address and never reads the addresses of the list: the server makes the HMAC of the
// address as the database writes it into a subscription (trimmed, in lower case), the same text the
// form hashes, so one address is one entry however it is written. The HMAC never leaves the server

// The columns of an entry an admin sees: no HMAC
const ENTRY_SELECT = {
  id: true,
  createdAt: true,
  blockedById: true,
  byPerson: true,
  reason: true,
} as const;

// The address as the server hashes it. The schema of the route lets the spaces around an address
// through (they are cut, as the database does); the format is checked here, because the database
// cannot: a list of HMACs holds anything that is hashed to a hex string
function addressOf(email: string): string {
  const address = normalizeEmail(email);

  if (address.length > NEWSLETTER_EMAIL_MAX_LENGTH || !isEmail(address)) {
    throw new BadRequestError('INVALID_EMAIL');
  }

  return address;
}

const entryOf = (db: Tx, emailHmac: string): Promise<NewsletterBlockEntryDto | null> =>
  db.newsletterFormBlock.findUnique({ where: { emailHmac }, select: ENTRY_SELECT });

// whether the address is on the list, and the entry (when, by whom, why)
export async function findBlocked(dto: FindBlockedDto): Promise<NewsletterBlockLookupResponseDto> {
  const emailHmac = emailHmacOf(addressOf(dto.email));

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      const entry = await entryOf(db, emailHmac);

      return { blocked: entry !== null, entry };
    }),
  );
}

// Blocks an address for the form (newsletter_block_add: the entry names the admin, the reason is
// trimmed and cut to the 200 characters the list keeps, and a request of the address that waits for
// its confirmation is removed; a subscription in force stays). An address blocked already is no
// error: the first entry and its reason stay. The line of the admin log is written in the same
// transaction, only for an entry made now, and carries the id of the entry and the reason, never the
// address
export async function addBlock(dto: AddBlockDto): Promise<NewsletterBlockAddedResponseDto> {
  const emailHmac = emailHmacOf(addressOf(dto.email));

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      const rows = await db.$queryRaw<{ added: boolean }[]>`
        select cartlify.newsletter_block_add(${emailHmac}::text, ${dto.reason ?? null}::text) as added
      `;
      const created = rows[0]?.added === true;

      const entry = await entryOf(db, emailHmac);
      // removed by another admin between the two statements
      if (!entry) throw new InternalError({ reason: 'NEWSLETTER_BLOCK_ENTRY_LOST' });

      if (created) {
        const changes: AuditChange[] = [{ field: 'blocked', old: false, new: true }];
        if (entry.reason !== null) changes.push({ field: 'reason', old: null, new: entry.reason });

        await writeNewsletterAuditLog(db, {
          actorId: dto.actorId,
          actorRole: dto.actorRole,
          event: 'newsletter.block_added',
          entityId: entry.id,
          changes,
        });
      }

      return { created, entry };
    }),
  );
}

// Takes an entry off the list: a plain DELETE under the policy of the table (a manager may). The line
// of the admin log is written in the same transaction, only when a row went, so two admins removing
// the entry together write one line and the other one gets 404
export async function removeBlock(dto: RemoveBlockDto): Promise<NewsletterBlockRemovedResponseDto> {
  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      const removed = await db.newsletterFormBlock.deleteMany({ where: { id: dto.blockId } });
      if (removed.count === 0) throw new NotFoundError('NEWSLETTER_BLOCK_NOT_FOUND');

      await writeNewsletterAuditLog(db, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        event: 'newsletter.block_removed',
        entityId: dto.blockId,
        changes: [{ field: 'blocked', old: true, new: false }],
      });

      return { removed: true as const };
    }),
  );
}
