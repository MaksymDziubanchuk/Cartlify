import type { FastifyRequest } from 'fastify';

import {
  SENDGRID_SIGNATURE_HEADER,
  SENDGRID_TIMESTAMP_HEADER,
} from '@helpers/sendGridSignature.js';
import { BadRequestError } from '@utils/errors.js';

import type { ControllerRouter } from 'types/controller.js';
import type { User } from 'types/user.js';
import type {
  AddBlockDto,
  BlockParamsDto,
  BlocklistBodyDto,
  BlocklistQueryDto,
  CampaignLocaleBodyDto,
  CampaignParamsDto,
  CampaignTestBodyDto,
  CampaignsQueryDto,
  ConfirmSubscriptionResponseDto,
  CreateCampaignBodyDto,
  CreateCampaignDto,
  DeclineSubscriptionResponseDto,
  FindCampaignsDto,
  FindSubscribersDto,
  ManageLocaleBodyDto,
  NewsletterBlockAddedResponseDto,
  NewsletterBlockLookupResponseDto,
  NewsletterBlockRemovedResponseDto,
  NewsletterCampaignDeletedResponseDto,
  NewsletterCampaignDto,
  NewsletterCampaignsResponseDto,
  NewsletterExportResponseDto,
  NewsletterManageStateDto,
  NewsletterPreviewResponseDto,
  NewsletterProfileResponseDto,
  NewsletterRequestInfoDto,
  NewsletterSubscriberErasedResponseDto,
  NewsletterSubscribersResponseDto,
  NewsletterSubscribersSummaryDto,
  NewsletterSubscriptionDto,
  NewsletterTestSentResponseDto,
  NewsletterTokenBodyDto,
  NewsletterTranslateBodyDto,
  NewsletterTranslateResponseDto,
  NewsletterUnsubscribedResponseDto,
  SendGridWebhookResponseDto,
  OneClickParamsDto,
  OneClickQueryDto,
  ProfileLocaleBodyDto,
  ScheduleCampaignBodyDto,
  ScheduleCampaignDto,
  SubscribeAcceptedResponseDto,
  SubscribeBodyDto,
  SubscriberParamsDto,
  SubscribersQueryDto,
  UpdateCampaignBodyDto,
  UpdateCampaignDto,
} from 'types/dto/newsletters.dto.js';
import { newsletterUnsubscribePageUrl } from '@helpers/newsletterLinks.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { requestContextOf } from '@helpers/requestContext.js';

import { requestLimits } from '../../../plugins/requestLimits.js';

import { SUBSCRIPTION_REQUEST_ACCEPTED } from './newsletters.messages.js';
import { newslettersServices } from './newsletters.services.js';
import { campaignIdOf } from './services/oneClick.service.js';

// the address and the browser of the request, which the journal of a subscription keeps
const infoOf = (req: FastifyRequest): NewsletterRequestInfoDto => {
  const { ip, userAgent } = requestContextOf(req);
  return { ip, userAgent };
};

const postSubscription: ControllerRouter<
  {},
  SubscribeBodyDto,
  {},
  SubscribeAcceptedResponseDto | NewsletterSubscriptionDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const { email, locale, captchaToken } = req.body ?? {};

  const result = await newslettersServices.subscribe(
    pickDefined({ actorId, actorRole, ...infoOf(req) }, { email, locale, captchaToken }),
    req.log,
    // the requests about one email are counted after the captcha, only for an address a mail may go to
    { afterCaptcha: () => requestLimits.newsletterRequestEmail(req, reply) },
  );

  return result.kind === 'subscribed'
    ? reply.code(201).send(result.subscription)
    : reply.code(202).send({ message: SUBSCRIPTION_REQUEST_ACCEPTED });
};

const postConfirm: ControllerRouter<
  {},
  NewsletterTokenBodyDto,
  {},
  ConfirmSubscriptionResponseDto
> = async (req, reply) => {
  const result = await newslettersServices.confirmSubscription({
    token: req.body.token,
    ...infoOf(req),
  });

  return reply.code(200).send(result);
};

const postDecline: ControllerRouter<
  {},
  NewsletterTokenBodyDto,
  {},
  DeclineSubscriptionResponseDto
> = async (req, reply) => {
  const result = await newslettersServices.declineSubscription({
    token: req.body.token,
    ...infoOf(req),
  });

  return reply.code(200).send(result);
};

const postManage: ControllerRouter<
  {},
  NewsletterTokenBodyDto,
  {},
  NewsletterManageStateDto
> = async (req, reply) => {
  const result = await newslettersServices.getManagedSubscription({ token: req.body.token });

  return reply.code(200).send(result);
};

const postManageLocale: ControllerRouter<
  {},
  ManageLocaleBodyDto,
  {},
  NewsletterManageStateDto
> = async (req, reply) => {
  const result = await newslettersServices.setManagedLocale({
    token: req.body.token,
    locale: req.body.locale,
    ...infoOf(req),
  });

  return reply.code(200).send(result);
};

const postManageUnsubscribe: ControllerRouter<
  {},
  NewsletterTokenBodyDto,
  {},
  NewsletterUnsubscribedResponseDto
> = async (req, reply) => {
  const result = await newslettersServices.unsubscribeManaged({
    token: req.body.token,
    ...infoOf(req),
  });

  return reply.code(200).send(result);
};

const postManageResume: ControllerRouter<
  {},
  NewsletterTokenBodyDto,
  {},
  NewsletterManageStateDto
> = async (req, reply) => {
  const result = await newslettersServices.resumeManaged(
    { token: req.body.token, ...infoOf(req) },
    req.log,
  );

  return reply.code(200).send(result);
};

const postManageExport: ControllerRouter<
  {},
  NewsletterTokenBodyDto,
  {},
  NewsletterExportResponseDto
> = async (req, reply) => {
  const result = await newslettersServices.exportManaged({ token: req.body.token });

  return reply.code(200).send(result);
};

const postOneClickUnsubscribe: ControllerRouter<
  OneClickParamsDto,
  unknown,
  OneClickQueryDto,
  NewsletterUnsubscribedResponseDto
> = async (req, reply) => {
  const result = await newslettersServices.oneClickUnsubscribe(
    pickDefined({ token: req.params.token, ...infoOf(req) }, { campaign: req.query?.c }),
  );

  return reply.code(200).send(result);
};

// The unsubscribe button of a mail opened with a GET (the person follows the link, or a scanner does):
// the browser goes to the page "Manage the subscription" with the token after the # and, when the
// address names a campaign the id of one, which the page posts back to this same address. It looks
// nothing up and changes nothing, so every token gets the same answer and a scanner unsubscribes
// nobody; the page asks the person, and its button is the POST above
const getOneClickPage: ControllerRouter<OneClickParamsDto, {}, OneClickQueryDto, void> = async (
  req,
  reply,
) => {
  const campaign = campaignIdOf(req.query?.c);

  // 303 (see other): whatever the method of the request, the page is read with a GET
  reply
    .header('cache-control', 'no-store')
    .code(303)
    .redirect(newsletterUnsubscribePageUrl(req.params.token, campaign ?? undefined));
};

const getProfile: ControllerRouter<{}, {}, {}, NewsletterProfileResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.getProfileSubscription({ actorId, actorRole });

  return reply.code(200).send(result);
};

const patchProfile: ControllerRouter<
  {},
  ProfileLocaleBodyDto,
  {},
  NewsletterSubscriptionDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.setProfileLocale({
    actorId,
    actorRole,
    locale: req.body.locale,
    ...infoOf(req),
  });

  return reply.code(200).send(result);
};

const deleteProfile: ControllerRouter<{}, {}, {}, NewsletterUnsubscribedResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.unsubscribeProfile({
    actorId,
    actorRole,
    ...infoOf(req),
  });

  return reply.code(200).send(result);
};

const postProfileResume: ControllerRouter<{}, {}, {}, NewsletterSubscriptionDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.resumeProfile(
    { actorId, actorRole, ...infoOf(req) },
    req.log,
  );

  return reply.code(200).send(result);
};

// ---- the people who run the newsletters: the subscribers and the blocklist ----
// The routes have the guards (the role and the right to run the newsletters); the services run for
// the actor, so the policies of the database see the right again

const getSubscribersSummary: ControllerRouter<{}, {}, {}, NewsletterSubscribersSummaryDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.getSubscribersSummary({ actorId, actorRole });

  return reply.code(200).send(result);
};

const getSubscribers: ControllerRouter<
  {},
  {},
  SubscribersQueryDto,
  NewsletterSubscribersResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const { limit, cursor, status, source, locale, email } = req.query;

  const result = await newslettersServices.findSubscribers(
    pickDefined<FindSubscribersDto>(
      { actorId, actorRole },
      { limit, cursor, status, source, locale, email },
    ),
  );

  return reply.code(200).send(result);
};

const eraseSubscriber: ControllerRouter<
  SubscriberParamsDto,
  {},
  {},
  NewsletterSubscriberErasedResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.eraseSubscriber({
    actorId,
    actorRole,
    subscriberId: Number(req.params.subscriberId),
  });

  return reply.code(200).send(result);
};

const getBlocklist: ControllerRouter<
  {},
  {},
  BlocklistQueryDto,
  NewsletterBlockLookupResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.findBlocked({
    actorId,
    actorRole,
    email: req.query.email,
  });

  return reply.code(200).send(result);
};

// 201 for an entry made now, 200 for an address that was blocked already
const postBlocklist: ControllerRouter<
  {},
  BlocklistBodyDto,
  {},
  NewsletterBlockAddedResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const { email, reason } = req.body;

  const result = await newslettersServices.addBlock(
    pickDefined<AddBlockDto>({ actorId, actorRole, email }, { reason }),
  );

  return reply.code(result.created ? 201 : 200).send(result);
};

const deleteBlocklist: ControllerRouter<
  BlockParamsDto,
  {},
  {},
  NewsletterBlockRemovedResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.removeBlock({
    actorId,
    actorRole,
    blockId: Number(req.params.blockId),
  });

  return reply.code(200).send(result);
};

// ---- the campaigns ----

const postCampaign: ControllerRouter<{}, CreateCampaignBodyDto, {}, NewsletterCampaignDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const { name, missingLocale, content } = req.body;

  const result = await newslettersServices.createCampaign(
    pickDefined<CreateCampaignDto>({ actorId, actorRole, name }, { missingLocale, content }),
  );

  return reply.code(201).send(result);
};

const getCampaigns: ControllerRouter<
  {},
  {},
  CampaignsQueryDto,
  NewsletterCampaignsResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const {
    limit,
    cursor,
    status,
    startedFrom,
    startedTo,
    scheduledTo,
    cancelledFrom,
    cancelReason,
    undeliveredOver,
    rejectedOver,
    complaintsOver,
  } = req.query;

  const result = await newslettersServices.findCampaigns(
    pickDefined<FindCampaignsDto>(
      { actorId, actorRole },
      {
        limit,
        cursor,
        status,
        startedFrom,
        startedTo,
        scheduledTo,
        cancelledFrom,
        cancelReason,
        undeliveredOver,
        rejectedOver,
        complaintsOver,
      },
    ),
  );

  return reply.code(200).send(result);
};

const getCampaign: ControllerRouter<CampaignParamsDto, {}, {}, NewsletterCampaignDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.getCampaign({
    actorId,
    actorRole,
    campaignId: Number(req.params.campaignId),
  });

  return reply.code(200).send(result);
};

const patchCampaign: ControllerRouter<
  CampaignParamsDto,
  UpdateCampaignBodyDto,
  {},
  NewsletterCampaignDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const { name, missingLocale, content } = req.body;

  const result = await newslettersServices.updateCampaign(
    pickDefined<UpdateCampaignDto>(
      { actorId, actorRole, campaignId: Number(req.params.campaignId) },
      { name, missingLocale, content },
    ),
  );

  return reply.code(200).send(result);
};

const deleteCampaign: ControllerRouter<
  CampaignParamsDto,
  {},
  {},
  NewsletterCampaignDeletedResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.deleteCampaign({
    actorId,
    actorRole,
    campaignId: Number(req.params.campaignId),
  });

  return reply.code(200).send(result);
};

const postCopyCampaign: ControllerRouter<CampaignParamsDto, {}, {}, NewsletterCampaignDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.copyCampaign({
    actorId,
    actorRole,
    campaignId: Number(req.params.campaignId),
  });

  return reply.code(201).send(result);
};

const postScheduleCampaign: ControllerRouter<
  CampaignParamsDto,
  ScheduleCampaignBodyDto,
  {},
  NewsletterCampaignDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const { scheduledAt, runNow } = req.body;

  const result = await newslettersServices.scheduleCampaign(
    pickDefined<ScheduleCampaignDto>(
      { actorId, actorRole, campaignId: Number(req.params.campaignId) },
      { scheduledAt, runNow },
    ),
  );

  return reply.code(200).send(result);
};

const postCancelCampaign: ControllerRouter<
  CampaignParamsDto,
  {},
  {},
  NewsletterCampaignDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.cancelCampaign({
    actorId,
    actorRole,
    campaignId: Number(req.params.campaignId),
  });

  return reply.code(200).send(result);
};

const postStopCampaign: ControllerRouter<CampaignParamsDto, {}, {}, NewsletterCampaignDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.stopCampaign({
    actorId,
    actorRole,
    campaignId: Number(req.params.campaignId),
  });

  return reply.code(200).send(result);
};

const postPreviewCampaign: ControllerRouter<
  CampaignParamsDto,
  CampaignLocaleBodyDto,
  {},
  NewsletterPreviewResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.previewCampaign({
    actorId,
    actorRole,
    campaignId: Number(req.params.campaignId),
    locale: req.body.locale,
  });

  return reply.code(200).send(result);
};

const postTestCampaign: ControllerRouter<
  CampaignParamsDto,
  CampaignTestBodyDto,
  {},
  NewsletterTestSentResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await newslettersServices.sendCampaignTest({
    actorId,
    actorRole,
    campaignId: Number(req.params.campaignId),
    email: req.body.email,
    locale: req.body.locale,
  });

  return reply.code(200).send(result);
};

const postTranslate: ControllerRouter<
  {},
  NewsletterTranslateBodyDto,
  {},
  NewsletterTranslateResponseDto
> = async (req, reply) => {
  const result = await newslettersServices.translateNewsletterTexts(req.body, req.log);

  return reply.code(200).send(result);
};

// The Event Webhook of SendGrid. The body of the route is its raw bytes (the parser of the route keeps
// them, newsletters.webhook.routes.ts): the signature is made over exactly those
const postSendGridWebhook: ControllerRouter<{}, {}, {}, SendGridWebhookResponseDto> = async (
  req,
  reply,
) => {
  const signature = req.headers[SENDGRID_SIGNATURE_HEADER];
  const timestamp = req.headers[SENDGRID_TIMESTAMP_HEADER];

  if (
    typeof signature !== 'string' ||
    !signature.trim() ||
    typeof timestamp !== 'string' ||
    !timestamp.trim()
  ) {
    throw new BadRequestError('SENDGRID_SIGNATURE_REQUIRED');
  }

  // a request with no body at all has no bytes: the signature then covers the timestamp alone
  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);

  const result = await newslettersServices.handleSendGridWebhook(
    { signature, timestamp, rawBody },
    req.log,
  );

  return reply.code(200).send(result);
};

export const newslettersController = {
  postSubscription,
  postConfirm,
  postDecline,
  postManage,
  postManageLocale,
  postManageUnsubscribe,
  postManageResume,
  postManageExport,
  postOneClickUnsubscribe,
  getOneClickPage,
  postSendGridWebhook,
  getProfile,
  patchProfile,
  deleteProfile,
  postProfileResume,
  getSubscribersSummary,
  getSubscribers,
  eraseSubscriber,
  getBlocklist,
  postBlocklist,
  deleteBlocklist,
  postCampaign,
  getCampaigns,
  getCampaign,
  patchCampaign,
  deleteCampaign,
  postCopyCampaign,
  postScheduleCampaign,
  postCancelCampaign,
  postStopCampaign,
  postPreviewCampaign,
  postTestCampaign,
  postTranslate,
};
