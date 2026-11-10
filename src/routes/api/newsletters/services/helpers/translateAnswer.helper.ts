import { foreignAddressOf, foreignAddressOfMarkup } from '@helpers/foreignAddress.js';
import { linksOfMarkup, MARKUP_MAX_LENGTH, parseMarkup } from '@helpers/newsletterMarkup.js';
import { NEWSLETTER_SUBJECT_MAX } from '@schemas/dto/newslettersCampaign.dtoSchemas.js';
import { URL_IN_ANSWER_MAX } from './newsletterContent.helper.js';
import type {
  NewsletterTranslateItemDto,
  NewsletterTranslateKind,
  NewsletterTranslateWarningCode,
} from 'types/dto/newsletters.dto.js';

// What the model gave back is not trusted. It is read as strictly as a body from a stranger
// (parseModelAnswer: the json of the schema, the keys that were asked, each once) and every
// translation is judged on its own (judgeTranslation). A translation that fails is not given back,
// its warning is. The judge knows nothing of the model and of the text beyond the source of the
// item: a model that was led astray by a text (it was told to write something else, to add a link)
// is stopped the same way as a model that made a mistake

export type TranslateItem = NewsletterTranslateItemDto;

// the longest line: a subject and the line under it have 150 characters, a title less (the request
// says so in `maxChars`); the longest text of a block is the one of a block of the campaign
export const TRANSLATE_LINE_MAX = NEWSLETTER_SUBJECT_MAX;

// a refused draft is named by its code; one that names an address of a site that is not allowed also
// gives the address, as the error of the content does (cut to the length the answer repeats)
export type Judgement =
  | { ok: true; text: string }
  | { ok: false; code: Exclude<NewsletterTranslateWarningCode, 'ADDRESS_NOT_ALLOWED'> }
  | { ok: false; code: 'ADDRESS_NOT_ALLOWED'; address: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// the number of characters, a sign of two halves counted once
const characterCount = (text: string): number => [...text].length;

// ---- the answer ----

// The texts of the answer by their keys, or null when the answer is not the json of the schema (an
// object with a list `translations`). Inside the list an entry that is no key with a text, a key
// that was not asked for and a field the schema does not have are dropped; a key that is given
// twice is dropped too, because which text is meant is not known. A key that was asked for and is
// not in the map is a missing translation
export function parseModelAnswer(
  text: string,
  keys: readonly string[],
): Map<string, string> | null {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isObject(value) || !Array.isArray(value.translations)) return null;

  const asked = new Set(keys);
  const answer = new Map<string, string>();
  const repeated = new Set<string>();

  for (const entry of value.translations as unknown[]) {
    if (!isObject(entry)) continue;

    const { key, text: translated } = entry;
    if (typeof key !== 'string' || typeof translated !== 'string' || !asked.has(key)) continue;

    if (answer.has(key) || repeated.has(key)) {
      repeated.add(key);
      continue;
    }
    answer.set(key, translated);
  }

  for (const key of repeated) answer.delete(key);

  return answer;
}

// ---- the judgement ----

// a line break, a tab or any other control sign: a line has none
const NOT_IN_A_LINE = /[\p{Cc}\u2028\u2029]/u;

// the start of a tag, a closing tag, a comment or an instruction of html
const HTML_START = /<\/?[a-z!?]/gi;

// an address written out in a text, with its scheme or with www; a closing bracket or a quote ends it
const BARE_ADDRESS = /(?:https?:\/\/|www\.)[^\s<>"'()[\]]+/gi;

// the signs a sentence puts after an address, which are no part of it
const AFTER_ADDRESS = /[.,;:!?…。、！？]+$/u;

// The addresses of a text: those of the links of a markup and the ones written out in any text.
// A markup is read the way a mail is made of it, so an address is the one the reader would get
export function urlsOf(kind: NewsletterTranslateKind, text: string): Set<string> {
  const found = new Set<string>();

  for (const match of text.matchAll(BARE_ADDRESS)) {
    found.add(match[0].replace(AFTER_ADDRESS, ''));
  }
  if (kind === 'markup') {
    for (const url of linksOfMarkup(parseMarkup(text))) found.add(url);
  }

  return found;
}

const sameSet = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((url) => b.has(url));

const tagsIn = (text: string): number => text.match(HTML_START)?.length ?? 0;

// the most characters the draft of an item may have: the limit of its kind, or the one the request
// gave when that is lower
function limitOf(item: TranslateItem): number {
  const kindLimit = item.kind === 'line' ? TRANSLATE_LINE_MAX : MARKUP_MAX_LENGTH;

  return Math.min(item.maxChars ?? kindLimit, kindLimit);
}

// Whether the text the model gave for an item is a draft that may be given back, in this order:
// there is a text at all (MISSING); it is not too long, which is judged before it is read (TOO_LONG);
// a line is one line (NOT_A_LINE); it has no more html than the source had (HTML_NOT_ALLOWED); it has
// the very addresses of the source (LINK_CHANGED); and no address of a site that is not one of the
// `domains` (ADDRESS_NOT_ALLOWED, with the first address that is not), the shop's own and the trusted
// ones, the rule the content of a campaign is saved under (foreignAddress.ts), so a draft that is
// given back can be saved. The draft given back is trimmed
export function judgeTranslation(
  item: TranslateItem,
  answer: string | undefined,
  domains: readonly string[],
): Judgement {
  const text = answer?.trim() ?? '';
  if (!text) return { ok: false, code: 'MISSING' };

  const limit = limitOf(item);
  // a text of more than twice the limit has too many characters even when each is a pair
  if (text.length > limit * 2 || characterCount(text) > limit) {
    return { ok: false, code: 'TOO_LONG' };
  }

  if (item.kind === 'line' && NOT_IN_A_LINE.test(text)) return { ok: false, code: 'NOT_A_LINE' };

  if (tagsIn(text) > tagsIn(item.text)) return { ok: false, code: 'HTML_NOT_ALLOWED' };

  if (!sameSet(urlsOf(item.kind, item.text), urlsOf(item.kind, text))) {
    return { ok: false, code: 'LINK_CHANGED' };
  }

  // a markup is read as the reader gets it as well: a marker that splits a name does not hide it
  const foreign =
    item.kind === 'markup'
      ? foreignAddressOfMarkup(text, domains)
      : foreignAddressOf(text, domains);
  if (foreign !== null) {
    return { ok: false, code: 'ADDRESS_NOT_ALLOWED', address: foreign.slice(0, URL_IN_ANSWER_MAX) };
  }

  return { ok: true, text };
}
