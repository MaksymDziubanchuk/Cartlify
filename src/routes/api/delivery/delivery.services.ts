import { handleDeliveryWebhook } from './services/deliveryEvents.service.js';
import { getDeliveryMethods } from './services/getDeliveryMethods.service.js';

export const deliveryServices = {
  getDeliveryMethods,
  handleDeliveryWebhook,
};
