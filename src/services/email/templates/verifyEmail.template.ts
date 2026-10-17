import { renderTemplate } from '@services/email/renderTemplate.js';

export type VerifyEmailTemplateArgs = {
  verifyUrl: string;
  userName?: string;
  appName?: string;
  logoCid?: string;
  expiresInText?: string;
};

// the mail itself is verifyEmail.html and verifyEmail.txt next to this file
export function buildVerifyEmailTemplate(args: VerifyEmailTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const verifyUrl = args.verifyUrl?.trim() || '';

  if (!verifyUrl) throw new Error('VERIFY_URL_REQUIRED');

  const values = {
    appName,
    verifyUrl,
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    expiresInText: args.expiresInText?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Verify your email`,
    text: renderTemplate('verifyEmail.txt', values),
    html: renderTemplate('verifyEmail.html', values),
  };
}
