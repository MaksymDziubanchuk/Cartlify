// The limit of the newsletters: at most `count` campaigns in any window of `days` days. A pure
// function, with no clock and no database, so every edge of the rule is tested on its own; the route
// that schedules a campaign feeds it the campaigns that count and the time asked for.
//
// A window is half open, [start, start + days): two campaigns exactly `days` days apart are not in
// one window. A campaign about to take a time breaks the limit when some window that holds that time
// would hold more than `count` campaigns with it. The campaigns of every such window are named, for
// the refusal to show which of them can be cancelled or stopped to make room.

const DAY_MS = 24 * 60 * 60 * 1000;

// a campaign that counts: the time it goes out (scheduled) or went out (sending, finished, stopped)
export type LimitCampaign = { id: number; name: string; at: Date };

// the campaign about to take a time; `id` is set when it is one of the campaigns that count already
// (a scheduled campaign whose time is changed), so it does not count against itself
export type LimitCandidate = { id?: number; at: Date };

export type SendingLimit = { count: number; days: number };

export type LimitVerdict = {
  allowed: boolean;
  // the campaigns that fill the windows that break the limit, by time and then by id; empty when
  // the time is allowed
  campaigns: LimitCampaign[];
};

const momentOf = (at: Date): number => {
  const ms = at.getTime();
  if (!Number.isFinite(ms))
    throw new RangeError('a time of the limit of the newsletters is no date');

  return ms;
};

export function checkSendingLimit(
  existing: readonly LimitCampaign[],
  candidate: LimitCandidate,
  limit: SendingLimit,
): LimitVerdict {
  if (!Number.isInteger(limit.count) || limit.count < 1) {
    throw new RangeError('the count of the limit of the newsletters is a whole number from 1');
  }
  if (!Number.isInteger(limit.days) || limit.days < 1) {
    throw new RangeError('the days of the limit of the newsletters are a whole number from 1');
  }

  const t = momentOf(candidate.at);
  const span = limit.days * DAY_MS;

  // the others, by time and then by id; the candidate never counts against itself
  const others = existing
    .filter((campaign) => campaign.id !== candidate.id)
    .map((campaign) => ({ campaign, ms: momentOf(campaign.at) }))
    .sort((a, b) => a.ms - b.ms || a.campaign.id - b.campaign.id);

  // A window that holds t slides to the right until its start meets a campaign (or t): it loses
  // nobody on the way and may gain some, so the windows that start at a campaign inside
  // (t - span, t] and the one that starts at t hold every other window's campaigns. A window breaks
  // the limit when it holds `count` others or more: with the candidate that is more than `count`.
  // Both ends of the window only move forward as its start does, so one pass over the others is
  // enough, and the campaigns named come out in the order they are sorted.
  const starts = [...others.map((other) => other.ms).filter((ms) => ms > t - span && ms <= t), t];

  const named: LimitCampaign[] = [];
  let first = 0;
  let end = 0;
  let namedUntil = 0;

  for (const start of starts) {
    while (first < others.length && others[first]!.ms < start) first += 1;
    if (end < first) end = first;
    while (end < others.length && others[end]!.ms < start + span) end += 1;

    if (end - first >= limit.count) {
      for (let i = Math.max(first, namedUntil); i < end; i += 1) {
        named.push(others[i]!.campaign);
      }
      namedUntil = Math.max(namedUntil, end);
    }
  }

  return { allowed: named.length === 0, campaigns: named };
}
