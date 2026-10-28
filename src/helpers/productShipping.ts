import { BadRequestError } from '@utils/errors.js';

// what a product weighs and measures packed, the way it is sent: whole grams and whole millimetres.
// The shipping needs it whatever the method. The sizes come all three or none (db/06,
// products_shipping_data_chk); a new product has the weight and the sizes unless the admin says they
// come later, and so does a product whose known data are cleared

export const PRODUCT_WEIGHT_MAX_GRAMS = 1_000_000;
export const PRODUCT_SIZE_MAX_MM = 10_000;

export const SHIPPING_SIZE_FIELDS = ['lengthMm', 'widthMm', 'heightMm'] as const;

export type ProductShippingData = {
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
};

// the fields as they come: numbers of a json body, text of a form
export type ProductShippingInput = {
  weightGrams?: unknown;
  lengthMm?: unknown;
  widthMm?: unknown;
  heightMm?: unknown;
  withoutShippingData?: unknown;
};

export type ProductShippingChanges = Partial<ProductShippingData>;

// a whole number from 1 to max, null (or the word null of a form) to clear, undefined when the
// field is not sent
function wholeNumberOf(value: unknown, max: number, code: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value === 'string') {
    const text = value.trim();
    if (text === 'null') return null;
    if (!/^[1-9]\d*$/.test(text)) throw new BadRequestError(code);
    value = Number(text);
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new BadRequestError(code);
  }

  return value;
}

// the flag that the data come later: true or false, a word of a form too
function flagOf(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }

  throw new BadRequestError('PRODUCT_WITHOUT_SHIPPING_DATA_INVALID');
}

// the fields sent, checked one by one; the flag is read here, it is not kept
export function readShippingChanges(input: ProductShippingInput): {
  changes: ProductShippingChanges;
  without: boolean;
} {
  const changes: ProductShippingChanges = {};

  const weight = wholeNumberOf(
    input.weightGrams,
    PRODUCT_WEIGHT_MAX_GRAMS,
    'PRODUCT_WEIGHT_INVALID',
  );
  if (weight !== undefined) changes.weightGrams = weight;

  for (const field of SHIPPING_SIZE_FIELDS) {
    const size = wholeNumberOf(input[field], PRODUCT_SIZE_MAX_MM, 'PRODUCT_SIZES_INVALID');
    if (size !== undefined) changes[field] = size;
  }

  return { changes, without: flagOf(input.withoutShippingData) };
}

const sizesOf = (data: ProductShippingData) => SHIPPING_SIZE_FIELDS.map((field) => data[field]);

// the data a product has after a change. The sizes come all three or none. A new product needs the
// weight and the sizes, a product that has them keeps them: clearing what is known, like leaving
// out what a new product needs, is refused unless the admin says it comes later (without)
export function resolveShippingData(
  current: ProductShippingData | null,
  changes: ProductShippingChanges,
  without: boolean,
): ProductShippingData {
  const next: ProductShippingData = {
    weightGrams: null,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    ...current,
    ...changes,
  };

  const sizes = sizesOf(next).filter((size) => size !== null).length;
  if (sizes !== 0 && sizes !== SHIPPING_SIZE_FIELDS.length) {
    throw new BadRequestError('PRODUCT_SIZES_INCOMPLETE');
  }

  if (without) return next;

  // what is missing now that a new product needs, or what was there and is cleared
  const missing: string[] = [];
  if (next.weightGrams === null && (current === null || current.weightGrams !== null)) {
    missing.push('weightGrams');
  }
  if (sizes === 0 && (current === null || sizesOf(current).every((size) => size !== null))) {
    missing.push('sizesMm');
  }
  if (missing.length)
    throw new BadRequestError('PRODUCT_SHIPPING_DATA_REQUIRED', { fields: missing });

  return next;
}
