import type { DeliveryMethodName } from '@config/deliveryMethods.js';

// the data of the shop (delivery, brand, reservation, moderation, withdrawal, languages, the
// seller, the logo): a row a setting in cartlify.shop_settings, root adds one for each setting
// they change, nobody changes or removes one (docs/shop-settings.md); the same shape of values as
// @config/shopSettings.ts

export interface ShopSettingsValuesDto {
  deliveryMethods: DeliveryMethodName[];
  deliveryFlatPrice: number | null;
  deliveryFreeFrom: number | null;
  deliveryCountries: string[];
  pickupAddress: string;
  pickupHours: string;

  shopName: string;
  emailFromName: string;
  emailReplyTo: string;
  logoUrl: string | null;

  reservationMinutes: number;
  stripePageMinutes: number;

  reviewCheckEnabled: boolean;
  avatarRemovalsLimit: number;
  reviewRemovalsLimit: number;

  withdrawalGraceDays: number;

  newsletterLimitCount: number;
  newsletterLimitDays: number;
  newsletterFromName: string;
  newsletterTrustedDomains: string[];

  shopLocale: string;
  enabledLocales: string[];

  sellerLegalName: string | null;
  sellerAddress: string | null;
  sellerTaxId: string | null;
  sellerEmail: string | null;
  sellerPhone: string | null;
}

// the fields a guest or a buyer is shown (GET /api/shop-settings)
export interface PublicShopSettingsDto {
  shopName: string;
  logoUrl: string | null;
  shopLocale: string;
  enabledLocales: string[];
  sellerLegalName: string | null;
  sellerAddress: string | null;
  sellerTaxId: string | null;
  sellerEmail: string | null;
  sellerPhone: string | null;
}

// a field that has no default of the server and root has not set yet
export interface ShopSettingsMissingFieldsDto {
  fields: string[];
}

// root sets every setting at once, PUT /api/root/shop-settings: a row is added for each one whose
// value changes; the logo is not here (POST /api/root/shop-settings/logo)
export interface PutShopSettingsBodyDto {
  deliveryMethods: DeliveryMethodName[];
  deliveryFlatPrice: number | null;
  deliveryFreeFrom: number | null;
  deliveryCountries: string[];
  pickupAddress: string;
  pickupHours: string;
  shopName: string;
  emailFromName: string;
  emailReplyTo: string;
  reservationMinutes: number;
  stripePageMinutes: number;
  reviewCheckEnabled: boolean;
  avatarRemovalsLimit: number;
  reviewRemovalsLimit: number;
  withdrawalGraceDays: number;
  newsletterLimitCount: number;
  newsletterLimitDays: number;
  newsletterFromName: string;
  newsletterTrustedDomains: string[];
  shopLocale: string;
  enabledLocales: string[];
  sellerLegalName: string | null;
  sellerAddress: string | null;
  sellerTaxId: string | null;
  sellerEmail: string | null;
  sellerPhone: string | null;
}

// root sets one setting, PUT /api/root/shop-settings/:key: the value of the shape of that key
export interface PutShopSettingBodyDto {
  value: unknown;
}

// a row of the history: the value one setting took, who set it, when
export interface ShopSettingsHistoryItemDto {
  key: string;
  value: unknown;
  // null for a row the server wrote to fill in a default
  setBy: { id: number; name: string | null; email: string | null } | null;
  createdAt: string;
}

export interface GetShopSettingsHistoryResponseDto {
  items: ShopSettingsHistoryItemDto[];
  nextCursor: string | null;
}

// how many people have a language, for the warning root is shown before turning a language off
export interface ShopLocaleCountDto {
  locale: string;
  accounts: number;
  subscriptions: number;
}

export interface GetShopLocaleCountsResponseDto {
  items: ShopLocaleCountDto[];
}

// the logo in its form part: the stream is read while the request is parsed
export interface ShopLogoImagePart {
  file: NodeJS.ReadableStream;
  mimetype: string;
  filename?: string;
}

// a picture waiting on Cloudinary under an id of its own until the write of the logo ends
export interface UploadedShopLogo {
  publicId: string;
}
