import type { ControllerRouter } from 'types/controller.js';
import type { GetDeliveryMethodsResponseDto } from 'types/dto/delivery.dto.js';

import { deliveryServices } from './delivery.services.js';

const getMethods: ControllerRouter<{}, {}, {}, GetDeliveryMethodsResponseDto> = async (
  _req,
  reply,
) => reply.code(200).send(await deliveryServices.getDeliveryMethods());

// an event of the parcels from the delivery provider
const postWebhook: ControllerRouter<{}, unknown, {}, Record<string, unknown>> = async (
  req,
  reply,
) =>
  reply
    .code(200)
    .send(
      await deliveryServices.handleDeliveryWebhook(
        { headers: req.headers, body: req.body },
        req.log,
      ),
    );

export const deliveryController = {
  getMethods,
  postWebhook,
};
