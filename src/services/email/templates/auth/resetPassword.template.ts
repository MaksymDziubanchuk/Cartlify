import { renderTemplate } from '@services/email/renderTemplate.js';

export type ResetPasswordTemplateArgs = {
  resetUrl: string;
  userName?: string;
  appName?: string;
  logoCid?: string;
  expiresInText?: string;
};

// the mail itself is resetPassword.html and resetPassword.txt next to this file
export function buildResetPasswordTemplate(args: ResetPasswordTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const resetUrl = args.resetUrl?.trim() || '';

  if (!resetUrl) throw new Error('RESET_URL_REQUIRED');

  const values = {
    appName,
    resetUrl,
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    expiresInText: args.expiresInText?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Reset your password`,
    text: renderTemplate('auth/resetPassword.txt', values),
    html: renderTemplate('auth/resetPassword.html', values),
  };
}
