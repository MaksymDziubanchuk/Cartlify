import type { FastifyBaseLogger } from 'fastify';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import {
  buildTwoFactorNoticeTemplate,
  type TwoFactorNoticeKind,
} from '@services/email/templates/auth/twoFactorNotice.template.js';

import { sendEmail } from './sendEmail.helper.js';

export type SendTwoFactorNoticeEmailArgs = {
  kind: TwoFactorNoticeKind;
  to: string;
  at: Date;
  recoveryCodesLeft?: number;
  userName?: string | null;
  locale?: string | null;
};

// tells the owner that the second step of the login was reset, or that a recovery code let a login
// in: a person who did not do it learns of it. The mail goes after the commit, and a failure of the
// mail is only logged, the login or the reset stands
export async function sendTwoFactorNoticeEmail(
  args: SendTwoFactorNoticeEmailArgs,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const { subject, text, html } = buildTwoFactorNoticeTemplate({
      kind: args.kind,
      loginUrl: webPageUrl(env.WEB_PAGE_LOGIN),
      at: args.at,
      ...(args.recoveryCodesLeft !== undefined
        ? { recoveryCodesLeft: args.recoveryCodesLeft }
        : {}),
      userName: args.userName || '',
      appName: shopSettings().shopName,
      logoUrl: shopSettings().logoUrl,
      ...(args.locale ? { locale: args.locale } : {}),
    });

    await sendEmail({ to: args.to, subject, text, html });
  } catch (err) {
    log.error({ err, kind: args.kind }, 'two factor notice mail failed');
  }
}
