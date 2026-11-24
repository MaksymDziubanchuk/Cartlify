import { beforeEach } from '@jest/globals';

import {
  applyTestShopCountriesBaseline,
  UNIT_COUNTRIES_BASELINE,
} from '../helpers/shopCountries.js';
import { applyTestShopSettingsBaseline, UNIT_SHOP_BASELINE } from '../helpers/shopSettings.js';

// a unit test calls no startApp (no loadShopSettings read a row): without this, the first call of
// any code that reads @config/shopSettings.js would throw "shop settings were not loaded". Before
// every test, the baseline of the unit tests (tests/helpers/shopSettings.ts)
// and the record of the country of its zone (tests/helpers/shopCountries.ts)
beforeEach(() => {
  applyTestShopSettingsBaseline(UNIT_SHOP_BASELINE);
  applyTestShopCountriesBaseline(UNIT_COUNTRIES_BASELINE);
});
