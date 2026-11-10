import { Prisma } from '@prisma/client';

// The shares of the mails of a campaign that went wrong, as the alerts of the newsletters and the
// list of the campaigns they send to count them. One place for the rule, so the count of an alert is
// the total of its list. A share is a number of mails over the mails it is counted against:
//  - undelivered: the mails that did not arrive, over the mails the mail provider took (sent);
//  - rejected: the mails the provider did not take, over the mails it answered for, taken or not;
//  - complaints: the mails marked as spam, over the mails the provider took.
// The mails not yet tried (still waiting in the queue) and the ones skipped are in none of the
// samples, so a campaign that goes out is judged on what has been answered so far, not diluted by
// what is yet to go. A share is over a number when the mails are more than that part of the sample,
// compared on whole numbers (no rounding), and only when the sample is at least SHARE_MIN_SAMPLE
// mails: one mail of two is half of the mails and tells nothing. The number is in per cent for the
// first two shares and in thousandths (per mille) for the complaints: a complaint is rare, the mail
// providers judge a sender by a few in a thousand, and a whole per cent would be far too coarse.

export const CAMPAIGN_SHARES = ['undelivered', 'rejected', 'complaints'] as const;
export type CampaignShare = (typeof CAMPAIGN_SHARES)[number];

// the fewest mails a share is judged on
export const SHARE_MIN_SAMPLE = 20;

// the states of the campaigns that have mails to count: the ones that go out and the ones that went
export const SHARE_STATUSES = ['sending', 'finished', 'stopped'] as const;

// how long after its start a campaign is watched: the bounces and the complaints arrive for days
// after a mail goes. Later it is a campaign of the past, nothing can be done for it, and an alert
// that never goes out would be noise
export const SHARE_WATCH_DAYS = 14;

// what the number of a share is told in: how many parts make the whole sample (100 for per cent, 1000
// for thousandths) and the greatest number the filter and the threshold take
export const SHARE_UNITS = {
  undelivered: { whole: 100, max: 100 },
  rejected: { whole: 100, max: 100 },
  complaints: { whole: 1000, max: 1000 },
} as const satisfies Record<CampaignShare, { whole: number; max: number }>;

// the condition on the campaigns (the table aliased t) whose share is over `over`, a number in the
// unit of the share (SHARE_UNITS)
export function shareCondition(share: CampaignShare, over: number): Prisma.Sql {
  switch (share) {
    case 'undelivered':
      return Prisma.sql`(t."sentCount" >= ${SHARE_MIN_SAMPLE}
        and t."undeliveredCount" * ${SHARE_UNITS.undelivered.whole} > ${over} * t."sentCount")`;
    case 'rejected':
      return Prisma.sql`(t."sentCount" + t."rejectedCount" >= ${SHARE_MIN_SAMPLE}
        and t."rejectedCount" * ${SHARE_UNITS.rejected.whole} > ${over} * (t."sentCount" + t."rejectedCount"))`;
    case 'complaints':
      return Prisma.sql`(t."sentCount" >= ${SHARE_MIN_SAMPLE}
        and t."complaintCount" * ${SHARE_UNITS.complaints.whole} > ${over} * t."sentCount")`;
  }
}
