import { shopSettings } from '@config/shopSettings.js';
import { deliveryPriceOf } from '@helpers/deliveryPrice.js';
import { shopCurrency } from '@routes/api/payments/providers/index.js';

import type { GetDeliveryMethodsResponseDto } from 'types/dto/delivery.dto.js';

// the methods of the shop as they are set now: the settings are read on each call
export async function getDeliveryMethods(): Promise<GetDeliveryMethodsResponseDto> {
  const settings = shopSettings();

  return {
    currency: shopCurrency(),
    methods: settings.deliveryMethods.map((method) =>
      method === 'manual'
        ? {
            method,
            price: deliveryPriceOf('manual', 0),
            freeFrom: settings.deliveryFlatPrice === null ? null : settings.deliveryFreeFrom,
            countries: [...settings.deliveryCountries],
            address: null,
            hours: null,
          }
        : {
            method,
            price: 0,
            freeFrom: null,
            countries: [],
            address: settings.pickupAddress,
            hours: settings.pickupHours,
          },
    ),
  };
}
