// the longest name or locale of a profile, in characters
export const PROFILE_TEXT_MAX_LENGTH = 100;

// characters of a text counted by code points, the way the request schemas count: a letter
// outside the basic plane or an emoji is one character, not two
export const textLength = (text: string): number => Array.from(text).length;

// a name or locale that comes from a provider is cut to the limit, not refused: the login of
// a person whose name is long must go through
export function cutProfileText(text: string | null): string | null {
  if (text === null || textLength(text) <= PROFILE_TEXT_MAX_LENGTH) return text;

  return Array.from(text).slice(0, PROFILE_TEXT_MAX_LENGTH).join('');
}

// the one form a phone is stored in: a plus sign and 8 to 15 digits, the first one not zero,
// for example +380501234567. No spaces, brackets or dashes, in a json body and in a form alike;
// an empty value removes the phone. A pattern without anchors, the schemas and the service wrap it
export const PHONE_PATTERN = '\\+[1-9]\\d{7,14}';

const PHONE_FORMAT = new RegExp(`^${PHONE_PATTERN}$`);

export const isPhone = (value: string): boolean => PHONE_FORMAT.test(value);
