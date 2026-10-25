import env from '@config/env.js';

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
