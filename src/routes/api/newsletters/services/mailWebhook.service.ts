import type { FastifyBaseLogger } from 'fastify';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { mailProvider } from '@providers/mail/index.js';
import { BadRequestError, ServiceUnavailableError, UnauthorizedError } from '@utils/errors.js';
import type { HandleMailWebhookDto, MailWebhookResponseDto } from 'types/dto/newsletters.dto.js';

import { readMailEvents, type MailEventToApply } from './helpers/mailEvents.helper.js';

type WebhookLogger = Pick<FastifyBaseLogger, 'info' | 'debug' | 'warn'>;

// what newsletter_apply_event answers: the event was applied (or was applied before), or the database
// has no such mail to apply it to
type Applied = 'applied' | 'unknown';

// One event, in a transaction of its own as the system (the function of the database checks the
// actor). A transaction per event, not one for the batch: the events of a campaign all touch its row
// of counters, and a long transaction would hold the pass that sends the mails off that row; a
// failure of one event rolls back only that event. The reason of a drop is the one the provider
// gave, when it is one the database knows
async function applyMailEvent({
  recipientId,
  event,
  dropReason,
}: MailEventToApply): Promise<Applied> {
  const rows = await tx(async (db) => {
    await setAdminContext(db);

    return db.$queryRaw<Array<{ result: Applied }>>`
      select cartlify.newsletter_apply_event(${recipientId}::int, ${event}, ${dropReason}::text) as result`;
  });

  return rows[0]!.result;
}

// The webhook the mail provider reports the events of the mails of the newsletters to. The request
// is checked first, before the body is read, the way the provider signs it: the server must have a
// usable key (a server without it takes nothing as signed: 503, and the provider delivers again), the
// signature must hold and the request must be fresh. Then the events: of the three kinds the app
// keeps, those of a mail of this environment are applied one by one.
//
// The answer decides whether the provider delivers the batch again: any 2xx ends it, anything else
// makes it try again. An event the app has nothing to do with is therefore never an error (the
// account hears the mails of the orders and of the other environment too), and a failure of the
// database is: the events before it and after it are stored all the same (one broken event does not
// hold the others back), the batch is answered with the error of the first failure, and the delivery
// that follows applies the events once more. That is safe because applying an event is idempotent:
// the first outcome of a mail is final, and an event that comes again changes nothing and counts
// nothing twice (db/05, newsletter_apply_event).
export async function handleMailWebhook(
  { headers, rawBody }: HandleMailWebhookDto,
  log: WebhookLogger,
): Promise<MailWebhookResponseDto> {
  const checked = mailProvider.webhook.check({ headers, rawBody });

  if (checked.verdict === 'missing') throw new BadRequestError('MAIL_WEBHOOK_SIGNATURE_REQUIRED');

  if (checked.verdict === 'unavailable') {
    throw new ServiceUnavailableError('MAIL_WEBHOOK_KEY_UNAVAILABLE', { reason: checked.reason });
  }

  if (checked.verdict === 'invalid') {
    // the reason only in the log: the answer tells a sender nothing about how close it came
    log.info({ reason: checked.reason }, 'newsletter webhook signature was refused');
    throw new UnauthorizedError('MAIL_WEBHOOK_SIGNATURE_INVALID');
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    throw new BadRequestError('REQUEST_BODY_INVALID_JSON', undefined, err);
  }

  const reading = mailProvider.webhook.readEvents(body);
  if (!reading) throw new BadRequestError('MAIL_WEBHOOK_EVENTS_INVALID');

  const received = reading.events.length + reading.ignored + reading.invalid;
  const { toApply, ignored, skipped } = readMailEvents(reading);

  let applied = 0;
  let unknown = 0;
  let failed = 0;
  let firstFailure: unknown;

  for (const event of toApply) {
    try {
      if ((await applyMailEvent(event)) === 'applied') applied += 1;
      else unknown += 1;
    } catch (err) {
      failed += 1;
      firstFailure ??= err;
    }
  }

  // counters only: an event holds the address of the reader, which no log may keep
  const counts = { received, applied, ignored, skipped, unknown };

  if (failed > 0) {
    log.warn(
      { ...counts, failed, total: toApply.length },
      'newsletter events were not stored, the request fails for the mail provider to deliver them again',
    );
    throw firstFailure;
  }

  // an event stored is worth a line in the log; a batch of mails of the orders and of the other
  // environment, which the account hears all day, is not
  if (applied > 0) log.info(counts, 'newsletter events were handled');
  else log.debug(counts, 'newsletter events were handled');

  return { received: true, applied, skipped: received - applied };
}
