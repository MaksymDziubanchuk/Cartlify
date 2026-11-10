import type { FastifyBaseLogger } from 'fastify';

import { shopSettings } from '@config/shopSettings.js';
import { getPgMessage, tx } from '@db/client.js';
import { setGuestNullContext } from '@db/dbContext.service.js';
import {
  newsletterConfirmUrl,
  newsletterDeclineUrl,
  newsletterManageUrl,
} from '@helpers/newsletterLinks.js';
import { manageHashOf } from '@helpers/newsletterTokens.js';
import { clearSpamReport } from '@services/email/clearSpamReport.js';
import { isEmailProviderFailure } from '@services/email/sendGrid.js';
import { sendNewsletterEmail } from '@services/email/sendNewsletterEmail.js';
import { buildSubscriptionAlreadyTemplate } from '@services/email/templates/newsletters/subscriptionAlready.template.js';
import { buildSubscriptionConfirmTemplate } from '@services/email/templates/newsletters/subscriptionConfirm.template.js';
import { AppError } from '@utils/errors.js';

import { readManagedSubscription } from './subscriptionState.helper.js';

type MailLog = Pick<FastifyBaseLogger, 'warn' | 'error'>;

type Mail = { subject: string; text: string; html: string };

// The kind of a mail of the form, as cartlify.newsletter_request_mail_failed names it
type MailKind = 'confirm' | 'already';

// Takes back the mark "mailed" that the form put on the address when it decided to mail it, because
// the mail never left: the person must not lose their day to a failure of ours or of the provider
// (cartlify.newsletter_request_mail_failed, which takes it back only while it is a fresh one). It
// never throws: the answer to the form went already, and a failure here only costs the person the
// wait the mark would have cost anyway. The log holds the kind and the code of the database, never
// the address or the text of the error, which may quote it
async function liftMailMark(to: string, kind: MailKind, log: MailLog): Promise<void> {
  try {
    await tx(async (db) => {
      await setGuestNullContext(db);
      await db.$queryRaw`
        select cartlify.newsletter_request_mail_failed(${to}::text, ${kind}::text) as lifted
      `;
    });
  } catch (err) {
    log.error(
      { kind, code: getPgMessage(err) },
      'newsletter subscription mail mark could not be lifted',
    );
  }
}

// A mail of the form of the public page. The answer of the form is the same whatever the address
// is, so a mail that cannot be sent must not change it: nothing here throws. A mail the provider
// did not take is a warning with the reason and the status only (the cause holds the answer of the
// provider, and the address is personal data, so neither goes into the log); a fault of the server
// itself (a setting missing, a template that cannot be built) is an error of its own. Either way the
// mail never left, so the mark of the day it was sent under is taken back (liftMailMark)
async function deliver(to: string, kind: MailKind, build: () => Mail, log: MailLog): Promise<void> {
  try {
    const { subject, text, html } = build();

    await sendNewsletterEmail({ to, subject, text, html });
    return;
  } catch (err) {
    if (isEmailProviderFailure(err) && err instanceof AppError) {
      const status = (err.cause as { status?: unknown } | undefined)?.status;
      const reason = (err.details as { reason?: unknown } | undefined)?.reason;

      log.warn(
        { reason, ...(typeof status === 'number' ? { status } : {}) },
        'newsletter subscription mail was not sent',
      );
    } else {
      log.error({ err }, 'newsletter subscription mail could not be built or sent');
    }
  }

  await liftMailMark(to, kind, log);
}

// The mails of the form go out after the answer, not before it: a mail waits for the provider (up to
// seconds) and no mail does not, so an answer that waited would tell by its time whether the address
// is new, subscribed or blocked. What is still on its way is kept here, so whatever must see it sent
// (a test, a shutdown) can wait for it
const onTheirWay = new Set<Promise<void>>();

export function sendAfterAnswer(mail: Promise<void>): void {
  onTheirWay.add(mail);
  const done = () => {
    onTheirWay.delete(mail);
  };
  // deliver never throws; the second handler only keeps a fault from being an unhandled rejection
  void mail.then(done, done);
}

// resolves once every mail of the form started so far has been sent or given up
export async function subscriptionMailsSent(): Promise<void> {
  await Promise.allSettled([...onTheirWay]);
}

// "Confirm the subscription": the two buttons of the mail carry one token, in the language the
// request asked for
export function sendSubscriptionConfirmMail(
  args: { to: string; token: string; locale: string },
  log: MailLog,
): Promise<void> {
  return deliver(
    args.to,
    'confirm',
    () =>
      buildSubscriptionConfirmTemplate({
        confirmUrl: newsletterConfirmUrl(args.token),
        declineUrl: newsletterDeclineUrl(args.token),
        appName: shopSettings().shopName,
        locale: args.locale,
        logoUrl: shopSettings().logoUrl,
      }),
    log,
  );
}

// Whether the subscription behind the token of its page of management is paused by a spam mark.
// Read in a step of its own after the answer (a read before it would make the answer a little slower
// for an address that has a subscription). A failure to read is no reason to send nothing: the usual
// mail goes, the code of the database in the log
async function isPausedByComplaint(manageToken: string, log: MailLog): Promise<boolean> {
  try {
    return await tx(async (db) => {
      await setGuestNullContext(db);
      const state = await readManagedSubscription(db, manageHashOf(manageToken));
      return state.status === 'paused_complaint';
    });
  } catch (err) {
    log.warn(
      { code: getPgMessage(err) },
      'newsletter subscription state could not be read before its mail',
    );
    return false;
  }
}

// "You are already subscribed": the link of management of the subscription that exists, in its
// language. A subscription a spam mark paused gets another mail, which says so and where to resume it:
// the provider drops every mail to an address on its list of spam reports, so the address is taken off
// the list of the newsletter account first (clearSpamReport, which never throws: a removal that
// fails is only logged and the mail still goes)
export async function sendSubscriptionAlreadyMail(
  args: { to: string; manageToken: string; locale: string },
  log: MailLog,
): Promise<void> {
  const paused = await isPausedByComplaint(args.manageToken, log);
  if (paused) await clearSpamReport(args.to, log);

  return deliver(
    args.to,
    'already',
    () =>
      buildSubscriptionAlreadyTemplate({
        manageUrl: newsletterManageUrl(args.manageToken),
        appName: shopSettings().shopName,
        locale: args.locale,
        paused,
        logoUrl: shopSettings().logoUrl,
      }),
    log,
  );
}
