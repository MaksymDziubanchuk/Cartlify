import type { DeliveryMethodName } from '@config/deliveryMethods.js';

// one way the shop gets an order to its buyer
export interface DeliveryMethodInfoDto {
  method: DeliveryMethodName;
  // what a buyer pays, 0 for a pickup and for a shop that names no price
  price: number;
  // from this sum of the items on the delivery is free, empty when the shop names none
  freeFrom: number | null;
  // the countries it goes to, none for a pickup
  countries: string[];
  // where and when a buyer collects an order, the pickup only
  address: string | null;
  hours: string | null;
}

export interface GetDeliveryMethodsResponseDto {
  currency: string;
  methods: DeliveryMethodInfoDto[];
}
