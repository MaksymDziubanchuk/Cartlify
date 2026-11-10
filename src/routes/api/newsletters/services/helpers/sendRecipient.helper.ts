import type { FastifyBaseLogger } from 'fastify';

import { manageTokenOf, unsubscribeTokenOf } from '@helpers/newsletterTokens.js';
import { sendNewsletterEmail } from '@services/email/sendNewsletterEmail.js';
import { CampaignLocaleMissingError } from '@services/email/templates/newsletters/campaign.template.js';

import { customArgsOf } from './mailEvents.helper.js';
import { newsletterMailFor } from './newsletterMail.helper.js';
import { sendFailureOf, type SendFailure } from './sendFailure.helper.js';
import {
  acceptedSince,
  campaignMaterialOf,
  deliveryStateOf,
  recordRejected,
  recordSent,
  recordSkipped,
  releaseRecipients,
  type CampaignMaterial,
  type ClaimedRecipient,
} from './sendingStore.helper.js';

// The sending of one mail of a campaign, from the row the pass took to the outcome written in the
// database. It looks at the row once more just before the mail goes (the campaign may have been
// stopped, the person may have unsubscribed since the portion was taken), makes the mail the way the
// reader of the language gets it, sends it, and writes how it went. Logs carry ids and counters, never
// an address, a token or a text.

export type SendingLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

// How the mail ended:
// - sent: SendGrid took it;
// - held: SendGrid did not take it (it will not, or it was busy), and it is not known yet whether the
//   fault is of this mail or of the whole stream: the mail waits for the answer (see `DeliveryContext.held`)
//   and is rejected, left to be tried again, kept or given back, when it comes;
// - rejected: SendGrid refused a mail that was tried before, and the campaign had a mail taken since that
//   try: the fault is the mail's, so it is rejected at once and is no part of the run of refusals;
// - skipped: left out (the person unsubscribed, the mail has nothing in it);
// - released: not tried, the campaign is not sending any more; given back;
// - gone: the row is not waiting any more or not there (it was deleted with its subscription)
export type DeliveryResult = 'sent' | 'held' | 'rejected' | 'skipped' | 'released' | 'gone';

// Why a pass stops before it is done: the whole stream has a problem, and trying the next mails would
// meet the same one
export type HaltWhy =
  // SendGrid refuses the key or the account (401, 403)
  | 'access_refused'
  // a setting of the stream is missing, or the mail cannot be made: the same for every reader
  | 'stream_broken'
  // the data a campaign's mails are made of is not there
  | 'campaign_data_missing'
  // many mails in a row were refused, none taken: something is wrong with all of them
  | 'every_mail_refused'
  // many tries in a row found SendGrid busy or silent
  | 'provider_unavailable'
  // the database failed on a step of a mail
  | 'database_failed';

export class PassHalt extends Error {
  constructor(
    readonly why: HaltWhy,
    readonly detail: { status?: number | null; reason?: string } = {},
  ) {
    super(why);
    this.name = 'PassHalt';
  }
}

// how many mails in a row may be refused (or find SendGrid busy) before the pass takes it for a
// problem of the whole stream and stops
export const FAILURE_STREAK_LIMIT = 10;

// A mail SendGrid did not take, kept until it is known whether the fault is of the mail or of the whole
// stream. `reject`: SendGrid will not take it (a 4xx, or its last try) and it is rejected, once the
// streak it is in ends without stopping the pass; otherwise it was busy and stays in the queue under
// its lease, to be tried later
export type HeldMail = { recipientId: number; campaignId: number; reject: boolean };

// how the held mails ended, counted in the summary of the pass: rejected, left to their lease to be
// tried again (retried), given back free at once with the try not counted (released), or kept with
// their try after a stop of the pass (deferred)
export type HeldTally = { rejected: number; retried: number; released: number; deferred: number };

export type DeliveryContext = {
  log: SendingLogger;
  // the moment a mail is written down as sent
  clock: () => Date;
  // the text and the data of the products of a campaign, fixed at its start, read once for the pass
  material: (campaignId: number) => Promise<CampaignMaterial>;
  // The mails in a row that were refused, and in a row that found SendGrid busy, since the last mail
  // SendGrid took: the two streaks. A mail is judged when its streak ends. A mail taken ends both:
  // those before it were refused one by one, so the fault was theirs (a refused one is rejected, a
  // busy one is left to its lease). A streak of FAILURE_STREAK_LIMIT stops the pass: the fault may be
  // the stream's and not the mails', so none is rejected (releaseHeld): a mail that was refused keeps
  // the try it used and waits out its lease, behind the mails with fewer tries; a mail that found
  // SendGrid busy goes back to the queue with its try not counted, free at once. At the end of a pass
  // that was not stopped the streaks are judged the same way as when a mail is taken. A mail that was
  // tried before and is refused again after a mail of its campaign was taken since is rejected at once
  // and is in neither streak (deliverRecipient)
  held: { refused: HeldMail[]; unavailable: HeldMail[] };
  // the summary of the pass: the held mails count in it when they are judged
  tally: HeldTally;
  // set once the streaks say the stream has a problem: the mail that set it is held with the rest of
  // its streak, and every mail that has not started yet stops with it and goes back to the queue; the
  // held mails are settled by releaseHeld. A mail that was already with SendGrid when it was set may
  // still be taken, but it judges nobody: a halted stream rejects nothing
  halted: PassHalt | null;
  // the mails SendGrid has taken in this pass (by the id of the row), from the moment it took them. The
  // pass never gives such a row back to the queue, whatever fails afterwards: a row given back is free
  // at once and the next pass would send the mail a second time. If writing it down fails, it stays
  // under its lease (see giveBack in the job)
  accepted: Set<number>;
  // the failures of the batch by kind and status, for one line of the log
  failures: Map<string, number>;
};

// reads the material of campaigns once for the pass, and keeps it
export function materialReader(): DeliveryContext['material'] {
  const kept = new Map<number, Promise<CampaignMaterial | null>>();

  return async (campaignId) => {
    if (!kept.has(campaignId)) kept.set(campaignId, campaignMaterialOf(campaignId));

    const material = await kept.get(campaignId)!;
    if (!material) throw new PassHalt('campaign_data_missing');
    return material;
  };
}

const noteFailure = (ctx: DeliveryContext, failure: SendFailure) => {
  const key = `${failure.kind}:${failure.status ?? failure.reason}`;
  ctx.failures.set(key, (ctx.failures.get(key) ?? 0) + 1);
};

// holds a mail that SendGrid did not take in the streak of its kind; too many in a row halt the pass
const holdMail = (
  ctx: DeliveryContext,
  streak: 'refused' | 'unavailable',
  mail: HeldMail,
  failure: SendFailure,
): void => {
  ctx.held[streak].push(mail);

  if (ctx.held[streak].length >= FAILURE_STREAK_LIMIT) {
    ctx.halted ??= new PassHalt(
      streak === 'refused' ? 'every_mail_refused' : 'provider_unavailable',
      {
        status: failure.status,
        reason: failure.reason,
      },
    );
  }
};

// Judges the mails held: the streaks are over and did not stop the pass (a mail was taken, or the pass
// ends). A mail SendGrid refused is rejected, one that found it busy stays as it is, under its lease.
// Counts them in the summary. A mail that cannot be written down stays held and the error goes on. Once
// the pass is halted nothing is judged (the halt settles the mails, releaseHeld): the mails left are
// kept held
export async function judgeHeld(ctx: DeliveryContext): Promise<void> {
  for (const streak of [ctx.held.refused, ctx.held.unavailable]) {
    const mails = streak.splice(0);

    for (const [index, mail] of mails.entries()) {
      if (ctx.halted) {
        streak.unshift(...mails.slice(index));
        return;
      }

      try {
        if (mail.reject) {
          await recordRejected({ recipientId: mail.recipientId, campaignId: mail.campaignId });
          ctx.tally.rejected += 1;
        } else {
          ctx.tally.retried += 1;
        }
      } catch (err) {
        streak.unshift(...mails.slice(index));
        throw err;
      }
    }
  }
}

// A mail that is taken again is no longer held for its earlier try: it is judged by its latest one. Its
// lease can run out within a long pass (a short NEWSLETTER_RETRY_MINUTES), and the claim takes it again
// while it is still held; held twice, it would be counted twice, and settled twice
export function dropHeld(ctx: DeliveryContext, recipientIds: number[]): void {
  const taken = new Set(recipientIds);

  for (const streak of [ctx.held.refused, ctx.held.unavailable]) {
    const kept = streak.filter((mail) => !taken.has(mail.recipientId));
    streak.splice(0, streak.length, ...kept);
  }
}

// Settles every mail held when the pass stops: the stream may have a problem, and nobody knows whether
// the mails that showed it were refused (or found SendGrid busy) because of it or because of themselves.
// None is rejected. A mail that was refused keeps the try it used and stays under its lease (nothing is
// written: the lease is the claim's), so it comes back after the lease, behind the mails with fewer
// tries: counted as deferred. A mail that found SendGrid busy is given back as it was before the pass
// took it: its try is not counted, and it is free to be taken at once (releaseRecipients). Returns how
// many went back
export async function releaseHeld(ctx: DeliveryContext): Promise<number> {
  ctx.tally.deferred += ctx.held.refused.length;
  ctx.held.refused.length = 0;

  const busy = ctx.held.unavailable;
  if (busy.length === 0) return 0;

  const released = await releaseRecipients(busy.map((mail) => mail.recipientId));
  busy.length = 0;
  ctx.tally.released += released;

  return released;
}

export async function deliverRecipient(
  row: ClaimedRecipient,
  ctx: DeliveryContext,
): Promise<DeliveryResult> {
  // the pass is stopping: this mail is not tried
  if (ctx.halted) throw ctx.halted;

  const state = await deliveryStateOf(row.recipientId);
  if (!state || state.mail !== 'queued') return 'gone';

  // stopped (or finished) while the portion was on its way: not tried, given back
  if (state.campaign !== 'sending') {
    await releaseRecipients([row.recipientId]);
    return 'released';
  }

  // unsubscribed (or bounced, or complained) since the portion was taken
  if (state.subscription !== 'active') {
    await recordSkipped(row.recipientId);
    return 'skipped';
  }

  const material = await ctx.material(row.campaignId);

  let mail;
  try {
    mail = newsletterMailFor({
      campaign: { id: row.campaignId, content: material.content },
      snapshot: material.snapshot,
      locale: row.locale,
      subscriber: {
        manageToken: manageTokenOf(row.manageSalt),
        unsubscribeToken: unsubscribeTokenOf(row.manageSalt),
      },
    });
  } catch (err) {
    // the language of the row has no subject in the campaign: the start gives none such, so this is
    // one mail that cannot be made, not a problem of the stream
    if (err instanceof CampaignLocaleMissingError) {
      ctx.log.warn(
        { campaignId: row.campaignId, recipientId: row.recipientId },
        'newsletter mail has no text in its language, it is left out',
      );
      await recordSkipped(row.recipientId);
      return 'skipped';
    }

    const failure = sendFailureOf(err);
    throw new PassHalt('stream_broken', { status: failure.status, reason: failure.reason });
  }

  // a mail with nothing in it for this language is not sent
  if (mail.warnings.some((warning) => warning.code === 'MAIL_EMPTY')) {
    await recordSkipped(row.recipientId);
    return 'skipped';
  }

  let sent;
  try {
    sent = await sendNewsletterEmail({
      to: row.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: mail.headers,
      customArgs: customArgsOf(row.campaignId, row.recipientId),
    });
  } catch (err) {
    const failure = sendFailureOf(err);

    if (failure.kind === 'halt') {
      const accessRefused = failure.status === 401 || failure.status === 403;
      throw new PassHalt(accessRefused ? 'access_refused' : 'stream_broken', {
        status: failure.status,
        reason: failure.reason,
      });
    }

    noteFailure(ctx, failure);

    // A mail tried before and refused again, when the campaign had a mail taken since that try: the
    // stream took mails after it, so the fault is this mail's. It is rejected at once and is no part of
    // the run of refusals. Not while the pass is stopping: a stopped pass rejects nothing
    if (
      failure.kind === 'refused' &&
      row.previousTry !== null &&
      !ctx.halted &&
      (await acceptedSince(row.campaignId, row.previousTry))
    ) {
      await recordRejected({ recipientId: row.recipientId, campaignId: row.campaignId });
      return 'rejected';
    }

    // SendGrid will not take this one, or this was its last try: it is rejected unless the streak it
    // is in turns out to be a fault of the stream. Busy or silent otherwise: it stays leased, the
    // next claim after the lease takes it again
    const reject = failure.kind === 'refused' || row.lastAttempt;
    holdMail(
      ctx,
      failure.kind === 'refused' ? 'refused' : 'unavailable',
      { recipientId: row.recipientId, campaignId: row.campaignId, reject },
      failure,
    );

    return 'held';
  }

  // The mail is on its way to the reader. From here the pass never gives its row back: if one of the
  // writes below fails, the row stays under its lease and is tried again only when that has run out
  ctx.accepted.add(row.recipientId);

  await recordSent({
    recipientId: row.recipientId,
    campaignId: row.campaignId,
    messageId: sent.messageId,
    at: ctx.clock(),
  });

  // a mail taken: the failures before it were the mails' own (judgeHeld judges nothing once the stream
  // is halted)
  await judgeHeld(ctx);

  return 'sent';
}
