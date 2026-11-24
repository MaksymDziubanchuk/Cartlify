import { getPgCode, getPgMessage } from '@db/client.js';
import { BadRequestError } from '@utils/errors.js';

// The refusals of the database for a write of root of the data of the shop, of a record of a
// country or of a tax group (db/05: shop_countries_before_write, the guards of the groups and of the
// series of the documents): a check that names the field that does not fit, given back as a 400 with
// its code; anything else as it was
const DB_REFUSALS = [
  'SHOP_COUNTRY_RULE_INVALID',
  'SHOP_COUNTRY_RECIPIENT_ONLY',
  'SHOP_COUNTRY_TAX_NUMBER_INVALID',
  'SHOP_COUNTRY_PARCEL_LIMIT_INVALID',
  'SHOP_COUNTRY_THRESHOLD_INVALID',
  'SHOP_COUNTRY_RATES_REQUIRED',
  'SHOP_COUNTRY_RATES_INVALID',
  'SHOP_COUNTRY_EXPORT_PRICE_REQUIRED',
  'SHOP_COUNTRY_EXEMPTION_TEXT_REQUIRED',
  'SHOP_COUNTRY_DELIVERY_VAT_REQUIRED',
  'SHOP_COUNTRY_GROUP_RATE_MISSING',
  'SHOP_COUNTRY_THRESHOLD_GROUP_MISMATCH',
  'TAX_GROUP_NOT_FOUND',
  'INVOICE_SERIES_TAKEN',
] as const;

export function settingsRefusalOf(err: unknown): unknown {
  const message = getPgMessage(err);
  if (
    getPgCode(err) === '23514' &&
    message &&
    (DB_REFUSALS as readonly string[]).includes(message)
  ) {
    return new BadRequestError(message, undefined, err);
  }
  return err;
}
