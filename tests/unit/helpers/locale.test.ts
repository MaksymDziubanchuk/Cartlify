import { describe, expect, it } from '@jest/globals';

import { setShopSettingsForTest } from '@config/shopSettings.js';
import { enabledLocaleOf, mailLocaleOf } from '@helpers/locale.js';

// the languages the shop answers in (shopSettings().enabledLocales, src/locales): only "en" has
// a dictionary at this point of the plan (step 6 adds more), so the fixtures below enable others
// by hand (setShopSettingsForTest), the same as shopSettings.services.ts would once they exist

describe('enabledLocaleOf', () => {
  it('is null for no locale, an empty one, or one of the wrong shape', () => {
    expect(enabledLocaleOf(null)).toBeNull();
    expect(enabledLocaleOf(undefined)).toBeNull();
    expect(enabledLocaleOf('')).toBeNull();
    expect(enabledLocaleOf('english')).toBeNull();
  });

  it('normalizes the shape (uk-UA, UK) before checking it is enabled', () => {
    setShopSettingsForTest({ enabledLocales: ['en', 'uk'] });

    expect(enabledLocaleOf('uk-UA')).toBe('uk');
    expect(enabledLocaleOf('UK')).toBe('uk');
  });

  it('is null for a locale that is not enabled', () => {
    setShopSettingsForTest({ enabledLocales: ['en'] });

    expect(enabledLocaleOf('uk')).toBeNull();
  });
});

describe('mailLocaleOf', () => {
  it("gives the person's own language when it is enabled", () => {
    setShopSettingsForTest({ enabledLocales: ['en', 'uk'], shopLocale: 'en' });

    expect(mailLocaleOf('uk')).toBe('uk');
  });

  it("falls back to the shop's language for a guest (no locale) or a language that is not enabled", () => {
    setShopSettingsForTest({ enabledLocales: ['en'], shopLocale: 'en' });

    expect(mailLocaleOf(null)).toBe('en');
    expect(mailLocaleOf('uk')).toBe('en');
  });

  // a deploy that drops a dictionary after root set it as the language of the shop: the mail
  // still goes, in English (shop_locale_missing tells root and the admins)
  it('falls back to English when even the language of the shop lost its dictionary', () => {
    setShopSettingsForTest({ enabledLocales: ['xx'], shopLocale: 'xx' });

    expect(mailLocaleOf(null)).toBe('en');
    expect(mailLocaleOf('xx')).toBe('en');
  });
});
