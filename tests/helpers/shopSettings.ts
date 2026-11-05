import { isDeliveryMethodName } from '@config/deliveryMethods.js';
import {
  setShopSettingsForTest,
  shopSettings,
  type ShopSettingsValues,
} from '@config/shopSettings.js';

// changes fields of the data of the shop in the memory of this test file only, no database write
// (@config/shopSettings.js keeps the same object reference every call, the way tests/helpers/
// delivery.ts used to change env directly). Call resetShopSettings (afterEach) to put the values
// back. The first call remembers the values as they stood: after startApp (loadShopSettings read
// a real row) for an integration test, or the server's own defaults for a unit test that never
// calls it (shop settings were not loaded otherwise)
let original: ShopSettingsValues | null = null;

function currentOrDefaults(): ShopSettingsValues {
  try {
    return shopSettings();
  } catch {
    setShopSettingsForTest();
    return shopSettings();
  }
}

export const setShopSettings = (values: Partial<ShopSettingsValues>): void => {
  original ??= { ...currentOrDefaults() };
  setShopSettingsForTest(values);
};

// call it in afterEach
export const resetShopSettings = (): void => {
  if (original) setShopSettingsForTest(original);
};

// loadShopSettings (startApp) reads a real row of an empty table: no delivery, no seller, the
// bare server defaults. tests/setup/{integration,unit}.setup.ts still set the env vars of these
// fields under their old names (DELIVERY_METHODS, PICKUP_ADDRESS, ... real SendGrid addresses for
// EMAIL_FROM_NAME/EMAIL_REPLY_TO included, tests/helpers/mail.ts) — unit tests leave most of them
// unset (isolateEnv fills every key of .env.example with '' unless given), the way env.ts itself
// fell back to its own defaults for an unset DELIVERY_METHODS ('manual' alone); this applies that
// same baseline, so every test still starts with a shop that can take a manual or a pickup order,
// as it always did. startApp calls it once; a unit test with no startApp calls it itself (a plain
// beforeAll suffices, nothing here reads a row of a database)
export function applyTestShopSettingsBaseline(): void {
  setShopSettingsForTest(); // a cache to read the server's own defaults from, if none yet
  const defaults = shopSettings();

  const rawMethods = (process.env.DELIVERY_METHODS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(isDeliveryMethodName);
  const rawCountries = (process.env.DELIVERY_COUNTRIES ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);

  setShopSettingsForTest({
    deliveryMethods: rawMethods.length ? rawMethods : defaults.deliveryMethods,
    deliveryCountries: rawCountries.length ? rawCountries : defaults.deliveryCountries,
    pickupAddress: process.env.PICKUP_ADDRESS || defaults.pickupAddress,
    pickupHours: process.env.PICKUP_HOURS || defaults.pickupHours,
    emailFromName: process.env.EMAIL_FROM_NAME || defaults.emailFromName,
    emailReplyTo: process.env.EMAIL_REPLY_TO || defaults.emailReplyTo,
    avatarRemovalsLimit: Number(process.env.AVATAR_REMOVALS_LIMIT) || defaults.avatarRemovalsLimit,
    reviewRemovalsLimit: Number(process.env.REVIEW_REMOVALS_LIMIT) || defaults.reviewRemovalsLimit,
  });
}
