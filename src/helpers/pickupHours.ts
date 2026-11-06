// The hours a buyer may collect a pickup order at the shop (pickupHours of the data of the shop).
// Root writes them in one format, the server checks it (PUT /api/root/shop-settings) and the
// frontend parses it (GET /api/delivery/methods gives it as written); a mail shows it in the
// language of its reader. The format (docs/shop-settings.md):
//   Mon-Fri 09:00-18:00; Sat 10:00-14:00
//   Mon,Wed,Fri 09:00-13:00,14:00-18:00
// parts by "; ", in each the days and the hours by one space; a day is Mon, Tue, Wed, Thu, Fri,
// Sat or Sun, a range of days Mon-Fri, several of them by ","; the hours HH:MM-HH:MM on 24 hours
// (the end 24:00 at most and after the start), several of them by "," one after another; every
// day in one part only

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const DAY = `(?:${DAYS.join('|')})`;
const DAY_ITEM = `${DAY}(?:-${DAY})?`;
const TIME = '(?:[01]\\d|2[0-3]):[0-5]\\d';
const RANGE = `${TIME}-(?:${TIME}|24:00)`;
const PART = new RegExp(`^(${DAY_ITEM}(?:,${DAY_ITEM})*) (${RANGE}(?:,${RANGE})*)$`);

const dayIndex = (day: string) => DAYS.indexOf(day as (typeof DAYS)[number]);

const minutesOf = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours! * 60 + minutes!;
};

// whether the hours are written in the format: every part of its shape, a range of days from
// the earlier day to the later one, no day twice, the hours of a part each after the one before
export function isPickupHours(text: string): boolean {
  const seen = new Set<number>();

  for (const part of text.split('; ')) {
    const match = PART.exec(part);
    if (!match) return false;

    for (const item of match[1]!.split(',')) {
      const [from, to = from] = item.split('-').map(dayIndex) as [number, number?];
      if (to < from) return false;
      for (let day = from; day <= to; day += 1) {
        if (seen.has(day)) return false;
        seen.add(day);
      }
    }

    let lastEnd = -1;
    for (const range of match[2]!.split(',')) {
      const [start, end] = range.split('-').map(minutesOf) as [number, number];
      if (end <= start || start < lastEnd) return false;
      lastEnd = end;
    }
  }

  return true;
}

// the short names of the days in a language, Monday first (1 January 2024 was a Monday); English
// keeps the en-GB names, the same as the format writes them
function dayNamesOf(locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {
    weekday: 'short',
    timeZone: 'UTC',
  });
  return DAYS.map((_, at) => format.format(new Date(Date.UTC(2024, 0, 1 + at))));
}

// the hours in the language of a mail: each day by its short name in that language, the rest as
// written ("Mon-Fri 09:00-18:00" is "пн-пт 09:00-18:00" in Ukrainian). A text not in the format,
// one written before the server checked it, goes as it is
export function pickupHoursText(text: string, locale: string): string {
  if (!isPickupHours(text)) return text;

  const names = dayNamesOf(locale);
  return text.replace(new RegExp(`\\b${DAY}\\b`, 'g'), (day) => names[dayIndex(day)]!);
}
