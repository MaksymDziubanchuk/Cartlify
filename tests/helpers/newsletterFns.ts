import { randomUUID } from 'node:crypto';

import type { Actor, DbSession, Outcome } from './db.js';
import { uniqueEmail } from './factories.js';
import { hex64 } from './newsletterDb.js';

// what the helpers need of a session: the one of the app role (inRolledBackTx) and the one of the
// owner of the database (inOwnerTx) both have it
type Session = Pick<DbSession, 'as' | 'rows' | 'attempt'>;

// the functions of the database that carry the subscription of a person (db/05, section
// NEWSLETTERS): the statements the app runs, and what the tests read to see what they did. The
// functions run as the owner and decide for themselves who may call them

export const DAY = 86_400_000;

export const GUEST = (): Actor => ({ role: 'GUEST', guestId: randomUUID() });
// the system: the admin context without a user id, the way setAdminContext sets it
export const SYSTEM: Actor = { role: 'ADMIN' };
// root without an account: reads every newsletter table (a check of what a function did)
export const READER: Actor = { role: 'ROOT' };

export const SQL = {
  request: 'select * from cartlify.newsletter_request($1, $2, $3, $4, $5, $6, $7, $8, $9)',
  // the request mail the provider refused: the mark of the day is taken back
  mailFailed: 'select cartlify.newsletter_request_mail_failed($1, $2) as done',
  confirm: 'select * from cartlify.newsletter_confirm($1, $2, $3)',
  notMe: 'select cartlify.newsletter_not_me($1, $2, $3) as done',
  manageGet: 'select * from cartlify.newsletter_manage_get($1)',
  manageSetLocale: 'select cartlify.newsletter_manage_set_locale($1, $2, $3, $4) as done',
  manageUnsubscribe:
    'select cartlify.newsletter_manage_unsubscribe($1, $2::int, $3, $4, $5) as done',
  // the button of the mail client: the hash of the unsubscribe token, the campaign, the address, the browser
  oneClick: 'select cartlify.newsletter_unsubscribe_one_click($1, $2::int, $3, $4) as done',
  manageResume: 'select cartlify.newsletter_manage_resume($1, $2, $3) as done',
  manageExport: 'select cartlify.newsletter_manage_export($1) as data',
  subscribeAccount:
    'select cartlify.newsletter_subscribe_account($1::int, $2, $3, $4, $5, $6, $7, $8) as outcome',
  profileGet: 'select * from cartlify.newsletter_profile_get($1::int)',
  profileUnsubscribe: 'select cartlify.newsletter_profile_unsubscribe($1::int, $2, $3) as done',
  profileSetLocale: 'select cartlify.newsletter_profile_set_locale($1::int, $2, $3, $4) as done',
  profileResume: 'select cartlify.newsletter_profile_resume($1::int, $2, $3) as done',
  profileExport: 'select cartlify.newsletter_profile_export($1::int) as data',
  endForAccount: 'select cartlify.newsletter_end_for_account($1::int) as ended',
  applyEvent: 'select cartlify.newsletter_apply_event($1::int, $2) as result',
  // the same with the reason the provider gave for a dropped mail
  applyEventWithReason: 'select cartlify.newsletter_apply_event($1::int, $2, $3) as result',
  adminErase: 'select cartlify.newsletter_admin_erase_address($1::int) as erased',
  blockAdd: 'select cartlify.newsletter_block_add($1, $2) as added',
  setManager: 'select cartlify.newsletter_set_manager($1::int, $2::boolean) as changed',
  localeCounts: 'select * from cartlify.newsletter_locale_counts()',
  resetLocale: 'select * from cartlify.newsletter_reset_locale($1)',
  // the sending: a campaign started (the number of mails planned), a portion of the mails taken
  // (the second argument narrows it to campaigns), the mails of a pass given back
  startCampaign: 'select cartlify.newsletter_start_campaign($1::int, $2::jsonb, $3) as planned',
  // the lease of 10 minutes and 5 tries are what the app passes for now
  claim: 'select * from cartlify.newsletter_claim_recipients($1::int, $2::int[], 10, 5)',
  claimWith:
    'select * from cartlify.newsletter_claim_recipients($1::int, $2::int[], $3::int, $4::int)',
  release: 'select cartlify.newsletter_release_recipients($1::int[]) as released',
} as const;

// the cleanups of the newsletters (the system runs them for the retention terms), by name
export const CLEANUPS = [
  'cleanup_newsletter_pending',
  'cleanup_newsletter_consent',
  'cleanup_newsletter_recipients',
] as const;
export const cleanupSql = (fn: (typeof CLEANUPS)[number]) => `select cartlify.${fn}() as removed`;

export const IP = '203.0.113.9';
export const AGENT = 'test-agent/1.0';

export type RequestArgs = {
  email: string;
  emailHmac: string;
  locale: string | null;
  confirmHash: string;
  manageSalt: string;
  manageHash: string;
  unsubscribeHash: string;
};

// what the form of a guest sends: an address of its own, the hashes of the tokens the server made
export const requestArgs = (set: Partial<RequestArgs> = {}): RequestArgs => ({
  email: uniqueEmail('req'),
  emailHmac: hex64(),
  locale: 'en',
  confirmHash: hex64(),
  manageSalt: hex64(),
  manageHash: hex64(),
  unsubscribeHash: hex64(),
  ...set,
});

export type RequestResult = { outcome: string; locale: string | null; manage_salt: string | null };

export async function requestAs(
  db: Session,
  actor: Actor | null,
  args: RequestArgs,
): Promise<Outcome<RequestResult>> {
  await db.as(actor);
  return db.attempt<RequestResult>(
    SQL.request,
    args.email,
    args.emailHmac,
    args.locale,
    args.confirmHash,
    args.manageSalt,
    args.manageHash,
    args.unsubscribeHash,
    IP,
    AGENT,
  );
}

// the rows of a statement that has to work, as an actor
export async function callAs<T = Record<string, unknown>>(
  db: Session,
  actor: Actor | null,
  sql: string,
  ...values: unknown[]
): Promise<T[]> {
  await db.as(actor);
  return db.rows<T>(sql, ...values);
}

// a statement the database may refuse: what it came to as a short word, a code or a value
export async function attemptAs<T = Record<string, unknown>>(
  db: Session,
  actor: Actor | null,
  sql: string,
  ...values: unknown[]
): Promise<Outcome<T>> {
  await db.as(actor);
  return db.attempt<T>(sql, ...values);
}

// the code a function refused with (its message is the code), or null when it answered
export const codeOf = (outcome: Outcome): string | null =>
  outcome.ok ? null : (outcome.message ?? outcome.code ?? 'refused');

export type SubscriptionRow = {
  id: number;
  email: string;
  emailHmac: string | null;
  userId: number | null;
  source: string;
  locale: string | null;
  status: string;
  confirmHash: string | null;
  confirmExpiresAt: Date | null;
  manageSalt: string;
  manageHash: string;
  unsubscribeHash: string;
  endedUserId: number | null;
  lastConfirmMailAt: Date | null;
  lastAlreadyMailAt: Date | null;
  createdAt: Date;
  confirmedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  updatedAt: Date;
};

const SUBSCRIPTION_COLUMNS = `id, email, "emailHmac", "userId", source::text as source, locale,
  status::text as status, "confirmHash", "confirmExpiresAt", "manageSalt", "manageHash",
  "unsubscribeHash", "endedUserId", "lastConfirmMailAt", "lastAlreadyMailAt", "createdAt",
  "confirmedAt", "endedAt", "endReason"::text as "endReason", "updatedAt"`;

// the subscriptions of an address, oldest first (read as root, who sees every row)
export async function subscriptionsOf(db: Session, email: string): Promise<SubscriptionRow[]> {
  return callAs<SubscriptionRow>(
    db,
    READER,
    `select ${SUBSCRIPTION_COLUMNS} from cartlify.newsletter_subscriptions
     where email = $1 order by id`,
    email,
  );
}

export async function subscriptionById(db: Session, id: number): Promise<SubscriptionRow | null> {
  const [row] = await callAs<SubscriptionRow>(
    db,
    READER,
    `select ${SUBSCRIPTION_COLUMNS} from cartlify.newsletter_subscriptions where id = $1`,
    id,
  );
  return row ?? null;
}

export type EventRow = {
  id: number;
  subscriptionId: number;
  event: string;
  place: string;
  ip: string | null;
  userAgent: string | null;
  locale: string | null;
  campaignId: number | null;
  privacyVersion: number | null;
  actorId: number | null;
};

// the journal of a subscription, oldest line first
export async function journalOf(db: Session, subscriptionId: number): Promise<EventRow[]> {
  return callAs<EventRow>(
    db,
    READER,
    `select id, "subscriptionId", event::text as event, place::text as place, ip, "userAgent",
            locale, "campaignId", "privacyVersion", "actorId"
     from cartlify.newsletter_subscription_events
     where "subscriptionId" = $1 order by id`,
    subscriptionId,
  );
}

// the journal of every subscription of an address, oldest line first
export async function journalOfAddress(db: Session, email: string): Promise<EventRow[]> {
  return callAs<EventRow>(
    db,
    READER,
    `select e.id, e."subscriptionId", e.event::text as event, e.place::text as place, e.ip,
            e."userAgent", e.locale, e."campaignId", e."privacyVersion", e."actorId"
     from cartlify.newsletter_subscription_events e
     join cartlify.newsletter_subscriptions s on s.id = e."subscriptionId"
     where s.email = $1 order by e.id`,
    email,
  );
}

// the clock of the database in the transaction (the one the functions stamp their rows with)
export async function dbNow(db: Pick<Session, 'rows'>): Promise<Date> {
  const [row] = await db.rows<{ now: Date }>(`select now() at time zone 'utc' as now`);
  return row!.now;
}

// two moments of the database within a few milliseconds (a column keeps three decimals)
export const near = (a: Date | null, b: Date, ms = 5): boolean =>
  a !== null && Math.abs(a.getTime() - b.getTime()) <= ms;

// a version of the privacy policy published by root inside the transaction; its number
export async function publishPrivacy(db: Session, rootId: number): Promise<number> {
  await db.as({ role: 'ROOT', userId: rootId });
  const [row] = await db.rows<{ version: number }>(
    `insert into cartlify.legal_documents
       (kind, title, content, "publishedById", "retentionLoginAddressesDays", "retentionGuestDataDays",
        "retentionDeletedChatsDays", "retentionReturnAddressesDays", "retentionReturnPersonalDays",
        "retentionRecipientDays", "retentionNewsletterConsentDays", "retentionNewsletterRecipientsDays")
     values ('privacy', 'The policy', 'The text.', $1, 1, 1, 1, 1, 1, 1, 1, 1) returning version`,
    rootId,
  );
  return row!.version;
}

// a version of the privacy policy with the terms of the newsletters given (days); the terms of the
// rest are long, so no other cleanup is ever due for what a test makes. Root publishes it. The
// moment the database dated the version is given back, as text
export async function publishPolicyWith(
  db: Pick<Session, 'as' | 'rows'>,
  rootId: number,
  terms: { consent?: number; recipients?: number } = {},
): Promise<{ version: number; createdAt: string }> {
  await db.as({ role: 'ROOT', userId: rootId });
  const [row] = await db.rows<{ version: number; createdAt: string }>(
    `insert into cartlify.legal_documents
       (kind, title, content, "publishedById", "retentionLoginAddressesDays", "retentionGuestDataDays",
        "retentionDeletedChatsDays", "retentionReturnAddressesDays", "retentionReturnPersonalDays",
        "retentionRecipientDays", "retentionNewsletterConsentDays", "retentionNewsletterRecipientsDays")
     values ('privacy', 'The policy', 'The text.', $1, 3650, 3650, 3650, 3650, 3650, 3650, $2, $3)
     returning version, "createdAt"::text as "createdAt"`,
    rootId,
    terms.consent ?? 3650,
    terms.recipients ?? 3650,
  );
  return row!;
}
