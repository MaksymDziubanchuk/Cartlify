import { BadRequestError } from '@utils/errors.js';

// the code printed on the pack of a variant: an EAN-8, a UPC-A (12), an EAN-13 or a GTIN-14, digits
// only, the last one a check digit (db/06 holds the digits, the check digit is checked here)
export const BARCODE_LENGTHS: readonly number[] = [8, 12, 13, 14];

// the check digit of a GS1 code: from the digit next to it, the digits weigh 3, 1, 3, 1...; the
// sum and the check digit make a multiple of 10
export function hasValidCheckDigit(code: string): boolean {
  if (!/^\d+$/.test(code)) return false;

  const digits = [...code].map(Number);
  const check = digits.pop()!;
  const sum = digits
    .reverse()
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);

  return (10 - (sum % 10)) % 10 === check;
}

export const isBarcode = (code: string): boolean =>
  BARCODE_LENGTHS.includes(code.length) && hasValidCheckDigit(code);

// a barcode as it is kept: trimmed, an empty one is none (null), undefined is not sent
export function normalizeBarcode(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const code = String(value).trim();
  if (!code) return null;
  if (!isBarcode(code)) throw new BadRequestError('VARIANT_BARCODE_INVALID');

  return code;
}
