import { escapeHtml } from '@helpers/escapeHtml.js';

export type VerifyEmailTemplateArgs = {
  verifyUrl: string;
  userName?: string;
  appName?: string;
  logoCid?: string;
  expiresInText?: string;
};

export function buildVerifyEmailTemplate(args: VerifyEmailTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const verifyUrl = args.verifyUrl?.trim() || '';
  const userName = args.userName?.trim() || '';
  const logoCid = args.logoCid?.trim() || '';
  const expiresInText = args.expiresInText?.trim() || '';

  if (!verifyUrl) throw new Error('VERIFY_URL_REQUIRED');

  const safeApp = escapeHtml(appName);
  const safeName = escapeHtml(userName);
  const safeUrl = escapeHtml(verifyUrl);

  const subject = `${appName} — Verify your email`;

  const ttlLine = expiresInText ? `This link is valid for ${expiresInText}.\n\n` : '';

  const text =
    `Verify your email for ${appName}.\n\n` +
    ttlLine +
    `Open this link:\n${verifyUrl}\n\n` +
    `If you did not request this, ignore this email.\n` +
    `Do not reply to this email.`;

  const preheader = `Confirm your email for ${appName}.`;
  const greeting = safeName ? `Hi ${safeName},` : `Hi,`;

  const logoHtml = logoCid
    ? `<img src="cid:${escapeHtml(logoCid)}" alt="${safeApp}" width="160" style="display:block;max-width:160px;height:auto;border:0;outline:none;text-decoration:none;">`
    : `<div style="font-size:18px;font-weight:800;letter-spacing:0.2px;color:#4c1d95;">${safeApp}</div>`;

  // purple palette (no pink)
  const bg = '#f5f3ff';
  const cardBorder = '#ddd6fe';
  const title = '#2e1065';
  const textColor = '#111827';
  const muted = '#6b7280';
  const btn = '#6d28d9';
  const link = '#6d28d9';

  const ttlHtml = expiresInText
    ? `<div style="font-size:12px;color:${muted};line-height:1.5;margin:0 0 10px 0;">
         This link is valid for <b>${escapeHtml(expiresInText)}</b>.
       </div>`
    : '';

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <title>${safeApp} — Verify email</title>
  </head>
  <body style="margin:0;padding:0;background:${bg};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px;">
      ${escapeHtml(preheader)}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${bg};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:600px;width:100%;">
            <tr>
              <td style="padding:0 0 12px 0;text-align:left;font-family:Arial,Helvetica,sans-serif;">
                ${logoHtml}
              </td>
            </tr>

            <tr>
              <td style="background:#ffffff;border:1px solid ${cardBorder};border-radius:14px;padding:28px;font-family:Arial,Helvetica,sans-serif;">
                <div style="font-size:18px;font-weight:800;color:${title};margin:0 0 10px 0;">Verify your email</div>

                <div style="font-size:14px;color:${textColor};line-height:1.5;margin:0 0 10px 0;">
                  ${greeting}<br>
                  Please confirm your email address to finish setting up your account.
                </div>

                ${ttlHtml}

                <div style="padding:12px 0 18px 0;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                    <tr>
                      <td bgcolor="${btn}" style="border-radius:10px;">
                        <a href="${safeUrl}"
                           style="display:inline-block;padding:12px 18px;font-size:14px;font-weight:800;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;">
                          Verify email
                        </a>
                      </td>
                    </tr>
                  </table>
                </div>

                <div style="font-size:12px;color:${muted};line-height:1.5;margin:0;">
                  If the button does not work, open this link:
                </div>

                <div style="font-size:12px;line-height:1.5;margin:6px 0 0 0;word-break:break-all;">
                  <a href="${safeUrl}" style="color:${link};text-decoration:underline;">${safeUrl}</a>
                </div>

                <hr style="border:none;border-top:1px solid ${cardBorder};margin:18px 0;">

                <div style="font-size:12px;color:${muted};line-height:1.5;margin:0;">
                  If you did not request this, ignore this email.<br>
                  This mailbox is not monitored. Do not reply to this email.
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:14px 6px 0 6px;font-family:Arial,Helvetica,sans-serif;color:#9ca3af;font-size:12px;line-height:1.4;">
                © ${new Date().getFullYear()} ${safeApp}
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}
