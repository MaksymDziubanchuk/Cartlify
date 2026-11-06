import { beforeEach } from '@jest/globals';

import { applyTestShopSettingsBaseline, UNIT_SHOP_BASELINE } from '../helpers/shopSettings.js';

// a unit test calls no startApp (no loadShopSettings read a row): without this, the first call of
// any code that reads @config/shopSettings.js would throw "shop settings were not loaded". Before
// every test, the baseline of the unit tests (tests/helpers/shopSettings.ts)
beforeEach(() => applyTestShopSettingsBaseline(UNIT_SHOP_BASELINE));
