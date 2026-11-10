import env from '@config/env.js';
import { parseShopTime } from '@helpers/shopTime.js';

// the day of the shop, yyyy-mm-dd, by its time zone (SHOP_TIME_ZONE): a batch is over once its
// last good day is behind it. The context of every transaction gives it to the database
// (cartlify.shop_today), so a moved clock moves the day as well
export function shopToday(now: number = Date.now(), timeZone: string = env.SHOP_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  return `${part('year')}-${part('month')}-${part('day')}`;
}

// The two moments the day of the shop (shopToday) begins and ends, as a half-open span [start, end):
// the midnight of its time zone and the next one. A day is 23 or 25 hours long when the clock of the
// zone goes forward or back. The daily limit of the newsletters counts the mails sent in this span
export function shopDayBounds(
  now: Date = new Date(),
  timeZone: string = env.SHOP_TIME_ZONE,
): { start: Date; end: Date } {
  const day = shopToday(now.getTime(), timeZone);
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);

  // the midnight of a day always exists in the zones the shop can have; a zone that skips it (the
  // clock jumps over 00:00) is read with the offset before the jump by parseShopTime
  const start = parseShopTime(`${day}T00:00`, timeZone);
  const end = parseShopTime(`${next}T00:00`, timeZone);
  if (!start || !end) throw new Error('the day of the shop has no bounds');

  return { start, end };
}
