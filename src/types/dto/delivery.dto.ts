import type { DeliveryMethodName } from '@config/deliveryMethods.js';

// one way the shop gets an order to its buyer
export interface DeliveryMethodInfoDto {
  method: DeliveryMethodName;
  // where and when a buyer collects an order, the pickup only
  address: string | null;
  hours: string | null;
}

// a zone the shop delivers to: its countries, what the manual delivery there costs (null: the
// manual delivery does not go there) and the sum of the items from which every delivery there is
// free
export interface DeliveryZoneInfoDto {
  name: string;
  countries: string[];
  manualPrice: number | null;
  freeFrom: number | null;
}

export interface GetDeliveryMethodsResponseDto {
  currency: string;
  methods: DeliveryMethodInfoDto[];
  zones: DeliveryZoneInfoDto[];
}
