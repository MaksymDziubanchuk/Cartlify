import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// Where a subscription comes from, and the two states in which it is in force (a request that
// waits, an ended one and one a bounce stopped are not shown to the person)
export type NewsletterSource = 'form' | 'account';
export type NewsletterLiveStatus = 'active' | 'paused_complaint';

// what a request carries to the services: the address and the browser of the request go to the
// functions of the database, which write them into the journal of the subscription
export interface NewsletterRequestInfoDto {
  ip: string | null;
  userAgent: string | null;
}

// ---- the form of the public page ----

export interface SubscribeBodyDto {
  email?: string;
  locale?: string;
  captchaToken?: string;
}

export interface SubscribeDto extends NewsletterRequestInfoDto {
  actorId: UserId;
  actorRole: Role;
  email?: string;
  locale?: string;
  captchaToken?: string;
}

// the subscription of a person as the profile shows it
export interface NewsletterSubscriptionDto {
  subscribed: true;
  source: NewsletterSource;
  status: NewsletterLiveStatus;
  locale: string | null;
  canChangeLocale: boolean;
  subscribedAt: Date;
}

export type NewsletterProfileResponseDto = { subscribed: false } | NewsletterSubscriptionDto;

// the answer of the form: a request from a guest (or about another address) is only accepted, the
// subscription of a signed-in user for their own address is made
export type SubscribeResultDto =
  { kind: 'accepted' } | { kind: 'subscribed'; subscription: NewsletterSubscriptionDto };

export interface SubscribeAcceptedResponseDto {
  message: string;
}

// ---- the buttons of the mail of a confirmation ----

export interface NewsletterTokenBodyDto {
  token: string;
}

export interface ConfirmSubscriptionDto extends NewsletterRequestInfoDto {
  token: string;
}

export interface ConfirmSubscriptionResponseDto {
  status: 'active';
  locale: string | null;
}

export interface DeclineSubscriptionDto extends NewsletterRequestInfoDto {
  token: string;
}

export interface DeclineSubscriptionResponseDto {
  blocked: true;
}

// ---- the page "Manage the subscription" ----

export interface NewsletterManageStateDto {
  email: string;
  source: NewsletterSource;
  locale: string | null;
  status: NewsletterLiveStatus;
  canChangeLocale: boolean;
}

export interface ManageStateDto {
  token: string;
}

export interface ManageLocaleBodyDto {
  token: string;
  locale: string;
}

export interface ManageLocaleDto extends NewsletterRequestInfoDto {
  token: string;
  locale: string;
}

export interface ManageActionDto extends NewsletterRequestInfoDto {
  token: string;
}

export interface NewsletterUnsubscribedResponseDto {
  unsubscribed: true;
}

export interface NewsletterEventExportDto {
  event: string;
  place: string;
  ip: string | null;
  userAgent: string | null;
  locale: string | null;
  campaignId: number | null;
  privacyVersion: number | null;
  createdAt: string;
}

export interface NewsletterExportItemDto {
  email: string;
  source: NewsletterSource;
  locale: string | null;
  status: string;
  createdAt: string;
  confirmedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  events: NewsletterEventExportDto[];
}

export interface NewsletterExportResponseDto {
  subscriptions: NewsletterExportItemDto[];
}

// ---- the one-click unsubscribe of a mail client ----

export interface OneClickParamsDto {
  token: string;
}

export interface OneClickQueryDto {
  c?: string;
}

export interface OneClickDto extends NewsletterRequestInfoDto {
  token: string;
  // the id of the campaign the mail came from, as the address names it
  campaign?: string;
}

// ---- the profile of a signed-in user ----

export interface ProfileLocaleBodyDto {
  locale: string;
}

export interface ProfileDto {
  actorId: UserId;
  actorRole: Role;
}

export interface ProfileActionDto extends ProfileDto, NewsletterRequestInfoDto {}

export interface ProfileLocaleDto extends ProfileActionDto {
  locale: string;
}

// ---- the people who run the newsletters: the subscribers and the blocklist ----

// who asks: the routes let in root and an admin whom root allowed (requireNewsletterManager), and the
// services run for this actor, so the policies of the database see the right again
export interface NewsletterManagerDto {
  actorId: UserId;
  actorRole: Role;
}

export type NewsletterSubscriberStatus =
  'pending' | 'active' | 'paused_complaint' | 'stopped_bounce' | 'ended';

export type NewsletterEndReason =
  'unsubscribed' | 'account_deleted' | 'removed_by_admin' | 'expired' | 'not_me' | 'bounced';

// a bucket of the subscriptions in force by language; null is the subscriptions without one
export interface NewsletterLocaleBucketDto {
  locale: string | null;
  count: number;
}

export interface NewsletterSubscribersSummaryDto {
  active: number;
  byLocale: NewsletterLocaleBucketDto[];
  bySource: { form: number; account: number };
  pending: number;
  pausedComplaint: number;
  stoppedBounce: number;
}

export interface SubscribersQueryDto {
  limit?: number;
  cursor?: string;
  status?: string;
  source?: string;
  locale?: string;
  email?: string;
}

export interface FindSubscribersDto extends NewsletterManagerDto, SubscribersQueryDto {}

// a row of the list of subscribers: the fields one by one, never a hash, a salt or a token
export interface NewsletterSubscriberItemDto {
  id: number;
  email: string;
  source: NewsletterSource;
  locale: string | null;
  status: NewsletterSubscriberStatus;
  userId: number | null;
  createdAt: Date;
  confirmedAt: Date | null;
  endedAt: Date | null;
  endReason: NewsletterEndReason | null;
}

export interface NewsletterSubscribersResponseDto {
  items: NewsletterSubscriberItemDto[];
  limit: number;
  nextCursor: string | null;
  total: number;
}

export interface SubscriberParamsDto {
  subscriberId: string;
}

export interface EraseSubscriberDto extends NewsletterManagerDto {
  subscriberId: number;
}

// the subscriptions of the address made anonymous (nothing is deleted)
export interface NewsletterSubscriberErasedResponseDto {
  erased: true;
  subscriptions: number;
}

// an entry of the blocklist as an admin sees it: no HMAC of the address, which is no one's to read
export interface NewsletterBlockEntryDto {
  id: number;
  createdAt: Date;
  blockedById: number | null;
  byPerson: boolean;
  reason: string | null;
}

export interface BlocklistQueryDto {
  email: string;
}

export interface FindBlockedDto extends NewsletterManagerDto {
  email: string;
}

export interface NewsletterBlockLookupResponseDto {
  blocked: boolean;
  entry: NewsletterBlockEntryDto | null;
}

export interface BlocklistBodyDto {
  email: string;
  reason?: string;
}

export interface AddBlockDto extends NewsletterManagerDto {
  email: string;
  reason?: string;
}

export interface NewsletterBlockAddedResponseDto {
  created: boolean;
  entry: NewsletterBlockEntryDto;
}

export interface BlockParamsDto {
  blockId: string;
}

export interface RemoveBlockDto extends NewsletterManagerDto {
  blockId: number;
}

export interface NewsletterBlockRemovedResponseDto {
  removed: true;
}

// ---- the campaigns ----

// the texts of one place of a campaign, for each language the shop answers in (the key is its code)
export type NewsletterTextsDto = Record<string, string>;

export type NewsletterProductRule = 'new' | 'sale' | 'popular' | 'top_rated';

export interface NewsletterTextBlockDto {
  type: 'text';
  text: NewsletterTextsDto;
}

// products chosen by hand: 1 to 12 ids
export interface NewsletterProductsManualBlockDto {
  type: 'products';
  source: 'manual';
  title?: NewsletterTextsDto;
  productIds: number[];
}

// products taken by a rule (the rule bestsellers has its own shape, with a period)
export interface NewsletterProductsRuleBlockDto {
  type: 'products';
  source: 'rule';
  title?: NewsletterTextsDto;
  rule: NewsletterProductRule;
  limit?: number;
  categoryId?: number;
}

export interface NewsletterProductsBestsellersBlockDto {
  type: 'products';
  source: 'rule';
  title?: NewsletterTextsDto;
  rule: 'bestsellers';
  limit?: number;
  categoryId?: number;
  periodDays?: 7 | 30 | 90;
}

export interface NewsletterCategoryBlockDto {
  type: 'category';
  categoryId: number;
  title?: NewsletterTextsDto;
}

export type NewsletterButtonKind = 'shop' | 'sale' | 'new' | 'category' | 'product';

export interface NewsletterButtonBlockDto {
  type: 'button';
  kind: NewsletterButtonKind;
  url: string;
}

export type NewsletterBlockDto =
  | NewsletterTextBlockDto
  | NewsletterProductsManualBlockDto
  | NewsletterProductsRuleBlockDto
  | NewsletterProductsBestsellersBlockDto
  | NewsletterCategoryBlockDto
  | NewsletterButtonBlockDto;

// the content as a request carries it (the preview may be left out) and as it is kept
export interface NewsletterContentInputDto {
  subject: NewsletterTextsDto;
  preview?: NewsletterTextsDto;
  blocks: NewsletterBlockDto[];
}

export interface NewsletterContentDto extends NewsletterContentInputDto {
  preview: NewsletterTextsDto;
}

export type NewsletterMissingLocale = 'shop_locale' | 'skip';

export type NewsletterCampaignStatus =
  'draft' | 'scheduled' | 'sending' | 'finished' | 'cancelled' | 'stopped';

// why a campaign was called off when it was not a manager: the limit of the campaigns of the shop
// (the worker found no room for it when its time came)
export type NewsletterCancelReason = 'limit';

export interface NewsletterCampaignCountersDto {
  planned: number;
  sent: number;
  rejected: number;
  undelivered: number;
  complaints: number;
  unsubscribed: number;
}

// a campaign in the list: no content
export interface NewsletterCampaignItemDto {
  id: number;
  name: string;
  status: NewsletterCampaignStatus;
  scheduledAt: Date | null;
  // set when the system called the campaign off (cancelled), null otherwise
  cancelReason: NewsletterCancelReason | null;
  missingLocale: NewsletterMissingLocale;
  counters: NewsletterCampaignCountersDto;
  // the languages the campaign has a subject in that the shop does not answer in now
  disabledLocales: string[];
  createdById: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewsletterCampaignDto extends NewsletterCampaignItemDto {
  content: NewsletterContentDto;
  updatedById: number;
  copiedFromId: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  stoppedAt: Date | null;
  cancelledAt: Date | null;
}

export interface NewsletterCampaignsResponseDto {
  items: NewsletterCampaignItemDto[];
  limit: number;
  nextCursor: string | null;
  total: number;
}

export interface CampaignParamsDto {
  campaignId: string;
}

export interface CreateCampaignBodyDto {
  name: string;
  missingLocale?: NewsletterMissingLocale;
  content?: NewsletterContentInputDto;
}

export interface UpdateCampaignBodyDto {
  name?: string;
  missingLocale?: NewsletterMissingLocale;
  content?: NewsletterContentInputDto;
}

// scheduled for a time, or for now: exactly one of the two (the schema holds it)
export interface ScheduleCampaignBodyDto {
  scheduledAt?: string;
  runNow?: true;
}

export interface CampaignsQueryDto {
  limit?: number;
  cursor?: string;
  status?: string;
  // when it started, taken in and left out; the time it is scheduled for, left out
  startedFrom?: string;
  startedTo?: string;
  scheduledTo?: string;
  // when it was called off (taken in) and why
  cancelledFrom?: string;
  cancelReason?: NewsletterCancelReason;
  // the share of its mails it is over: not delivered and not taken in per cent, complained of in
  // thousandths
  undeliveredOver?: number;
  rejectedOver?: number;
  complaintsOver?: number;
}

export interface CreateCampaignDto extends NewsletterManagerDto, CreateCampaignBodyDto {}

export interface UpdateCampaignDto extends NewsletterManagerDto, UpdateCampaignBodyDto {
  campaignId: number;
}

export interface FindCampaignsDto extends NewsletterManagerDto, CampaignsQueryDto {}

export interface ScheduleCampaignDto extends NewsletterManagerDto, ScheduleCampaignBodyDto {
  campaignId: number;
}

export interface CampaignActionDto extends NewsletterManagerDto {
  campaignId: number;
}

export interface NewsletterCampaignDeletedResponseDto {
  deleted: true;
}

// ---- the products of a mail, the preview and the test mail ----

// A card of a product in a mail, as it stood when the products were taken: language free (the name
// of a product is not translated), the prices numbers in the currency of the snapshot, the picture
// an address. The prices are the ones a buyer pays: `price` is the regular price (the lowest of the
// variants when `from` is set), a product on sale also has `salePrice`, and `priorPrice` is the
// lowest price of the 30 days before the sale (the Omnibus rule) when the sale knows it
export interface NewsletterCardDto {
  productId: number;
  variantId: number;
  name: string;
  imageUrl: string | null;
  price: number;
  from: boolean;
  salePrice: number | null;
  priorPrice: number | null;
  saleEndsAt: string | null;
}

// a block of products: the cards (the list a buyer sees, the ones he can buy), the products of a block
// by hand that were left out (deleted, hidden or out of stock now) and a category of the rule that is
// gone
export interface NewsletterSnapshotProductsDto {
  kind: 'products';
  items: NewsletterCardDto[];
  unavailable: number[];
  categoryMissing: boolean;
}

// a block of a category: the category as the shop keeps it; null when it is gone
export interface NewsletterSnapshotCategoryDto {
  kind: 'category';
  category: { id: number; name: string; imageUrl: string | null } | null;
}

// What a mail needs of the shop that the content does not hold: for each block of the content, in
// its order, the products or the category (null for a block of text or a button). Plain json, the
// campaign keeps it from the moment it goes out
export interface NewsletterSnapshotDto {
  takenAt: string;
  // the currency of every price, an upper case code
  currency: string;
  blocks: Array<NewsletterSnapshotProductsDto | NewsletterSnapshotCategoryDto | null>;
}

// what is wrong or left out in a mail; `blockIndex` is null for a fault of the whole mail
export type NewsletterWarningCode =
  | 'PRODUCT_UNAVAILABLE'
  | 'BLOCK_EMPTY'
  | 'CATEGORY_MISSING'
  | 'LINK_NOT_ALLOWED'
  | 'TEXT_MISSING'
  | 'TITLE_MISSING'
  | 'MAIL_EMPTY'
  | 'MAIL_TOO_LARGE';

export interface NewsletterWarningDto {
  blockIndex: number | null;
  code: NewsletterWarningCode;
  // PRODUCT_UNAVAILABLE: the product that was left out
  productId?: number;
}

export interface CampaignLocaleBodyDto {
  locale: string;
}

export interface CampaignTestBodyDto extends CampaignLocaleBodyDto {
  email: string;
}

export interface CampaignPreviewDto extends NewsletterManagerDto, CampaignLocaleBodyDto {
  campaignId: number;
}

export interface CampaignTestDto extends NewsletterManagerDto, CampaignTestBodyDto {
  campaignId: number;
}

export interface NewsletterPreviewResponseDto {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  warnings: NewsletterWarningDto[];
  // when the products were taken
  takenAt: string;
}

export interface NewsletterTestSentResponseDto {
  sent: true;
}

export type NewsletterTranslateKind = 'line' | 'markup';

// a text of a campaign to be translated, under the name the draft comes back with
export interface NewsletterTranslateItemDto {
  key: string;
  text: string;
  kind: NewsletterTranslateKind;
  // the most characters the draft may have, when it must be shorter than the limit of its kind
  maxChars?: number;
}

export interface NewsletterTranslateBodyDto {
  // the language of the texts; the language of the shop when left out
  from?: string;
  to: string[];
  items: NewsletterTranslateItemDto[];
}

export type NewsletterTranslateWarningCode =
  | 'MISSING'
  | 'TRANSLATION_FAILED'
  | 'LINK_CHANGED'
  | 'ADDRESS_NOT_ALLOWED'
  | 'HTML_NOT_ALLOWED'
  | 'TOO_LONG'
  | 'NOT_A_LINE';

export interface NewsletterTranslateWarningDto {
  locale: string;
  key: string;
  code: NewsletterTranslateWarningCode;
  // `ADDRESS_NOT_ALLOWED` only: the place of the text, the `key` and the language as the content error
  // names it (`<key>.<locale>`), and the first address that is not allowed (up to 200 characters)
  field?: string;
  address?: string;
}

export interface NewsletterTranslateResponseDto {
  // for each language asked, the drafts by the key of the text
  translations: Record<string, Record<string, string>>;
  warnings: NewsletterTranslateWarningDto[];
}

// POST /sendgrid/webhook: the Event Webhook of SendGrid
export interface HandleSendGridWebhookDto {
  signature: string;
  timestamp: string;
  // the exact bytes of the body, which the signature is made over
  rawBody: Buffer;
}

export interface SendGridWebhookResponseDto {
  received: true;
  // events the database applied to a mail of this environment
  applied: number;
  // events left alone: a kind the app does not keep, a mail of another environment or of no
  // campaign, a recipient this database does not have
  skipped: number;
}
