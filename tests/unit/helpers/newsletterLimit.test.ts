import { describe, expect, it } from '@jest/globals';

import { checkSendingLimit, type LimitCampaign } from '@helpers/newsletterLimit.js';

// The limit of the newsletters: at most `count` campaigns in any window of `days` days. A window is
// half open ([start, start + days)), so two campaigns exactly `days` days apart are not in one. The
// function answers for a campaign about to take a time, and names the campaigns that fill the
// windows it would break. It reads no clock and no database.

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2090, 0, 1);

// a moment, in days from a fixed start (fractions allowed)
const at = (days: number) => new Date(BASE + Math.round(days * DAY));

// a campaign of the limit: its id also names it
const campaign = (id: number, days: number): LimitCampaign => ({
  id,
  name: `Campaign ${id}`,
  at: at(days),
});

const ids = (campaigns: LimitCampaign[]) => campaigns.map((c) => c.id);

const limit = (count: number, days: number) => ({ count, days });

describe('checkSendingLimit: what is allowed', () => {
  it('allows the first campaign of all, whatever the limit', () => {
    expect(checkSendingLimit([], { at: at(0) }, limit(1, 1))).toEqual({
      allowed: true,
      campaigns: [],
    });
    expect(checkSendingLimit([], { at: at(0) }, limit(100, 365))).toEqual({
      allowed: true,
      campaigns: [],
    });
  });

  it('allows a campaign that makes exactly the count in its window', () => {
    const existing = [campaign(1, 0)];

    expect(checkSendingLimit(existing, { at: at(3) }, limit(2, 7))).toEqual({
      allowed: true,
      campaigns: [],
    });
  });

  it('allows a campaign when the others are further than a window from it', () => {
    const existing = [campaign(1, 0), campaign(2, 1)];

    expect(checkSendingLimit(existing, { at: at(30) }, limit(2, 7)).allowed).toBe(true);
    expect(checkSendingLimit(existing, { at: at(-30) }, limit(2, 7)).allowed).toBe(true);
  });

  it('does not count campaigns that already break the limit among themselves far from the candidate', () => {
    // three campaigns within a few hours, over a count of two: a fault of their own, not of a
    // candidate a month away
    const existing = [campaign(1, 0), campaign(2, 0.1), campaign(3, 0.2)];

    expect(checkSendingLimit(existing, { at: at(30) }, limit(2, 7))).toEqual({
      allowed: true,
      campaigns: [],
    });
  });

  it('counts a sliding window, not everything within `days` of the candidate', () => {
    // 0 and 6.5 are together in a window, 13 is alone with 6.5 in the next one: never three
    const existing = [campaign(1, 0), campaign(2, 6.5)];

    expect(checkSendingLimit(existing, { at: at(13) }, limit(2, 7)).allowed).toBe(true);
    expect(checkSendingLimit(existing, { at: at(-6.5) }, limit(2, 7)).allowed).toBe(true);
  });

  it('allows a candidate between two campaigns that are too far apart to share a window with it', () => {
    const existing = [campaign(1, 0), campaign(2, 10)];

    expect(checkSendingLimit(existing, { at: at(5) }, limit(2, 7)).allowed).toBe(true);
  });

  it('allows any number up to the count: a limit of 100', () => {
    const existing = Array.from({ length: 99 }, (_, i) => campaign(i + 1, i / 100));

    expect(checkSendingLimit(existing, { at: at(0.995) }, limit(100, 7)).allowed).toBe(true);
    expect(checkSendingLimit(existing, { at: at(0.995) }, limit(99, 7)).allowed).toBe(false);
  });
});

describe('checkSendingLimit: what is refused, and who fills the window', () => {
  it('refuses one more than the count and names the campaigns of the window', () => {
    const existing = [campaign(1, 0), campaign(2, 2)];

    const verdict = checkSendingLimit(existing, { at: at(4) }, limit(2, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([1, 2]);
    expect(verdict.campaigns[0]).toEqual(existing[0]);
  });

  it('refuses a candidate before the existing ones', () => {
    const existing = [campaign(1, 3), campaign(2, 5)];

    const verdict = checkSendingLimit(existing, { at: at(1) }, limit(2, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([1, 2]);
  });

  it('refuses a candidate after the existing ones', () => {
    // a window [0, 7) holds 1, 2 and 6
    const existing = [campaign(1, 1), campaign(2, 2)];

    const verdict = checkSendingLimit(existing, { at: at(6) }, limit(2, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([1, 2]);
  });

  it('refuses a candidate between two campaigns that share a window with it', () => {
    const existing = [campaign(1, 0), campaign(2, 6)];

    const verdict = checkSendingLimit(existing, { at: at(3) }, limit(2, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([1, 2]);
  });

  it('refuses with a count of 1 and names the one campaign', () => {
    const verdict = checkSendingLimit([campaign(1, 0)], { at: at(3) }, limit(1, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([1]);
  });

  it('refuses a campaign at the very moment of another one', () => {
    const verdict = checkSendingLimit([campaign(1, 5)], { at: at(5) }, limit(1, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([1]);
  });

  it('names only the campaigns of the windows that break, not the ones far off', () => {
    // 0 and 1 are a week away from the candidate; 9 and 10 are within a window of it (3 days)
    const existing = [campaign(1, 0), campaign(2, 1), campaign(3, 9), campaign(4, 10)];

    const verdict = checkSendingLimit(existing, { at: at(10.5) }, limit(2, 3));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([3, 4]);
  });

  it('names every campaign of every window that breaks, once', () => {
    // a campaign every 2.5 days keeps to a limit of three in seven days (never more than three in a
    // window); a candidate between days 25 and 27.5 breaks every window that holds it and three of
    // them, and together those windows reach from day 20 to day 32.5
    const existing = Array.from({ length: 20 }, (_, i) => campaign(i, i * 2.5));

    const verdict = checkSendingLimit(existing, { at: at(26.25) }, limit(3, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([8, 9, 10, 11, 12, 13]);
  });

  it('names all the campaigns of the windows when the shop is over a limit root lowered', () => {
    // a campaign every day, a limit of three in seven days: every window around the candidate
    // holds more than three of them already, and they are all named
    const existing = Array.from({ length: 20 }, (_, i) => campaign(i, i));

    const verdict = checkSendingLimit(existing, { at: at(10.5) }, limit(3, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('names every campaign of a crowd at one moment, whichever way the moments are ordered', () => {
    // two campaigns at the moment of the candidate: the window that holds all three breaks a limit
    // of one, and both are named (not only the one that happens to sort next to the candidate)
    const existing = [campaign(1, 5), campaign(2, 5)];

    const verdict = checkSendingLimit(existing, { at: at(5) }, limit(1, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([1, 2]);
  });

  it('gives the campaigns by time, the earliest first, whatever the order they came in', () => {
    const existing = [campaign(3, 5), campaign(1, 1), campaign(2, 3)];

    const verdict = checkSendingLimit(existing, { at: at(4) }, limit(3, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([1, 2, 3]);
  });

  it('gives campaigns of the same moment by id', () => {
    const existing = [campaign(9, 2), campaign(4, 2), campaign(6, 2)];

    const verdict = checkSendingLimit(existing, { at: at(2) }, limit(2, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([4, 6, 9]);
  });
});

describe('checkSendingLimit: the edge of a window', () => {
  const T = at(0);

  it('puts two campaigns exactly `days` apart in different windows', () => {
    expect(checkSendingLimit([campaign(1, 0)], { at: at(7) }, limit(1, 7)).allowed).toBe(true);
    expect(checkSendingLimit([campaign(1, 7)], { at: at(0) }, limit(1, 7)).allowed).toBe(true);
  });

  it('puts two campaigns a millisecond closer in one window', () => {
    const later = new Date(T.getTime() + 7 * DAY - 1);
    const earlier = new Date(T.getTime() - 7 * DAY + 1);

    expect(checkSendingLimit([campaign(1, 0)], { at: later }, limit(1, 7)).allowed).toBe(false);
    expect(checkSendingLimit([campaign(1, 0)], { at: earlier }, limit(1, 7)).allowed).toBe(false);
  });

  it('reads the span of the whole window, not of the pairs: count + 1 campaigns exactly `days` apart fit nowhere', () => {
    // 0, 3.5, 7: the first and the last are exactly a window apart, so no window holds all three
    const existing = [campaign(1, 0), campaign(2, 3.5)];

    expect(checkSendingLimit(existing, { at: at(7) }, limit(2, 7)).allowed).toBe(true);
    expect(
      checkSendingLimit(existing, { at: new Date(at(7).getTime() - 1) }, limit(2, 7)).allowed,
    ).toBe(false);
  });

  it('takes a window of one day', () => {
    expect(checkSendingLimit([campaign(1, 0)], { at: at(0.9) }, limit(1, 1)).allowed).toBe(false);
    expect(checkSendingLimit([campaign(1, 0)], { at: at(1) }, limit(1, 1)).allowed).toBe(true);
  });

  it('takes a window of a year', () => {
    expect(checkSendingLimit([campaign(1, 0)], { at: at(364) }, limit(1, 365)).allowed).toBe(false);
    expect(checkSendingLimit([campaign(1, 0)], { at: at(365) }, limit(1, 365)).allowed).toBe(true);
  });
});

describe('checkSendingLimit: a campaign that changes its own time', () => {
  it('does not count itself when it is among the existing ones', () => {
    const existing = [campaign(1, 0)];

    expect(checkSendingLimit(existing, { id: 1, at: at(3) }, limit(1, 7))).toEqual({
      allowed: true,
      campaigns: [],
    });
  });

  it('still counts the others', () => {
    const existing = [campaign(1, 0), campaign(2, 5)];

    const verdict = checkSendingLimit(existing, { id: 1, at: at(3) }, limit(1, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([2]);
  });

  it('does not name itself among the campaigns of the window', () => {
    const existing = [campaign(1, 0), campaign(2, 1), campaign(3, 2)];

    const verdict = checkSendingLimit(existing, { id: 2, at: at(1.5) }, limit(2, 7));

    expect(verdict.allowed).toBe(false);
    expect(ids(verdict.campaigns)).toEqual([1, 3]);
  });

  it('takes a campaign with no id for a new one: nothing is left out', () => {
    expect(checkSendingLimit([campaign(1, 0)], { at: at(3) }, limit(1, 7)).allowed).toBe(false);
  });
});

describe('checkSendingLimit: many campaigns, and nothing changed', () => {
  it('finds a break among thousands of campaigns', () => {
    // one a week for 2000 weeks, a count of 1: a candidate between any two of them breaks it
    const existing = Array.from({ length: 2000 }, (_, i) => campaign(i + 1, i * 7));

    const verdict = checkSendingLimit(existing, { at: at(1000 * 7 + 1) }, limit(1, 7));

    expect(verdict.allowed).toBe(false);
    // the one a day before and the one six days after: each shares a window with the candidate
    expect(ids(verdict.campaigns)).toEqual([1001, 1002]);
    expect(checkSendingLimit(existing, { at: at(-3.5) }, limit(1, 7)).allowed).toBe(false);
    expect(checkSendingLimit(existing, { at: at(2000 * 7) }, limit(1, 7)).allowed).toBe(true);
  });

  it('leaves the lists it was given as they were', () => {
    const existing = [campaign(3, 5), campaign(1, 1)];
    const copy = existing.map((c) => ({ ...c, at: new Date(c.at) }));
    const candidate = { id: 3, at: at(2) };

    checkSendingLimit(existing, candidate, limit(1, 7));

    expect(existing).toEqual(copy);
    expect(candidate).toEqual({ id: 3, at: at(2) });
  });
});

describe('checkSendingLimit: a limit or a time that makes no sense', () => {
  it.each([
    ['a count of 0', limit(0, 7)],
    ['a negative count', limit(-1, 7)],
    ['a count that is no whole number', limit(1.5, 7)],
    ['days of 0', limit(2, 0)],
    ['days that are no whole number', limit(2, 3.5)],
    ['a count that is not a number', limit(Number.NaN, 7)],
  ])('throws for %s', (_case, bad) => {
    expect(() => checkSendingLimit([], { at: at(0) }, bad)).toThrow(RangeError);
  });

  it('throws for a time that is no date', () => {
    expect(() => checkSendingLimit([], { at: new Date('nope') }, limit(2, 7))).toThrow(RangeError);
    expect(() =>
      checkSendingLimit([{ id: 1, name: 'x', at: new Date('nope') }], { at: at(0) }, limit(2, 7)),
    ).toThrow(RangeError);
  });
});
