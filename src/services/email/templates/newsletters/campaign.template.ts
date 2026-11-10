import env from '@config/env.js';
import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { categoryPagePath, productPagePath } from '@helpers/newsletterLinks.js';
import {
  linksOfMarkup,
  parseMarkup,
  renderMarkupHtml,
  renderMarkupText,
} from '@helpers/newsletterMarkup.js';
import { isLinkAllowed, markedLink, shopLinkOf, trustedLinkOf } from '@helpers/shopLink.js';
import { webOrigin } from '@helpers/webOrigin.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';
import { InternalError } from '@utils/errors.js';
import type {
  NewsletterBlockDto,
  NewsletterButtonBlockDto,
  NewsletterCardDto,
  NewsletterCategoryBlockDto,
  NewsletterContentDto,
  NewsletterProductsBestsellersBlockDto,
  NewsletterProductsManualBlockDto,
  NewsletterProductsRuleBlockDto,
  NewsletterSnapshotDto,
  NewsletterTextBlockDto,
  NewsletterTextsDto,
  NewsletterWarningDto,
} from 'types/dto/newsletters.dto.js';

// The mail of a newsletter campaign: the logo, the blocks of the admin in their order, the foot that
// every mail of the newsletter has (the seller, why the reader got it, the link to manage the
// subscription, that the mail is automatic), all in the language of the reader. The html of the
// pieces is in the files next to this one (campaign*.html); here is what goes into them.
//
// Nothing is trusted that was saved: every link is judged by the origin of the shop and the sites root
// trusts as they are now (isLinkAllowed) before it goes into the mail, and a block that cannot be shown is left out with a
// warning, never an error, so a preview shows the admin what would go and what would not. The names
// of the products and of the categories, the titles and the texts are data: the html is escaped by the
// template, and the markup of a text is turned into a few safe tags by the parser of the markup

// the error of a language the campaign has no subject in; the callers map it (the preview and the test
// mail to 400, the sender decides by the setting of the campaign before it asks)
export class CampaignLocaleMissingError extends Error {
  constructor() {
    super('NEWSLETTER_LOCALE_NOT_IN_CAMPAIGN');
    this.name = 'CampaignLocaleMissingError';
  }
}

// Gmail cuts a mail of about this many bytes and hides the foot, with the link to leave
const GMAIL_CLIPS_AT_BYTES = 102_400;

export type CampaignMailArgs = {
  content: NewsletterContentDto;
  // the products and the categories of the blocks, taken when the mail was prepared
  snapshot: NewsletterSnapshotDto;
  // the language of the reader; the campaign must have a subject in it
  locale: string;
  campaignId: number;
  // the link "Manage the subscription" and the address of the one-click unsubscribe of the mail
  // program (the header List-Unsubscribe), both of the reader
  manageUrl: string;
  unsubscribeUrl: string;
  // the address of the logo of the shop (at Cloudinary), shown as an image; the name of the shop stands in
  // its place while there is none. The mail carries no attachment
  logoUrl?: string | null;
  // the test mail of an admin: the subject starts with the word "test" of the language, and a line at
  // the top says the subscribers did not get this mail. Nothing else of the mail changes
  test?: boolean;
  // the origin of the shop the links must lead to; the one of the app unless given
  origin?: string | null;
  // the domains of the sites root trusts, which a link of a text or a button may lead to as well (with
  // no marks of the campaign); newsletterTrustedDomains of the data of the shop unless given
  trustedDomains?: readonly string[];
  // The moment the mail is built: a sale of a card that has ended by then is not shown. The products
  // were taken when the campaign started, the mails go out hours or days after; now unless given
  now?: Date;
  // the time zone of the shop, whose calendar names the day a sale ends; SHOP_TIME_ZONE unless given
  timeZone?: string;
};

export type CampaignMail = {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  // List-Unsubscribe and List-Unsubscribe-Post
  headers: Record<string, string>;
  warnings: NewsletterWarningDto[];
};

// an address of a web page, with no space, no angle bracket and no new line: it goes into a header
const HEADER_URL = /^https?:\/\/[^\s<>]+$/;

// How a tag of the markup looks in a mail, which does not read style sheets well: set on the tag
const MARKUP_STYLES = {
  p: 'margin:0 0 12px 0;',
  h2: 'font-size:20px;font-weight:800;color:#2e1065;margin:0 0 10px 0;',
  ul: 'margin:0 0 12px 0;padding-left:20px;',
  li: 'margin:0 0 4px 0;',
  a: 'color:#6d28d9;text-decoration:underline;',
} as const;

// The html of renderMarkupHtml has these tags and no others, none with an attribute of a person; the
// text of a person has no tag in it (its angle brackets are escaped), so the tags found are ours
function styledMarkup(html: string): string {
  return html.replace(
    /<(p|h2|ul|li|a)(?=[\s>])/g,
    (_tag, name: keyof typeof MARKUP_STYLES) => `<${name} style="${MARKUP_STYLES[name]}"`,
  );
}

// a picture of a card must be a web address; a stored value that is not one is no picture
const pictureOf = (url: string | null): string => (url && /^https?:\/\//i.test(url) ? url : '');

type Rendered = { html: string; text: string };

type ProductsBlock =
  | NewsletterProductsManualBlockDto
  | NewsletterProductsRuleBlockDto
  | NewsletterProductsBestsellersBlockDto;

type Context = {
  locale: string;
  origin: string;
  trusted: readonly string[];
  campaignId: number;
  appName: string;
  money: Intl.NumberFormat;
  // the day a sale ends, as the language of the reader writes a date, in the time zone of the shop
  day: Intl.DateTimeFormat;
  // the moment the mail is built, in milliseconds
  now: number;
  warnings: NewsletterWarningDto[];
};

const textIn = (texts: NewsletterTextsDto | undefined, locale: string): string =>
  texts?.[locale]?.trim() ?? '';

// the title of a block of products or of a category: the one of the language; a block that has titles
// of other languages only goes without one and the admin is told
function titleOf(
  block: ProductsBlock | NewsletterCategoryBlockDto,
  index: number,
  ctx: Context,
): string {
  const title = textIn(block.title, ctx.locale);

  if (!title && block.title && Object.keys(block.title).length > 0) {
    ctx.warnings.push({ blockIndex: index, code: 'TITLE_MISSING' });
  }

  return title;
}

// an address of a page of the shop for a card, with the marks of the campaign; the page comes from the
// settings and is a path of the shop, so a link that cannot be built is a fault of the server
function pageLink(path: string, ctx: Context): string {
  const link = shopLinkOf(path, ctx.origin);
  if (!link) throw new InternalError({ reason: 'NEWSLETTER_PAGE_LINK_INVALID' });

  return markedLink(link, ctx.campaignId);
}

function textBlock(block: NewsletterTextBlockDto, index: number, ctx: Context): Rendered | null {
  const markup = textIn(block.text, ctx.locale);
  const dropped = () => {
    ctx.warnings.push({ blockIndex: index, code: 'TEXT_MISSING' });
    return null;
  };
  if (!markup) return dropped();

  let parsed;
  try {
    parsed = parseMarkup(markup);
  } catch {
    // a text over the limit of the editor: it was never saved by a route
    return dropped();
  }

  if (linksOfMarkup(parsed).some((url) => !isLinkAllowed(url, ctx.origin, ctx.trusted))) {
    ctx.warnings.push({ blockIndex: index, code: 'LINK_NOT_ALLOWED' });
  }

  const options = { origin: ctx.origin, campaignId: ctx.campaignId, trusted: ctx.trusted };
  return {
    html: renderTemplate('newsletters/campaignText.html', {
      content: styledMarkup(renderMarkupHtml(parsed, options)),
    }),
    text: renderMarkupText(parsed, options),
  };
}

// The end of the sale of a card, as an instant; null when the sale has none, or the end is not a time
// (a stored value that is no date is a sale with no end to show)
function saleEndOf(card: NewsletterCardDto): number | null {
  if (card.saleEndsAt === null) return null;

  const end = new Date(card.saleEndsAt).getTime();
  return Number.isNaN(end) ? null : end;
}

// the card of a product: what a buyer sees of it in the catalog. A sale shows the price now, the
// regular price, the lowest price of 30 days and until what day it lasts; once its end has come, by
// the time the mail is built, the card is the regular price only, as the catalog shows it
function productCard(card: NewsletterCardDto, ctx: Context) {
  const url = pageLink(productPagePath(card.productId), ctx);
  const price = ctx.money.format(card.price);
  const shown = card.from ? t('campaignMail.priceFrom', ctx.locale, { price }) : price;
  const end = saleEndOf(card);
  const onSale = card.salePrice !== null && (end === null || end > ctx.now);
  const sale = onSale ? ctx.money.format(card.salePrice!) : '';
  const prior =
    onSale && card.priorPrice !== null
      ? t('campaignMail.lowestPrice', ctx.locale, { price: ctx.money.format(card.priorPrice) })
      : '';
  const until =
    onSale && end !== null
      ? t('campaignMail.saleUntil', ctx.locale, { date: ctx.day.format(new Date(end)) })
      : '';

  return {
    url,
    name: card.name,
    imageUrl: pictureOf(card.imageUrl),
    price: shown,
    sale,
    prior,
    until,
  };
}

function productsBlock(
  block: ProductsBlock,
  index: number,
  snapshot: NewsletterSnapshotDto,
  ctx: Context,
): Rendered | null {
  const shot = snapshot.blocks[index];
  const taken = shot?.kind === 'products' ? shot : null;

  for (const productId of taken?.unavailable ?? []) {
    ctx.warnings.push({ blockIndex: index, code: 'PRODUCT_UNAVAILABLE', productId });
  }
  if (taken?.categoryMissing) {
    ctx.warnings.push({ blockIndex: index, code: 'CATEGORY_MISSING' });
    return null;
  }
  if (!taken || taken.items.length === 0) {
    ctx.warnings.push({ blockIndex: index, code: 'BLOCK_EMPTY' });
    return null;
  }

  const title = titleOf(block, index, ctx);
  const cards = taken.items.map((card) => productCard(card, ctx));

  return {
    html: renderTemplate('newsletters/campaignProducts.html', {
      title,
      cards: cards.map((card) => ({
        url: card.url,
        name: card.name,
        imageUrl: card.imageUrl,
        price: card.price,
        salePrice: card.sale,
        priorLine: card.prior,
        untilLine: card.until,
      })),
    }),
    text: [
      title,
      ...cards.map((card) =>
        [
          `${card.name}: ${card.sale ? `${card.sale} (${card.price})` : card.price}`,
          ...(card.prior ? [card.prior] : []),
          ...(card.until ? [card.until] : []),
          card.url,
        ].join('\n'),
      ),
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

function categoryBlock(
  block: NewsletterCategoryBlockDto,
  index: number,
  snapshot: NewsletterSnapshotDto,
  ctx: Context,
): Rendered | null {
  const shot = snapshot.blocks[index];
  const category = shot?.kind === 'category' ? shot.category : null;
  if (!category) {
    ctx.warnings.push({ blockIndex: index, code: 'CATEGORY_MISSING' });
    return null;
  }

  const title = titleOf(block, index, ctx);
  const url = pageLink(categoryPagePath(category.id), ctx);
  const label = t('campaignMail.buttonCategory', ctx.locale);

  return {
    html: renderTemplate('newsletters/campaignCategory.html', {
      title,
      url,
      name: category.name,
      imageUrl: pictureOf(category.imageUrl),
      label,
    }),
    text: [title, category.name, url].filter(Boolean).join('\n'),
  };
}

const BUTTON_LABELS = {
  shop: 'campaignMail.buttonShop',
  sale: 'campaignMail.buttonSale',
  new: 'campaignMail.buttonNew',
  category: 'campaignMail.buttonCategory',
  product: 'campaignMail.buttonProduct',
} as const;

function buttonBlock(
  block: NewsletterButtonBlockDto,
  index: number,
  ctx: Context,
): Rendered | null {
  // a link to the shop carries the marks of the campaign; one to a site root trusts goes as it is
  const shopLink = shopLinkOf(block.url, ctx.origin);
  const url = shopLink
    ? markedLink(shopLink, ctx.campaignId)
    : trustedLinkOf(block.url, ctx.trusted);
  if (!url) {
    ctx.warnings.push({ blockIndex: index, code: 'LINK_NOT_ALLOWED' });
    return null;
  }

  const label = t(BUTTON_LABELS[block.kind], ctx.locale);

  return {
    html: renderTemplate('newsletters/campaignButton.html', { url, label }),
    text: `${label}: ${url}`,
  };
}

function renderBlock(
  block: NewsletterBlockDto,
  index: number,
  snapshot: NewsletterSnapshotDto,
  ctx: Context,
): Rendered | null {
  switch (block.type) {
    case 'text':
      return textBlock(block, index, ctx);
    case 'products':
      return productsBlock(block, index, snapshot, ctx);
    case 'category':
      return categoryBlock(block, index, snapshot, ctx);
    case 'button':
      return buttonBlock(block, index, ctx);
  }
}

// The mail of a campaign for a reader of the language `locale`: the subject and the preview of that
// language, the html and the plain text, the headers of the one-click unsubscribe, and what was wrong or
// left out (the warnings, by block). A language the campaign has no subject in is an error
// (CampaignLocaleMissingError). The function reads the settings of the app but no database and no
// network: the products and the categories are in the snapshot
export function renderCampaignMail(args: CampaignMailArgs): CampaignMail {
  const written = textIn(args.content.subject, args.locale);
  if (!written) throw new CampaignLocaleMissingError();

  const subject = args.test
    ? `${t('campaignMail.testSubjectPrefix', args.locale)} ${written}`
    : written;

  const manageUrl = args.manageUrl?.trim() || '';
  const unsubscribeUrl = args.unsubscribeUrl?.trim() || '';
  if (!manageUrl) throw new Error('MANAGE_URL_REQUIRED');
  if (!HEADER_URL.test(unsubscribeUrl)) throw new Error('UNSUBSCRIBE_URL_INVALID');

  const origin = args.origin === undefined ? webOrigin : args.origin;
  if (!origin) throw new InternalError({ reason: 'WEB_ORIGIN_REQUIRED' });

  const locale = args.locale;
  const appName = shopSettings().shopName;
  const ctx: Context = {
    locale,
    origin,
    trusted: args.trustedDomains ?? shopSettings().newsletterTrustedDomains,
    campaignId: args.campaignId,
    appName,
    money: new Intl.NumberFormat(locale, { style: 'currency', currency: args.snapshot.currency }),
    // "en" writes a date the way the mails of the shop always did (1 May 2026, not May 1, 2026)
    day: new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {
      dateStyle: 'long',
      timeZone: args.timeZone ?? env.SHOP_TIME_ZONE,
    }),
    now: (args.now ?? new Date()).getTime(),
    warnings: [],
  };

  const shown: Rendered[] = [];
  args.content.blocks.forEach((block, index) => {
    const rendered = renderBlock(block, index, args.snapshot, ctx);
    if (rendered) shown.push(rendered);
  });

  if (shown.length === 0) ctx.warnings.push({ blockIndex: null, code: 'MAIL_EMPTY' });

  const preheader = textIn(args.content.preview, locale);
  const values = {
    appName,
    lang: locale,
    subject,
    preheader,
    logoUrl: args.logoUrl?.trim() || '',
    testNotice: args.test ? t('campaignMail.testNotice', locale) : '',
    blocks: shown.map((block) => block.html).join('\n'),
    manageUrl,
    manage: t('campaignMail.manage', locale),
    reason: t('campaignMail.reason', locale, { appName }),
    automatic: t('campaignMail.automatic', locale),
    year: String(new Date().getFullYear()),
    seller: sellerLineOf(locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  const html = renderTemplate('newsletters/campaign.html', values);
  const text = renderTemplate('newsletters/campaign.txt', {
    ...values,
    blocks: shown.map((block) => block.text).join('\n\n'),
  });

  if (Buffer.byteLength(html) > GMAIL_CLIPS_AT_BYTES) {
    ctx.warnings.push({ blockIndex: null, code: 'MAIL_TOO_LARGE' });
  }

  return {
    subject,
    preheader,
    html,
    text,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    warnings: ctx.warnings,
  };
}
