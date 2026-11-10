import { isAvailableLocale } from '@config/locales.js';
import { foreignAddressOf, foreignAddressOfMarkup } from '@helpers/foreignAddress.js';
import { linksOfMarkup, parseMarkup } from '@helpers/newsletterMarkup.js';
import { isLinkAllowed } from '@helpers/shopLink.js';
import { BadRequestError } from '@utils/errors.js';
import type {
  NewsletterBlockDto,
  NewsletterContentDto,
  NewsletterContentInputDto,
  NewsletterTextsDto,
} from 'types/dto/newsletters.dto.js';

// The rules of the content of a campaign that a schema cannot say. The shape (the types, the limits,
// the fields of each block) is the schema of the route; here are the things that depend on the shop:
// - a key of a text is the code of a language the shop answers in (`locales`, the languages root
//   turned on), exactly as it is written: LOCALE_INVALID names the key. A content that replaces a
//   stored one may also keep the languages the stored one has that root turned off since
//   (localesForContent): the text of such a language stays, it only does not go out
// - a language is in the campaign when it has a subject: a preview, a text or a title of a language
//   without one is NEWSLETTER_LOCALE_WITHOUT_SUBJECT
// - every link, in the text of a block and in a button, leads to the shop or to a site root trusts
//   (shopLink.ts: a path or an address of the shop, or an absolute address of http or https whose host
//   is a trusted domain or a subdomain of one): NEWSLETTER_LINK_NOT_ALLOWED names the place and the
//   address. The text is read with the parser of the markup, so the links are the ones the mail would
//   show
// - no text of the mail (the subject, the preview, a title, the text of a block) writes out an
//   address of another site, with a scheme, with www, as a domain with a path or as a name with a real
//   top-level domain (`example.com`, `example.com?x=1`), which a mail program makes into a link:
//   NEWSLETTER_ADDRESS_NOT_ALLOWED names the place and the address. The sites that pass are the domains of the
//   context: the shop's own and the ones root trusts, with their subdomains (foreignAddress.ts)
// The content may be a draft that is not finished (no text in the language of the shop, no block):
// whether it is whole is for the one who schedules the campaign. The check goes through the content
// in the order it is written and stops at the first fault, so the answer is the same for the same
// content.

// what a block of products takes when it leaves out the number of cards or the period of the best
// sellers: the mail is made with these
export const RULE_BLOCK_DEFAULT_LIMIT = 4;
export const BESTSELLERS_DEFAULT_PERIOD_DAYS = 30;

// the longest address, and the longest key of a language, the answer repeats (the warning of a
// translation repeats an address as long)
export const URL_IN_ANSWER_MAX = 200;
const LOCALE_IN_ANSWER_MAX = 40;

export type NewsletterContentContext = {
  // the codes of the languages the shop answers in (`enabledLocales`)
  locales: readonly string[];
  // the origin of the shop (WEB_ORIGIN); without it no link is allowed
  origin: string | null;
  // the domains a text may name an address of (newsletterAllowedDomains): the shop's own and the
  // trusted ones. Without any, no address is allowed
  domains: readonly string[];
  // the domains root trusts (newsletterTrustedDomains): a link may lead to one, as it may to the shop.
  // Without any, a link leads to the shop only
  trusted: readonly string[];
};

// the content of a campaign made without one: no language, no block
export const emptyNewsletterContent = (): NewsletterContentDto => ({
  subject: {},
  preview: {},
  blocks: [],
});

// the languages that have a subject, in the order they were written
export const languagesOfContent = (content: NewsletterContentInputDto): string[] =>
  Object.keys(content.subject);

// The languages of a stored content (the ones it has a subject in) that the shop does not answer in:
// root turned them off after the text was written. The text stays in the campaign and does not go out
// (nobody has the language any more, the sending takes the language of each person at the start), so
// these are the languages the answer marks as off. In the order of the codes. What is no content (the
// column is json) has none
export function disabledLocalesOf(stored: unknown, enabled: readonly string[]): string[] {
  const subject = (stored as { subject?: unknown } | null | undefined)?.subject;
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return [];

  return disabledAmong(Object.keys(subject), enabled);
}

// the same for languages already listed (the list of campaigns reads their codes without the content)
export const disabledAmong = (languages: readonly string[], enabled: readonly string[]): string[] =>
  languages.filter((code) => !enabled.includes(code)).sort();

// The languages a new content may be written in when it replaces a stored one: the languages of the
// shop, and the ones the stored content already has a subject in that the shop has turned off since,
// when a dictionary still has them. So the text of a language that is off can be kept and edited, but
// a text in a language that is off is never a new one. A content that was never stored has no such
// language
export function localesForContent(enabled: readonly string[], stored?: unknown): string[] {
  const kept = disabledLocalesOf(stored, enabled).filter(isAvailableLocale);
  return [...enabled, ...kept];
}

// the texts of one place with the spaces around each cut
function trimmed(texts: NewsletterTextsDto): NewsletterTextsDto {
  return Object.fromEntries(Object.entries(texts).map(([locale, text]) => [locale, text.trim()]));
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

// a place of the content that has no text where one is wanted; `locale` is null for a place that is
// no language's (the list of blocks)
export type MissingPart = { field: string; locale: string | null };

const isBlank = (text: string | undefined): boolean => text === undefined || text.trim() === '';

// What a content still lacks before it can go out (a draft may lack anything). The rules: at least one
// block; the subject of the language of the shop; in the language of the shop, the text of every text
// block and the title of every block that has a title in any language; and every other language that
// has a subject, and that the shop answers in (`enabled`), needs the same texts. A language the shop
// has turned off is not asked for anything: its text stays and does not go out. A preview is never
// wanted. The places come language by language, the language of the shop first and the others in the
// order of their subjects, the subject before the blocks and the blocks in their order; the same
// content gives the same list
export function missingInContent(
  content: NewsletterContentDto,
  shopLocale: string,
  enabled: readonly string[],
): MissingPart[] {
  const missing: MissingPart[] = [];
  if (content.blocks.length === 0) missing.push({ field: 'content.blocks', locale: null });

  const languages = [
    shopLocale,
    ...Object.keys(content.subject).filter((l) => l !== shopLocale && enabled.includes(l)),
  ];

  for (const locale of languages) {
    if (isBlank(content.subject[locale])) {
      missing.push({ field: `content.subject.${locale}`, locale });
    }

    content.blocks.forEach((block, index) => {
      const at = `content.blocks[${index}]`;

      if (block.type === 'text') {
        if (isBlank(block.text[locale])) missing.push({ field: `${at}.text.${locale}`, locale });
      } else if (
        (block.type === 'products' || block.type === 'category') &&
        block.title &&
        Object.keys(block.title).length > 0 &&
        isBlank(block.title[locale])
      ) {
        missing.push({ field: `${at}.title.${locale}`, locale });
      }
    });
  }

  return missing;
}

// Checks the content and gives back the content to keep: the same, with a preview of nothing when
// there was none and the spaces around the texts of one line (subject, preview, titles) cut. The text
// of a block is kept as it was typed. The content that was given is not changed.
export function checkNewsletterContent(
  content: NewsletterContentInputDto,
  context: NewsletterContentContext,
): NewsletterContentDto {
  const written = new Set(Object.keys(content.subject));

  // the language of a text: a language of the shop that has a subject
  const checkLanguage = (field: string, locale: string, needsSubject: boolean) => {
    // a key can be as long as the body: the answer repeats the start of it only
    const named = clip(locale, LOCALE_IN_ANSWER_MAX);
    const where = { field: `${field}.${named}`, locale: named };

    if (!context.locales.includes(locale)) throw new BadRequestError('LOCALE_INVALID', where);
    if (needsSubject && !written.has(locale)) {
      throw new BadRequestError('NEWSLETTER_LOCALE_WITHOUT_SUBJECT', where);
    }
  };

  // no address of another site in the text of one language; a text of the markup is read as the reader
  // gets it as well (foreignAddressOfMarkup)
  const checkAddresses = (field: string, text: string, markup = false) => {
    const address = markup
      ? foreignAddressOfMarkup(text, context.domains)
      : foreignAddressOf(text, context.domains);
    if (address === null) return;

    throw new BadRequestError('NEWSLETTER_ADDRESS_NOT_ALLOWED', {
      field,
      address: clip(address, URL_IN_ANSWER_MAX),
    });
  };

  const checkTexts = (field: string, texts: NewsletterTextsDto, needsSubject = true) => {
    for (const [locale, text] of Object.entries(texts)) {
      checkLanguage(field, locale, needsSubject);
      checkAddresses(`${field}.${clip(locale, LOCALE_IN_ANSWER_MAX)}`, text);
    }
  };

  const checkLink = (field: string, url: string) => {
    if (!isLinkAllowed(url, context.origin, context.trusted)) {
      throw new BadRequestError('NEWSLETTER_LINK_NOT_ALLOWED', {
        field,
        url: clip(url, URL_IN_ANSWER_MAX),
      });
    }
  };

  checkTexts('content.subject', content.subject, false);
  const preview = content.preview ?? {};
  checkTexts('content.preview', preview);

  const blocks = content.blocks.map((block, index): NewsletterBlockDto => {
    const at = `content.blocks[${index}]`;

    switch (block.type) {
      case 'text': {
        // the language first, then the links of the text of that language
        for (const [locale, markup] of Object.entries(block.text)) {
          checkLanguage(`${at}.text`, locale, true);

          for (const url of linksOfMarkup(parseMarkup(markup))) {
            checkLink(`${at}.text.${locale}`, url);
          }

          checkAddresses(`${at}.text.${locale}`, markup, true);
        }

        return { type: 'text', text: { ...block.text } };
      }
      case 'products':
      case 'category': {
        if (block.title) checkTexts(`${at}.title`, block.title);

        return {
          ...block,
          ...(block.title ? { title: trimmed(block.title) } : {}),
          ...(block.type === 'products' && block.source === 'manual'
            ? { productIds: [...block.productIds] }
            : {}),
        } as NewsletterBlockDto;
      }
      case 'button':
        checkLink(`${at}.url`, block.url);

        return { ...block };
    }
  });

  return { subject: trimmed(content.subject), preview: trimmed(preview), blocks };
}
