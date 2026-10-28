import env from '@config/env.js';
import { deliveryPriceOf } from '@helpers/deliveryPrice.js';
import { shopCurrency } from '@routes/api/payments/providers/index.js';

import type { GetDeliveryMethodsResponseDto } from 'types/dto/delivery.dto.js';

// the methods of the shop as they are set now: the settings are read on each call
export async function getDeliveryMethods(): Promise<GetDeliveryMethodsResponseDto> {
  return {
    currency: shopCurrency(),
    methods: env.DELIVERY_METHODS.map((method) =>
      method === 'manual'
        ? {
            method,
            price: deliveryPriceOf('manual', 0),
            freeFrom: env.DELIVERY_FLAT_PRICE === null ? null : env.DELIVERY_FREE_FROM,
            countries: [...env.DELIVERY_COUNTRIES],
            address: null,
            hours: null,
          }
        : {
            method,
            price: 0,
            freeFrom: null,
            countries: [],
            address: env.PICKUP_ADDRESS,
            hours: env.PICKUP_HOURS,
          },
    ),
  };
}
