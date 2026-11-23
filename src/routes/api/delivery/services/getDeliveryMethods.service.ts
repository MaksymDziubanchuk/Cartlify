import { shopSettings } from '@config/shopSettings.js';
import { shopCurrency } from '@providers/payments/index.js';

import type { GetDeliveryMethodsResponseDto } from 'types/dto/delivery.dto.js';

// the methods of the shop and the zones it delivers to, as they are set now: the settings are read
// on each call. The price of a carrier comes with the carriers for an address
// (POST /api/orders/current/delivery-options)
export async function getDeliveryMethods(): Promise<GetDeliveryMethodsResponseDto> {
  const settings = shopSettings();
  const zones = settings.deliveryZones;

  return {
    currency: shopCurrency(),
    methods: settings.deliveryMethods.map((method) => ({
      method,
      address: method === 'pickup' ? settings.pickupAddress : null,
      hours: method === 'pickup' ? settings.pickupHours : null,
    })),
    zones: zones.map((zone) => ({
      name: zone.name,
      countries: [...zone.countries],
      manualPrice: zone.manualPrice,
      freeFrom: zone.freeFrom,
    })),
  };
}
