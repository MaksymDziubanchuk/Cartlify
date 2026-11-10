import { FastifyInstance, FastifyRequest } from 'fastify';

import authGuard from '@middlewares/auth.js';
import requireNewsletterManager from '@middlewares/requireNewsletterManager.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';

import { strictValidatorCompiler } from '@helpers/strictValidator.js';
import { newslettersCampaignDtoSchemas } from '@schemas/dto/newslettersCampaign.dtoSchemas.js';

import { requestLimits } from '../../../plugins/requestLimits.js';
import { newslettersAdminSchema } from './newsletters.admin.schemas.js';
import { newslettersCampaignsRouteSchema } from './newsletters.campaigns.schemas.js';
import { newslettersController } from './newsletters.controllers.js';
import { newslettersSchema } from './newsletters.schemas.js';
import sendGridWebhookRouter from './newsletters.webhook.routes.js';

// Two requests have a body that may be left out altogether: a mail client posts the form of RFC 8058
// and some post nothing, and a signed-in user subscribes their own address with every field optional.
// An absent body would fail the schema of an object, so it is read as an empty one
function defaultEmptyBody(req: FastifyRequest, _reply: unknown, done: () => void) {
  if (req.body === undefined) req.body = {};
  done();
}

// The newsletters of the shop: the subscription (the form of the public page, the pages behind the
// links of the mails (confirm, "this is not me", manage), the one-click unsubscribe of a mail client
// and the profile of a signed-in user) and the routes of the people who run them, root and an admin
// whom root allowed (the subscribers, the blocklist of the form and the campaigns)
// The people who run the newsletters. The guards in this order: a session, the role, then the right
// itself, which the server reads from the database at every request (a right root took away stops
// at once, in a session that is open too). No limit of its own: they are few and signed in, the
// limit of every route holds
const manager = [authGuard, requireRole(['ADMIN', 'ROOT']), requireNewsletterManager];

// the bodies of the campaigns are documents that are stored as they are: a type is not turned into
// another and a field the schema does not name is refused, not dropped
const strictBody = strictValidatorCompiler(newslettersCampaignDtoSchemas);

export default async function newslettersRouter(app: FastifyInstance) {
  // a guest or a signed-in user. The captcha is checked inside the route, only for a request about
  // an address the person has not proved to be theirs (a signed-in user for their own needs none)
  app.post(
    '/subscriptions',
    {
      preValidation: defaultEmptyBody,
      preHandler: [authGuard, ...requestLimits.newsletterRequest],
      schema: newslettersSchema.postSubscriptionSchema,
    },
    newslettersController.postSubscription,
  );

  // the buttons of the mail of a confirmation; the token of the mail is the proof, no session
  app.post(
    '/subscriptions/confirm',
    {
      preHandler: [...requestLimits.newsletterLink],
      schema: newslettersSchema.postConfirmSchema,
    },
    newslettersController.postConfirm,
  );
  app.post(
    '/subscriptions/decline',
    {
      preHandler: [...requestLimits.newsletterLink],
      schema: newslettersSchema.postDeclineSchema,
    },
    newslettersController.postDecline,
  );

  // the page "Manage the subscription": the token of the link is in the body of every request, so
  // no log of an address holds it
  app.post(
    '/manage',
    {
      preHandler: [...requestLimits.newsletterLink],
      schema: newslettersSchema.postManageSchema,
    },
    newslettersController.postManage,
  );
  app.post(
    '/manage/locale',
    {
      preHandler: [...requestLimits.newsletterLink],
      schema: newslettersSchema.postManageLocaleSchema,
    },
    newslettersController.postManageLocale,
  );
  app.post(
    '/manage/unsubscribe',
    {
      preHandler: [...requestLimits.newsletterLink],
      schema: newslettersSchema.postManageUnsubscribeSchema,
    },
    newslettersController.postManageUnsubscribe,
  );
  app.post(
    '/manage/resume',
    {
      preHandler: [...requestLimits.newsletterLink],
      schema: newslettersSchema.postManageResumeSchema,
    },
    newslettersController.postManageResume,
  );
  app.post(
    '/manage/export',
    {
      preHandler: [...requestLimits.newsletterLink],
      schema: newslettersSchema.postManageExportSchema,
    },
    newslettersController.postManageExport,
  );

  // the one-click unsubscribe of a mail client (RFC 8058): the client posts to the address of the
  // List-Unsubscribe header by itself, with no cookie and no csrf token, so the route is outside
  // the csrf check, as the webhooks of the payment providers are. The token is in the path (the
  // standard asks for it); maskUrlSecrets hides it in every log
  app.post(
    '/unsubscribe/:token',
    {
      config: { csrf: false },
      preValidation: defaultEmptyBody,
      preHandler: [...requestLimits.newsletterUnsubscribe],
      schema: newslettersSchema.postOneClickSchema,
    },
    newslettersController.postOneClickUnsubscribe,
  );

  // the same address opened with a GET, as a person (or a scanner) follows the link of the button: the
  // browser goes to the page of management, which asks the person and posts to the address above. It
  // changes nothing itself. The two share one count of requests
  app.get(
    '/unsubscribe/:token',
    {
      preHandler: [...requestLimits.newsletterUnsubscribe],
      schema: newslettersSchema.getOneClickPageSchema,
    },
    newslettersController.getOneClickPage,
  );

  // the Event Webhook of SendGrid: the bounces, drops and complaints of the mails (a plugin of its own,
  // for the raw body its signature needs)
  app.register(sendGridWebhookRouter);

  // the profile of a signed-in user, any role
  app.get(
    '/me',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
      schema: newslettersSchema.getProfileSchema,
    },
    newslettersController.getProfile,
  );
  app.patch(
    '/me',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
      schema: newslettersSchema.patchProfileSchema,
    },
    newslettersController.patchProfile,
  );
  app.delete(
    '/me',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
      schema: newslettersSchema.deleteProfileSchema,
    },
    newslettersController.deleteProfile,
  );
  app.post(
    '/me/resume',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
      schema: newslettersSchema.postProfileResumeSchema,
    },
    newslettersController.postProfileResume,
  );

  // the subscribers: the numbers, the list, and the erasure of one on the word of the person
  app.get(
    '/subscribers/summary',
    { preHandler: manager, schema: newslettersAdminSchema.getSubscribersSummarySchema },
    newslettersController.getSubscribersSummary,
  );
  app.get(
    '/subscribers',
    { preHandler: manager, schema: newslettersAdminSchema.getSubscribersSchema },
    newslettersController.getSubscribers,
  );
  app.delete(
    '/subscribers/:subscriberId',
    {
      preHandler: [...manager, validateId('subscriberId')],
      schema: newslettersAdminSchema.eraseSubscriberSchema,
    },
    newslettersController.eraseSubscriber,
  );

  // the blocklist of the public form: an admin finds an address by typing it and reads no list
  app.get(
    '/blocklist',
    { preHandler: manager, schema: newslettersAdminSchema.getBlocklistSchema },
    newslettersController.getBlocklist,
  );
  app.post(
    '/blocklist',
    { preHandler: manager, schema: newslettersAdminSchema.postBlocklistSchema },
    newslettersController.postBlocklist,
  );
  app.delete(
    '/blocklist/:blockId',
    {
      preHandler: [...manager, validateId('blockId')],
      schema: newslettersAdminSchema.deleteBlocklistSchema,
    },
    newslettersController.deleteBlocklist,
  );

  // the campaigns: a draft is made and written, the list and the campaign are read, the text is
  // changed while it is a draft or scheduled, a draft is deleted and any campaign is copied. All the
  // managers see all the campaigns. Scheduling, cancelling and stopping are routes of their own (below)
  app.post(
    '/campaigns',
    {
      preHandler: manager,
      validatorCompiler: strictBody,
      schema: newslettersCampaignsRouteSchema.postCampaignSchema,
    },
    newslettersController.postCampaign,
  );
  app.get(
    '/campaigns',
    { preHandler: manager, schema: newslettersCampaignsRouteSchema.getCampaignsSchema },
    newslettersController.getCampaigns,
  );
  app.get(
    '/campaigns/:campaignId',
    {
      preHandler: [...manager, validateId('campaignId')],
      schema: newslettersCampaignsRouteSchema.getCampaignSchema,
    },
    newslettersController.getCampaign,
  );
  app.patch(
    '/campaigns/:campaignId',
    {
      preHandler: [...manager, validateId('campaignId')],
      validatorCompiler: strictBody,
      schema: newslettersCampaignsRouteSchema.patchCampaignSchema,
    },
    newslettersController.patchCampaign,
  );
  app.delete(
    '/campaigns/:campaignId',
    {
      preHandler: [...manager, validateId('campaignId')],
      schema: newslettersCampaignsRouteSchema.deleteCampaignSchema,
    },
    newslettersController.deleteCampaign,
  );
  app.post(
    '/campaigns/:campaignId/copy',
    {
      preHandler: [...manager, validateId('campaignId')],
      schema: newslettersCampaignsRouteSchema.postCopyCampaignSchema,
    },
    newslettersController.postCopyCampaign,
  );

  // scheduling, calling off and stopping: the moves of the state of a campaign. Scheduling asks the
  // limit of the shop and takes a body (a time, or now), the other two take none
  app.post(
    '/campaigns/:campaignId/schedule',
    {
      preHandler: [...manager, validateId('campaignId')],
      validatorCompiler: strictBody,
      schema: newslettersCampaignsRouteSchema.postScheduleCampaignSchema,
    },
    newslettersController.postScheduleCampaign,
  );
  app.post(
    '/campaigns/:campaignId/cancel',
    {
      preHandler: [...manager, validateId('campaignId')],
      schema: newslettersCampaignsRouteSchema.postCancelCampaignSchema,
    },
    newslettersController.postCancelCampaign,
  );
  app.post(
    '/campaigns/:campaignId/stop',
    {
      preHandler: [...manager, validateId('campaignId')],
      schema: newslettersCampaignsRouteSchema.postStopCampaignSchema,
    },
    newslettersController.postStopCampaign,
  );

  // the mail of a campaign for the managers: the preview in a language, and the test mail to the
  // address of an admin or of root. Neither changes the campaign, in any state. The test mail is a real
  // mail, so the requests of a user are limited, counted after the guards and the id (only a manager
  // counts)
  app.post(
    '/campaigns/:campaignId/preview',
    {
      preHandler: [...manager, validateId('campaignId')],
      validatorCompiler: strictBody,
      schema: newslettersCampaignsRouteSchema.postPreviewCampaignSchema,
    },
    newslettersController.postPreviewCampaign,
  );
  app.post(
    '/campaigns/:campaignId/test',
    {
      preHandler: [...manager, validateId('campaignId'), ...requestLimits.newsletterTest],
      validatorCompiler: strictBody,
      schema: newslettersCampaignsRouteSchema.postTestCampaignSchema,
    },
    newslettersController.postTestCampaign,
  );

  // the texts of a campaign in other languages, as drafts: the model of openai writes them, nothing is
  // saved. The limit of the requests of a user comes after the guards, so only a manager counts
  app.post(
    '/translate',
    {
      preHandler: [...manager, ...requestLimits.newsletterTranslate],
      validatorCompiler: strictBody,
      schema: newslettersCampaignsRouteSchema.postTranslateSchema,
    },
    newslettersController.postTranslate,
  );
}
