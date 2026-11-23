import type {
  ThresholdPeriodName,
  DeliveryVatName,
  ExportPriceName,
  TaxNumberKindName,
  TaxRateEntry,
  TaxRuleName,
} from '@config/shopCountries.js';

// The countries the shop sells to with the rule of their tax, and the tax groups of the products
// (docs/taxes.md): root writes a country with its zone of the delivery at once
// (PUT /api/root/countries/:country) and the groups with their rates in every country
// (POST /api/root/tax-groups)

export interface ShopCountryZoneDto {
  name: string;
  manualPrice: number | null;
  freeFrom: number | null;
}

export interface ShopCountryParcelLimitDto {
  amount: number;
  withDelivery: boolean;
  withVat: boolean;
}

export interface ShopCountryThresholdDto {
  amount: number;
  withVat: boolean;
  group: string | null;
  period: ThresholdPeriodName;
  startMonth: number | null;
  // a year: the rule the next one starts with; the last 12 months: initial goes back to the first
  // rule now
  nextCycle: 'recipient' | 'initial';
}

// a record of a country as root reads it: the zone it is in (null: the shop does not deliver
// there, the record only holds its rates or its pickup), and the period of the threshold in force
export interface ShopCountryDto {
  country: string;
  zone: ShopCountryZoneDto | null;
  customsFree: boolean;
  rule: TaxRuleName | null;
  registered: boolean;
  taxNumber: string | null;
  taxNumberLabel: string | null;
  taxNumberKind: TaxNumberKindName | null;
  parcelLimit: ShopCountryParcelLimitDto | null;
  threshold:
    | (ShopCountryThresholdDto & { cycleFrom: string; nextCycleFrom: string | null; held: boolean })
    | null;
  deliveryVat: DeliveryVatName | null;
  exportPrice: ExportPriceName | null;
  exemptionText: string | null;
  rates: TaxRateEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface GetShopCountriesResponseDto {
  items: ShopCountryDto[];
}

// everything a country is, at once: a field left null is "none" (no rule, no limit, no threshold)
export interface PutShopCountryBodyDto {
  zone: ShopCountryZoneDto | null;
  customsFree: boolean;
  rule: TaxRuleName | null;
  registered: boolean;
  taxNumber: string | null;
  taxNumberLabel: string | null;
  taxNumberKind: TaxNumberKindName | null;
  parcelLimit: ShopCountryParcelLimitDto | null;
  threshold: ShopCountryThresholdDto | null;
  deliveryVat: DeliveryVatName | null;
  exportPrice: ExportPriceName | null;
  exemptionText: string | null;
  rates: TaxRateEntry[];
}

// the classes of the products for one country copied to another
export interface PostCopyExceptionsBodyDto {
  from: string;
}

export interface PostCopyExceptionsResponseDto {
  products: number;
}

export interface TaxGroupDto {
  id: number;
  name: string;
  // how many products are in it, and how many a country classes in it
  products: number;
  exceptions: number;
  createdAt: string;
  updatedAt: string;
}

export interface GetTaxGroupsResponseDto {
  items: TaxGroupDto[];
}

// a new group with its rate in every country that has rates
export interface PostTaxGroupBodyDto {
  name: string;
  rates: Record<string, number>;
}

export interface PatchTaxGroupBodyDto {
  name: string;
}
