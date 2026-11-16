import {
  setShopSettingsForTest,
  shopSettings,
  type ShopSettingsValues,
} from '@config/shopSettings.js';
import type { DeliveryZone } from '@config/deliveryZones.js';

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

// the zone of the countries of the tests: the manual delivery there costs nothing and is free from
// no sum, so a test that does not price the delivery pays the items only
export const TEST_ZONE: DeliveryZone = {
  name: 'Test zone',
  countries: ['UA', 'PL', 'DE', 'GB', 'ES'],
  manualPrice: 0,
  freeFrom: null,
};

// the data of the shop every integration test starts with. loadShopSettings (startApp) reads a
// table that root has not filled: the bare server defaults, no delivery and no seller. On top of
// them: a shop that sends by hand to the five countries of one zone (TEST_ZONE) and lets a buyer
// collect an order, the name
// and the reply address of the mails (every mail needs the reply address, EMAIL_REPLY_TO_REQUIRED
// otherwise; the real SendGrid of service:sendgrid takes only the sender, EMAIL_FROM, from env),
// and short limits of avatar and review removals, so a test passes each in three removals. The
// values live here, not in env: the server reads none of them from env (docs/shop-settings.md)
export const INTEGRATION_SHOP_BASELINE: Partial<ShopSettingsValues> = {
  deliveryMethods: ['manual', 'pickup'],
  deliveryZones: [TEST_ZONE],
  pickupAddress: 'Test shop, Main street 1, Kyiv',
  pickupHours: 'Mon-Fri 10:00-18:00',
  emailFromName: 'Cartlify',
  emailReplyTo: 'support@shop.example.com',
  avatarRemovalsLimit: 2,
  reviewRemovalsLimit: 2,
};

// a unit test reads no database: the server defaults, and a zone of one country for the manual
// delivery
export const UNIT_SHOP_BASELINE: Partial<ShopSettingsValues> = {
  deliveryZones: [{ ...TEST_ZONE, countries: ['UA'] }],
};

// startApp applies the integration baseline once; tests/setup/unit.shopSettings.ts the unit one
// before every unit test (nothing here reads a row of a database). A field the baseline does not
// name keeps the value the cache has: the server default, or what loadShopSettings read
export function applyTestShopSettingsBaseline(values: Partial<ShopSettingsValues>): void {
  setShopSettingsForTest(); // a cache of the server's own defaults, if none yet
  setShopSettingsForTest(values);
}

// the test zone at a price of the manual delivery, free from the sum given (none: never free)
export const testZonePrice = (
  manualPrice: number,
  freeFrom: number | null = null,
): Partial<ShopSettingsValues> => ({
  deliveryZones: [{ ...TEST_ZONE, manualPrice, freeFrom }],
});
