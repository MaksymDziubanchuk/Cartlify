// A time a person types for the shop, ISO 8601 (2095-07-01T12:00, 2095-07-01T12:00:30.5,
// 2095-07-01T12:00:00Z, 2095-07-01T12:00:00+02:00). With an offset it is that exact instant. Without
// one it is the wall clock of the shop, read in its time zone (SHOP_TIME_ZONE): the person who runs
// the newsletters thinks in the time of the shop, not in UTC. Anything else, and a day or an hour the
// calendar has not got, is null.
//
// When the clock of the zone goes back, a wall time happens twice and the earlier one is taken; when
// it goes forward, a wall time is skipped and is read with the offset before the gap, so it lands
// after the gap by the length of the gap (03:30 for 02:30 in Madrid). Both are the usual choice of
// calendars. A pure function: it reads no clock and no env.

const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/;

const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * SECOND_MS;
const DAY_MS = 24 * HOUR_MS;

const daysInMonth = (year: number, month: number): number =>
  month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

// the instant that has these figures on the UTC clock (Date.UTC reads a year under 100 as 19xx)
function utcMs(parts: number[]): number {
  const [year, month, day, hour, minute, second, ms] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);

  return date.getTime();
}

const formatters = new Map<string, Intl.DateTimeFormat>();

// how far the wall clock of the zone is ahead of UTC at an instant, in milliseconds
function offsetAt(timeZone: string, instant: number): number {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }

  const part = (type: string, parts: Intl.DateTimeFormatPart[]) =>
    Number(parts.find((p) => p.type === type)?.value);
  const parts = formatter.formatToParts(new Date(instant));
  const wall = utcMs([
    part('year', parts),
    part('month', parts),
    part('day', parts),
    part('hour', parts),
    part('minute', parts),
    part('second', parts),
    0,
  ]);

  return wall - Math.floor(instant / SECOND_MS) * SECOND_MS;
}

// the instant a wall time is in a zone (the figures are those of the wall clock)
function zonedInstant(timeZone: string, wallMs: number): number {
  const before = offsetAt(timeZone, wallMs - DAY_MS);
  const after = offsetAt(timeZone, wallMs + DAY_MS);

  const fits = [...new Set([before, after])]
    .map((offset) => wallMs - offset)
    .filter((instant) => offsetAt(timeZone, instant) === wallMs - instant)
    .sort((a, b) => a - b);

  // two: the clock repeated the hour, the earlier is taken; none: the hour was skipped
  return fits[0] ?? wallMs - before;
}

export function parseShopTime(text: string, timeZone: string): Date | null {
  const match = ISO_TIME.exec(text);
  if (!match) return null;

  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const ms = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0').slice(0, 3));
  const offset = match[8];

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const wall = utcMs([year, month, day, hour, minute, second, ms]);

  if (offset === undefined) return new Date(zonedInstant(timeZone, wall));
  if (offset === 'Z') return new Date(wall);

  const offsetHour = Number(offset.slice(1, 3));
  const offsetMinute = Number(offset.slice(4, 6));
  if (offsetHour > 23 || offsetMinute > 59) return null;

  const sign = offset.startsWith('-') ? -1 : 1;
  return new Date(wall - sign * (offsetHour * HOUR_MS + offsetMinute * 60 * SECOND_MS));
}
