import { shopSettings } from '@config/shopSettings.js';
import { BadRequestError } from '@utils/errors.js';

// What customs need of a product for a parcel that crosses a border: the code of the goods (HS, 6
// to 10 digits; the dots and the spaces of a tariff book are taken out) and the country they were
// made in (two letters, kept in capitals). Both optional on the product: a cart to a country with
// customs is refused while one of its products has none (DELIVERY_CUSTOMS_DATA_MISSING)

const HS_CODE = /^\d{6,10}$/;
const COUNTRY = /^[A-Z]{2}$/;

// the code of a product as an admin writes it; nothing, an empty text and a text of spaces are none
export function normalizeHsCode(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') throw new BadRequestError('PRODUCT_HS_CODE_INVALID');

  const code = input.replace(/[\s.]/g, '');
  if (!code) return null;
  if (!HS_CODE.test(code)) throw new BadRequestError('PRODUCT_HS_CODE_INVALID');
  return code;
}

// the country of origin of a product, two letters in any case; none when empty
export function normalizeOriginCountry(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') throw new BadRequestError('PRODUCT_ORIGIN_COUNTRY_INVALID');

  const country = input.trim().toUpperCase();
  if (!country) return null;
  if (!COUNTRY.test(country)) throw new BadRequestError('PRODUCT_ORIGIN_COUNTRY_INVALID');
  return country;
}

// a parcel to the country crosses customs: the shop named the countries without customs
// (customsFreeCountries) and this one is not among them. Not named: nothing is checked
export function customsNeededFor(country: string | null): boolean {
  const free = shopSettings().customsFreeCountries;
  return free !== null && country !== null && !free.includes(country);
}

export type CustomsProduct = {
  productId: number;
  name: string;
  hsCode: string | null;
  originCountry: string | null;
};

// the products of a cart customs cannot take: without the code or the country of origin, each once,
// in the order of the cart
export function productsWithoutCustomsData(products: readonly CustomsProduct[]) {
  const seen = new Set<number>();
  return products
    .filter((product) => !product.hsCode || !product.originCountry)
    .filter((product) => !seen.has(product.productId) && seen.add(product.productId))
    .map((product) => ({ productId: product.productId, name: product.name }));
}
