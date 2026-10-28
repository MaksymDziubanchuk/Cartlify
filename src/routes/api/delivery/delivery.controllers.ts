import type { ControllerRouter } from 'types/controller.js';
import type { GetDeliveryMethodsResponseDto } from 'types/dto/delivery.dto.js';

import { deliveryServices } from './delivery.services.js';

const getMethods: ControllerRouter<{}, {}, {}, GetDeliveryMethodsResponseDto> = async (
  _req,
  reply,
) => reply.code(200).send(await deliveryServices.getDeliveryMethods());

export const deliveryController = {
  getMethods,
};
