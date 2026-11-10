import {
  copyCampaign,
  createCampaign,
  deleteCampaign,
  findCampaigns,
  getCampaign,
  updateCampaign,
} from './services/campaigns.service.js';
import { previewCampaign, sendCampaignTest } from './services/campaignMail.service.js';
import {
  cancelCampaign,
  scheduleCampaign,
  stopCampaign,
} from './services/campaignSchedule.service.js';
import { translateNewsletterTexts } from './services/translate.service.js';
import { subscribe } from './services/subscribe.service.js';
import { addBlock, findBlocked, removeBlock } from './services/blocklist.service.js';
import {
  eraseSubscriber,
  findSubscribers,
  getSubscribersSummary,
} from './services/subscribers.service.js';
import { confirmSubscription, declineSubscription } from './services/confirm.service.js';
import {
  exportManaged,
  getManagedSubscription,
  resumeManaged,
  setManagedLocale,
  unsubscribeManaged,
} from './services/manage.service.js';
import { oneClickUnsubscribe } from './services/oneClick.service.js';
import { handleSendGridWebhook } from './services/sendGridWebhook.service.js';
import {
  getProfileSubscription,
  resumeProfile,
  setProfileLocale,
  unsubscribeProfile,
} from './services/profile.service.js';

export const newslettersServices = {
  subscribe,
  confirmSubscription,
  declineSubscription,
  getManagedSubscription,
  setManagedLocale,
  unsubscribeManaged,
  resumeManaged,
  exportManaged,
  oneClickUnsubscribe,
  handleSendGridWebhook,
  getProfileSubscription,
  setProfileLocale,
  unsubscribeProfile,
  resumeProfile,
  getSubscribersSummary,
  findSubscribers,
  eraseSubscriber,
  findBlocked,
  addBlock,
  removeBlock,
  createCampaign,
  findCampaigns,
  getCampaign,
  updateCampaign,
  deleteCampaign,
  copyCampaign,
  scheduleCampaign,
  cancelCampaign,
  stopCampaign,
  previewCampaign,
  sendCampaignTest,
  translateNewsletterTexts,
};
