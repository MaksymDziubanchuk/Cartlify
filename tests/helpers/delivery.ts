import env from '@config/env.js';

// the settings of the delivery a test changes for itself and puts back: the app reads them on each
// request, so a test needs no new app for them
type DeliverySettings = Partial<
  Pick<
    typeof env,
    | 'DELIVERY_METHODS'
    | 'DELIVERY_FLAT_PRICE'
    | 'DELIVERY_FREE_FROM'
    | 'DELIVERY_COUNTRIES'
    | 'PICKUP_ADDRESS'
    | 'PICKUP_HOURS'
  >
>;

const original: Required<DeliverySettings> = {
  DELIVERY_METHODS: [...env.DELIVERY_METHODS],
  DELIVERY_FLAT_PRICE: env.DELIVERY_FLAT_PRICE,
  DELIVERY_FREE_FROM: env.DELIVERY_FREE_FROM,
  DELIVERY_COUNTRIES: [...env.DELIVERY_COUNTRIES],
  PICKUP_ADDRESS: env.PICKUP_ADDRESS,
  PICKUP_HOURS: env.PICKUP_HOURS,
};

export const setDelivery = (values: DeliverySettings): void => {
  Object.assign(env, values);
};

// call it in afterEach
export const resetDelivery = (): void => {
  Object.assign(env, {
    ...original,
    DELIVERY_METHODS: [...original.DELIVERY_METHODS],
    DELIVERY_COUNTRIES: [...original.DELIVERY_COUNTRIES],
  });
};
