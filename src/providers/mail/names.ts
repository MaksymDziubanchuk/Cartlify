// the mail providers this server can send with; MAIL_PROVIDER names the one it works with. Kept
// apart from the providers themselves (no client here), the settings and the tests read it
export const MAIL_PROVIDER_NAMES = ['sendgrid'] as const;

export type MailProviderName = (typeof MAIL_PROVIDER_NAMES)[number];
