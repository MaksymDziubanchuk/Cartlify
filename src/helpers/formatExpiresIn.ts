const MINUTE_MS = 60_000;

// "1 hour", "2 hours"
function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

// how long a mailed link stays valid, for the text of the mail.
// Never promises more than there is: a bigger unit only when the time divides by it,
// so 61 minutes stay "61 minutes" instead of "2 hours". The time is rounded to a minute,
// the mail goes out a few milliseconds after the token got its expiry
export function formatExpiresIn(expiresAt: Date, now: number = Date.now()): string {
  const minutes = Math.round((expiresAt.getTime() - now) / MINUTE_MS);
  if (minutes <= 0) return plural(0, 'minute');

  if (minutes < 60 || minutes % 60 !== 0) return plural(minutes, 'minute');

  const hours = minutes / 60;
  if (hours < 48 || hours % 24 !== 0) return plural(hours, 'hour');

  return plural(hours / 24, 'day');
}
