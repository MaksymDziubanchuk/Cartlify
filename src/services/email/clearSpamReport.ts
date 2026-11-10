import env from '@config/env.js';
import { normalizeEmail } from '@helpers/newsletterTokens.js';
import { SENDGRID_TIMEOUT_MS } from '@services/email/sendGrid.js';

import type { FastifyBaseLogger } from 'fastify';

const SPAM_REPORTS_URL = 'https://api.sendgrid.com/v3/suppression/spam_reports';

// Takes an address off the list of "spam" complaints of the newsletter account of SendGrid, which
// the person asked for by restoring a paused subscription: while the address is on the list SendGrid
// drops every mail to it. Done with the key of the newsletters (the account that holds the list).
// True when the address is clear (removed, or it was not on the list); false when it could not be
// done. It never throws: a failed removal must not undo the restoring the person did, and the warning
// tells the maintainer. The warning holds the reason and the status only, never the key, the address
// or the request, which names the address.
export async function clearSpamReport(
  email: string,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<boolean> {
  const failed = (reason: string, extra: Record<string, unknown> = {}): false => {
    log.warn({ reason, ...extra }, 'spam report of the newsletter account was not cleared');
    return false;
  };

  const key = env.SENDGRID_NEWSLETTER_API_KEY;
  if (!key) return failed('NO_KEY');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SENDGRID_TIMEOUT_MS);

  try {
    // no redirect: the request holds the key, it goes to SendGrid and nowhere else
    const res = await fetch(`${SPAM_REPORTS_URL}/${encodeURIComponent(normalizeEmail(email))}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
      redirect: 'error',
    });

    // 404: the address is not on the list, which is what was asked for
    if (res.ok || res.status === 404) return true;

    return failed('REFUSED', { status: res.status });
  } catch {
    // the error of fetch may quote the address it called, and the logger must not see it
    return failed(controller.signal.aborted ? 'TIMEOUT' : 'REQUEST_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}
