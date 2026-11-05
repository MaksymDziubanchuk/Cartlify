import type { DeliveryMethodName } from '@config/deliveryMethods.js';

// the data of the shop (delivery, brand, reservation, moderation, withdrawal, languages, the
// seller): a version in cartlify.shop_settings, root writes a new one, nobody changes or removes
// one (docs/shop-settings.md); the same shape of values as @config/shopSettings.ts

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

// one field of the current version, admin and root (GET /api/admin/shop-settings/:key)
export interface ShopSettingsFieldDto {
  key: string;
  value: string | number | boolean | string[] | null;
}

// a field that has no default of the server and root has not set yet
export interface ShopSettingsMissingFieldsDto {
  fields: string[];
}

// root writes a full version; PUT /api/root/shop-settings. baseVersion is the version root edited
// from (0 before any root wrote one, GET /api/root/shop-settings gives the current one); the logo
// is not here (POST /api/root/shop-settings/logo), the database refuses a stale baseVersion
export interface PutShopSettingsBodyDto {
  baseVersion: number;
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
  shopLocale: string;
  enabledLocales: string[];
  sellerLegalName: string | null;
  sellerAddress: string | null;
  sellerTaxId: string | null;
  sellerEmail: string | null;
  sellerPhone: string | null;
}

export interface ShopSettingsVersionDto extends ShopSettingsValuesDto {
  version: number;
  // null for a version the server wrote to fill in a default root left empty
  setBy: { id: number; name: string | null; email: string | null } | null;
  createdAt: string;
}

export interface GetShopSettingsHistoryResponseDto {
  items: ShopSettingsVersionDto[];
  nextCursor: string | null;
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
