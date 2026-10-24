import { renderTemplate } from '@services/email/renderTemplate.js';

export type PasswordChangedTemplateArgs = {
  loginUrl: string;
  changedAt: Date;
  userName?: string;
  appName?: string;
  logoCid?: string;
};

// "2026-10-23 09:05 UTC"
const utcMinute = (date: Date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// the mail itself is passwordChanged.html and passwordChanged.txt next to this file
export function buildPasswordChangedTemplate(args: PasswordChangedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const loginUrl = args.loginUrl?.trim() || '';

  if (!loginUrl) throw new Error('LOGIN_URL_REQUIRED');

  const values = {
    appName,
    loginUrl,
    changedAt: utcMinute(args.changedAt),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Your password was changed`,
    text: renderTemplate('auth/passwordChanged.txt', values),
    html: renderTemplate('auth/passwordChanged.html', values),
  };
}
