import { shopSettings } from '@config/shopSettings.js';
import { writeNewsletterAuditLog } from '@db/adminAudit.helper.js';
import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { enabledLocaleOf } from '@helpers/locale.js';
import { shopHomeUrl } from '@helpers/newsletterLinks.js';
import { normalizeEmail } from '@helpers/newsletterTokens.js';
import { isEmailProviderFailure } from '@services/email/sendGrid.js';
import { sendNewsletterEmail } from '@services/email/sendNewsletterEmail.js';
import { renderCampaignMail } from '@services/email/templates/newsletters/campaign.template.js';
import { AppError, BadRequestError, ForbiddenError } from '@utils/errors.js';
import type {
  CampaignPreviewDto,
  CampaignTestDto,
  NewsletterContentDto,
  NewsletterPreviewResponseDto,
  NewsletterTestSentResponseDto,
} from 'types/dto/newsletters.dto.js';

import { campaignOrNotFound } from './campaigns.service.js';
import { newsletterMailFor } from './helpers/newsletterMail.helper.js';
import { withNewsletterErrors } from './helpers/newsletterErrors.helper.js';
import { resolveCampaignProducts } from './helpers/campaignProducts.helper.js';

// The mail of a campaign for the people who run the newsletters: the preview, which shows the mail in
// the language asked with the products taken now and the warnings of what is wrong, and the test mail,
// which sends that mail for real to the address of an admin or of root. Neither changes the campaign,
// whatever state it is in; the test mail has a line of its own in the admin log

// the content of the campaign and the language of the mail: the campaign must be there, the language
// one the shop answers in and one the campaign has a subject in (the refusals come in this order)
async function campaignAndLocale(
  dto: CampaignPreviewDto,
  asked: string,
): Promise<{ content: NewsletterContentDto; locale: string }> {
  const row = await withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      return campaignOrNotFound(db, dto.campaignId);
    }),
  );

  const locale = enabledLocaleOf(asked);
  if (!locale) throw new BadRequestError('LOCALE_INVALID');

  const content = row.content as unknown as NewsletterContentDto;
  if (!content.subject?.[locale]?.trim()) {
    throw new BadRequestError('NEWSLETTER_LOCALE_NOT_IN_CAMPAIGN');
  }

  return { content, locale };
}

// The mail as a reader of the language would get it now. The links of the subscription (manage, the
// unsubscribe of the mail program) lead to the home page of the shop: the preview is not a reader's
// mail and has no subscription to name. The logo is shown by its address, in a preview as in the mail
export async function previewCampaign(
  dto: CampaignPreviewDto,
): Promise<NewsletterPreviewResponseDto> {
  const { content, locale } = await campaignAndLocale(dto, dto.locale);
  const snapshot = await resolveCampaignProducts(content);
  const home = shopHomeUrl();

  const mail = renderCampaignMail({
    content,
    snapshot,
    locale,
    campaignId: dto.campaignId,
    manageUrl: home,
    unsubscribeUrl: home,
    logoUrl: shopSettings().logoUrl,
  });

  return {
    subject: mail.subject,
    preheader: mail.preheader,
    html: mail.html,
    text: mail.text,
    warnings: mail.warnings,
    takenAt: snapshot.takenAt,
  };
}

// the account an address belongs to when it is the address of an admin or of root that was not
// deleted; null for anything else, and the caller says the same to all of those
async function recipientAccount(
  dto: CampaignTestDto,
): Promise<{ id: number; email: string } | null> {
  const email = normalizeEmail(dto.email);

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      return db.user.findFirst({
        where: { email, role: { in: ['ADMIN', 'ROOT'] }, deletedAt: null },
        select: { id: true, email: true },
      });
    }),
  );
}

// The test mail: the mail of a reader of the language, with no mark of a test, to an address of an
// admin or of root. Its links of the subscription are dead ones (newsletterMailFor): no subscription
// is read or changed. The address is judged after the campaign and the language, so a request with a
// wrong address says nothing about who is an admin; every address that is not one gets the same refusal.
// The mail is sent before the line of the admin log is written: a mail that was not taken leaves no line.
// A refusal of the mail provider is a bad gateway with nothing of the provider in it
export async function sendCampaignTest(
  dto: CampaignTestDto,
): Promise<NewsletterTestSentResponseDto> {
  const { content, locale } = await campaignAndLocale(dto, dto.locale);

  const recipient = await recipientAccount(dto);
  if (!recipient) throw new ForbiddenError('NEWSLETTER_TEST_RECIPIENT_NOT_ALLOWED');

  const snapshot = await resolveCampaignProducts(content);
  const mail = newsletterMailFor({
    campaign: { id: dto.campaignId, content },
    snapshot,
    locale,
    test: true,
  });

  try {
    await sendNewsletterEmail({
      to: recipient.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: mail.headers,
    });
  } catch (err) {
    // only a failure of the provider is a bad gateway; our own error stays a server error. The cause
    // holds what the provider answered, and the address is personal data, so it is not kept
    if (!isEmailProviderFailure(err)) throw err;

    throw new AppError({
      statusCode: 502,
      errorCode: 'NEWSLETTER_TEST_SEND_FAILED',
      message: 'Bad Gateway',
      details: {
        reason: ((err as AppError).details as { reason?: unknown } | undefined)?.reason,
        status: ((err as AppError).cause as { status?: unknown } | undefined)?.status,
      },
    });
  }

  await withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      await writeNewsletterAuditLog(db, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        event: 'newsletter.campaign_test_sent',
        entityId: dto.campaignId,
        changes: [
          { field: 'recipientId', old: null, new: recipient.id },
          { field: 'locale', old: null, new: locale },
        ],
      });
    }),
  );

  return { sent: true };
}
