import env from '@config/env.js';
import { isAppError } from '@utils/errors.js';

import { pickProvider } from '../provider.js';

import { markDeliveryProviderDown, markDeliveryProviderUp } from './health.js';
import { DELIVERY_PROVIDER_NAMES } from './names.js';
import { shippyProProvider } from './shippypro/shippyPro.provider.js';
import {
  DELIVERY_PROVIDER_NOT_CONFIGURED,
  DELIVERY_PROVIDER_UNAVAILABLE,
  type DeliveryProvider,
} from './types.js';

export { readDeliveryProviderDown } from './health.js';
export * from './names.js';
export * from './types.js';

// every delivery provider this server has; DELIVERY_PROVIDER names the one it sends parcels with.
// The database keeps no provider: the method carrier is the delivery of the provider of the server
const providers: readonly DeliveryProvider[] = [shippyProProvider];

// the list the settings take the names from is the list of the providers themselves
if (
  providers.length !== DELIVERY_PROVIDER_NAMES.length ||
  providers.some((provider, i) => provider.name !== DELIVERY_PROVIDER_NAMES[i])
) {
  throw new Error('DELIVERY_PROVIDER_NAMES must name the delivery providers in the same order');
}

const picked: DeliveryProvider = pickProvider(
  'DELIVERY_PROVIDER',
  env.DELIVERY_PROVIDER,
  providers,
);

// every call to the provider tells its health (health.ts, the alert delivery_provider_down): a
// failure to answer marks it down, any answer up (a carrier that refuses a parcel answered); a
// provider without its key was not asked
const watched =
  <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    try {
      const result = await call(...args);
      await markDeliveryProviderUp();
      return result;
    } catch (err) {
      if (isAppError(err) && err.errorCode === DELIVERY_PROVIDER_UNAVAILABLE) {
        await markDeliveryProviderDown(new Date());
      } else if (isAppError(err) && err.errorCode !== DELIVERY_PROVIDER_NOT_CONFIGURED) {
        await markDeliveryProviderUp();
      }
      throw err;
    }
  };

export const deliveryProvider: DeliveryProvider = {
  ...picked,
  quote: watched(picked.quote.bind(picked)),
  createParcel: watched(picked.createParcel.bind(picked)),
  findParcel: watched(picked.findParcel.bind(picked)),
  voidParcel: watched(picked.voidParcel.bind(picked)),
  takesDocuments: watched(picked.takesDocuments.bind(picked)),
  customsInvoice: watched(picked.customsInvoice.bind(picked)),
};

// where the provider reports the parcels (the route lives in src/routes/api/delivery); outside the
// request rate limit
export const DELIVERY_WEBHOOK_PATH = `/api/delivery/${deliveryProvider.name}/webhook`;
