import { afterEach, describe, expect, it } from '@jest/globals';

import {
  SHOP_SETTING_KEYS,
  WRITABLE_SHOP_SETTINGS_FIELDS,
  PUBLIC_SHOP_SETTINGS_FIELDS,
  newsletterLimit,
  shopSettings,
} from '@config/shopSettings.js';

import { resetShopSettings, setShopSettings } from '../../helpers/shopSettings.js';

// the limit of the newsletters: at most `count` campaigns in any window of `days` days, two settings
// of the data of the shop with defaults in the code (2 and 7) until root says otherwise

afterEach(resetShopSettings);

describe('the limit of the newsletters in the data of the shop', () => {
  it('is 2 campaigns in 7 days while root has set nothing', () => {
    expect(shopSettings().newsletterLimitCount).toBe(2);
    expect(shopSettings().newsletterLimitDays).toBe(7);
    expect(newsletterLimit()).toEqual({ count: 2, days: 7 });
  });

  it('follows the two settings', () => {
    setShopSettings({ newsletterLimitCount: 5, newsletterLimitDays: 30 });

    expect(newsletterLimit()).toEqual({ count: 5, days: 30 });
  });

  it('is a key root writes and the database knows, and no key of the public page', () => {
    for (const key of ['newsletterLimitCount', 'newsletterLimitDays']) {
      expect(SHOP_SETTING_KEYS).toContain(key);
      expect(WRITABLE_SHOP_SETTINGS_FIELDS).toContain(key);
      expect(PUBLIC_SHOP_SETTINGS_FIELDS).not.toContain(key);
    }
  });
});
