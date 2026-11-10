import type { FastifyBaseLogger } from 'fastify';

import env from '@config/env.js';
import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { verifySendGridSignature } from '@helpers/sendGridSignature.js';
import { BadRequestError, ServiceUnavailableError, UnauthorizedError } from '@utils/errors.js';
import type {
  HandleSendGridWebhookDto,
  SendGridWebhookResponseDto,
} from 'types/dto/newsletters.dto.js';

import { readMailEvents, type MailEventKind } from './helpers/mailEvents.helper.js';

type WebhookLogger = Pick<FastifyBaseLogger, 'info' | 'debug' | 'warn'>;

// what newsletter_apply_event answers: the event was applied (or was applied before), or the database
// has no such mail to apply it to
type Applied = 'applied' | 'unknown';

// One event, in a transaction of its own as the system (the function of the database checks the
// actor). A transaction per event, not one for the batch: the events of a campaign all touch its row
// of counters, and a long transaction would hold the pass that sends the mails off that row; a
// failure of one event rolls back only that event. `reason` is why SendGrid dropped the mail, when it
// said (the database reads it for a drop only)
async function applyMailEvent(
  recipientId: number,
  event: MailEventKind,
  reason: string | undefined,
): Promise<Applied> {
  const rows = await tx(async (db) => {
    await setAdminContext(db);

    return db.$queryRaw<Array<{ result: Applied }>>`
      select cartlify.newsletter_apply_event(${recipientId}::int, ${event}, ${reason ?? null}::text) as result`;
  });

  return rows[0]!.result;
}

// The Event Webhook of SendGrid. The request is checked first, before the body is read: the key of the
// server must be usable (a server without it takes nothing as signed: 503, and SendGrid delivers
// again), the signature must hold, and the timestamp must be of the day. Then the events: of the
// three kinds the app keeps, those of a mail of this environment are applied one by one.
//
// The answer decides whether SendGrid delivers the batch again: any 2xx ends it, anything else makes
// it try again for a day. An event the app has nothing to do with is therefore never an error (the
// account hears the mails of the orders and of the other environment too), and a failure of the
// database is: the events before it and after it are stored all the same (one broken event does not
// hold the others back), the batch is answered with the error of the first failure, and the delivery
// that follows applies the events once more. That is safe because applying an event is idempotent:
// the first outcome of a mail is final, and an event that comes again changes nothing and counts
// nothing twice (db/05, newsletter_apply_event).
export async function handleSendGridWebhook(
  { signature, timestamp, rawBody }: HandleSendGridWebhookDto,
  log: WebhookLogger,
): Promise<SendGridWebhookResponseDto> {
  const verdict = verifySendGridSignature({
    publicKey: env.SENDGRID_NEWSLETTER_WEBHOOK_KEY,
    signature,
    timestamp,
    rawBody,
  });

  if (verdict === 'key_missing' || verdict === 'key_invalid') {
    throw new ServiceUnavailableError('SENDGRID_WEBHOOK_KEY_UNAVAILABLE', { reason: verdict });
  }

  if (verdict !== 'valid') {
    // the reason only in the log: the answer tells a sender nothing about how close it came
    log.info({ reason: verdict }, 'newsletter webhook signature was refused');
    throw new UnauthorizedError('SENDGRID_SIGNATURE_INVALID');
  }

  let items: unknown;
  try {
    items = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    throw new BadRequestError('REQUEST_BODY_INVALID_JSON', undefined, err);
  }
  if (!Array.isArray(items)) throw new BadRequestError('SENDGRID_EVENTS_INVALID');

  const { toApply, ignored, skipped } = readMailEvents(items);

  let applied = 0;
  let unknown = 0;
  let failed = 0;
  let firstFailure: unknown;

  for (const { recipientId, event, reason } of toApply) {
    try {
      if ((await applyMailEvent(recipientId, event, reason)) === 'applied') applied += 1;
      else unknown += 1;
    } catch (err) {
      failed += 1;
      firstFailure ??= err;
    }
  }

  // counters only: an event holds the address of the reader, which no log may keep
  const counts = { received: items.length, applied, ignored, skipped, unknown };

  if (failed > 0) {
    log.warn(
      { ...counts, failed, total: toApply.length },
      'newsletter events were not stored, the request fails for SendGrid to deliver them again',
    );
    throw firstFailure;
  }

  // an event stored is worth a line in the log; a batch of mails of the orders and of the other
  // environment, which the account hears all day, is not
  if (applied > 0) log.info(counts, 'newsletter events were handled');
  else log.debug(counts, 'newsletter events were handled');

  return { received: true, applied, skipped: items.length - applied };
}
