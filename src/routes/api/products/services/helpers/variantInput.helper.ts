import { MAX_PRODUCT_VARIANTS, MAX_VARIANT_IMAGES } from '@config/limits.js';
import { normalizeBarcode } from '@helpers/variantFields.js';
import {
  readShippingChanges,
  resolveShippingData,
  type ProductShippingData,
} from '@helpers/productShipping.js';
import { toNumberSafe } from '@helpers/safeNormalizer.js';
import { MAX_ID } from '@schemas/idPathParam.js';
import { BadRequestError, isAppError } from '@utils/errors.js';

import { normalizeSaleEnd } from './productSale.helper.js';
import { isPrice, normalizeSku } from './products.helpers.js';
import { planValueInputs, type ValueInput } from './variantValues.helper.js';

import type { ProductSaleDto } from 'types/dto/products.dto.js';

// How many variants one request makes at most (the product has PRODUCT_VARIANTS_MAX in all)
export const VARIANTS_PER_REQUEST_MAX = 100;

// The variants a request brings, read and checked as far as the request alone tells: the fields of
// each one, its pictures, the codes among the variants of the request. What needs the database (the
// pictures of the gallery, the article numbers and the barcodes the catalog has) is checked in the
// transaction that writes them.

// a picture of a variant: the key of the picture and its place among the pictures of the variant.
// The key is the number of an uploaded file when a product is made with its pictures, the id of a
// picture of the gallery when a variant is added to a product that is there
export type VariantImageSpec = { key: number; position: number };

export type NewVariantPlan = {
  price: number;
  sku: string | null;
  barcode: string | null;
  shipping: ProductShippingData;
  images: VariantImageSpec[];
  // the values of its characteristics, as the request names them (checked against the directory
  // when the variant is written)
  attributes: ValueInput[];
};

// where the pictures of a variant come from: files of the request (a product is made), or the
// gallery of the product
export type ImageSource = { kind: 'files'; count: number } | { kind: 'gallery' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInt = (value: unknown): value is number => Number.isInteger(value);

// the pictures of a variant: [{ file | imageId, position }], each picture once, each place once.
// A new variant needs one at least (required: none, null and an empty list are
// VARIANT_IMAGE_REQUIRED), a change may leave it with none (an empty list takes them all away). A
// value that is no list (a text, a number, an object, and null in a change, which is no way to say
// "none") is VARIANT_IMAGES_INVALID
export function planVariantImages(
  raw: unknown,
  source: ImageSource,
  opts: { required: boolean },
): VariantImageSpec[] {
  const keyName = source.kind === 'files' ? 'file' : 'imageId';

  if (opts.required && (raw === undefined || raw === null)) {
    throw new BadRequestError('VARIANT_IMAGE_REQUIRED');
  }
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new BadRequestError('VARIANT_IMAGES_INVALID');
  if (raw.length === 0) {
    if (opts.required) throw new BadRequestError('VARIANT_IMAGE_REQUIRED');
    return [];
  }

  if (raw.length > MAX_VARIANT_IMAGES) {
    throw new BadRequestError('VARIANT_IMAGES_TOO_MANY', { max: MAX_VARIANT_IMAGES });
  }

  const seenKeys = new Set<number>();
  const seenPlaces = new Set<number>();
  const images: VariantImageSpec[] = [];

  for (const item of raw) {
    const key = isRecord(item) ? (item[keyName] as unknown) : undefined;
    const position = isRecord(item) ? (item.position as unknown) : undefined;

    // a picture that is not there: a file the request does not have, an id that is no id
    const keyOk =
      isInt(key) && (source.kind === 'files' ? key >= 0 && key < source.count : key >= 1);
    if (!keyOk) throw new BadRequestError('VARIANT_IMAGE_NOT_FOUND', { [keyName]: key ?? null });

    if (!isInt(position) || position < 1 || position > MAX_ID) {
      throw new BadRequestError('VARIANT_IMAGE_POSITION_INVALID', { position: position ?? null });
    }
    if (seenKeys.has(key)) throw new BadRequestError('VARIANT_IMAGES_REPEATED', { [keyName]: key });
    if (seenPlaces.has(position)) {
      throw new BadRequestError('VARIANT_IMAGE_POSITION_INVALID', { position });
    }

    seenKeys.add(key);
    seenPlaces.add(position);
    images.push({ key, position });
  }

  return images;
}

// one new variant: its fields, the weight and the sizes (needed unless it says they come later),
// its pictures. Throws the first problem it finds
export function planNewVariant(raw: unknown, source: ImageSource): NewVariantPlan {
  if (!isRecord(raw)) throw new BadRequestError('VARIANT_INVALID');

  // the stock comes with a delivery, a new variant has none
  if (raw.stock !== undefined) throw new BadRequestError('PRODUCT_STOCK_NOT_ALLOWED');

  const price = toNumberSafe(raw.price);
  if (price === undefined || !isPrice(price)) throw new BadRequestError('PRODUCT_PRICE_INVALID');

  const sku = normalizeSku(raw.sku) ?? null;
  const barcode = normalizeBarcode(raw.barcode) ?? null;

  const { changes, without } = readShippingChanges(raw);
  const shipping = resolveShippingData(null, changes, without);

  const images = planVariantImages(raw.images, source, { required: true });
  const attributes = planValueInputs(raw.attributes) ?? [];

  return { price, sku, barcode, shipping, images, attributes };
}

// a problem of one variant of the request, by its place in the list
export type VariantProblem = { index: number; errorCode: string; details?: unknown };

// the variants of a request. A problem of a variant does not stop the check: every variant that
// is wrong is named with its own code, 400 VARIANTS_INVALID with details.variants. An empty list,
// or one that is no list, is VARIANTS_REQUIRED; a list over the limits is PRODUCT_VARIANTS_TOO_MANY
// (the variants the product has already count when the caller names them in `have`)
export function planNewVariants(
  raw: unknown,
  source: ImageSource,
  opts: { have?: number; perRequest?: number } = {},
): NewVariantPlan[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestError('VARIANTS_REQUIRED');

  const perRequest = opts.perRequest ?? MAX_PRODUCT_VARIANTS;
  if (raw.length > perRequest) {
    throw new BadRequestError('PRODUCT_VARIANTS_TOO_MANY', { max: perRequest });
  }
  if (raw.length + (opts.have ?? 0) > MAX_PRODUCT_VARIANTS) {
    throw new BadRequestError('PRODUCT_VARIANTS_TOO_MANY', {
      max: MAX_PRODUCT_VARIANTS,
      have: opts.have ?? 0,
    });
  }

  const problems: VariantProblem[] = [];
  const plans: NewVariantPlan[] = [];

  raw.forEach((item, index) => {
    try {
      plans.push(planNewVariant(item, source));
    } catch (err) {
      if (!isAppError(err)) throw err;

      problems.push({
        index,
        errorCode: err.errorCode,
        ...(err.details !== undefined ? { details: err.details } : {}),
      });
    }
  });

  if (problems.length) throw new BadRequestError('VARIANTS_INVALID', { variants: problems });

  return plans;
}

// the codes that two variants of one request share: the article numbers whatever the case of their
// letters, the barcodes. The index of each variant, in the order of the request
export function repeatedCodes(plans: ReadonlyArray<Pick<NewVariantPlan, 'sku' | 'barcode'>>): {
  skus: number[];
  barcodes: number[];
} {
  const find = (codeOf: (plan: Pick<NewVariantPlan, 'sku' | 'barcode'>) => string | null) => {
    const seen = new Map<string, number>();
    const repeated: number[] = [];

    plans.forEach((plan, index) => {
      const code = codeOf(plan);
      if (code === null) return;

      if (seen.has(code)) repeated.push(index);
      else seen.set(code, index);
    });

    return repeated;
  };

  return {
    skus: find((plan) => plan.sku?.toLowerCase() ?? null),
    barcodes: find((plan) => plan.barcode),
  };
}

// ---- the price and the sale of a variant, the change of one or of many variants ----

// the word on the sale that goes with a new price: keep the sale that is on, take it off, or put a
// new one on from the new price (the old one goes first); its end is checked to be ahead
export type VariantSalePlan =
  { word: 'keep' } | { word: 'remove' } | { word: 'new'; sale: ProductSaleDto; endsAt: Date };

// a new price: whole cents from 0 up to what numeric(10, 2) holds
export function readVariantPrice(price: unknown): number | undefined {
  if (price === undefined) return undefined;

  const value = toNumberSafe(price);
  if (value === undefined || !isPrice(value)) throw new BadRequestError('PRODUCT_PRICE_INVALID');

  return value;
}

// the word on the sale goes with a price; the sale alone has a route of its own
export function readVariantSale(
  sale: unknown,
  price: number | undefined,
): VariantSalePlan | undefined {
  if (sale === undefined) return undefined;
  if (price === undefined) throw new BadRequestError('PRODUCT_SALE_REQUIRES_PRICE');

  if (sale === 'keep' || sale === 'remove') return { word: sale };

  // a new sale starts right away, its end is in the future
  const given = sale as ProductSaleDto;
  return { word: 'new', sale: given, endsAt: normalizeSaleEnd(given.endsAt) };
}

export type VariantChangeFields = {
  price?: unknown;
  sale?: unknown;
  weightGrams?: unknown;
  lengthMm?: unknown;
  widthMm?: unknown;
  heightMm?: unknown;
  withoutShippingData?: unknown;
  attributes?: unknown;
  stock?: unknown;
};

// what the change of a variant writes besides its own fields: the price, the word on the sale, the
// weight and the sizes. The same for one variant and for many
export type VariantChangePlan = {
  price: number | undefined;
  sale: VariantSalePlan | undefined;
  shippingChanges: ReturnType<typeof readShippingChanges>['changes'];
  // the admin says the data come later (not kept): clearing what is known is allowed then
  withoutShippingData: boolean;
  // the values of characteristics to set, or (null) to take away; undefined when the request names
  // none (an empty list is none)
  attributes: ValueInput[] | undefined;
};

function planChange(fields: VariantChangeFields): VariantChangePlan {
  // the stock changes only with a delivery or a write-off, each with its line in the admin log
  if (fields.stock !== undefined) throw new BadRequestError('PRODUCT_STOCK_NOT_ALLOWED');

  const { changes: shippingChanges, without } = readShippingChanges(fields);
  const price = readVariantPrice(fields.price);
  const sale = readVariantSale(fields.sale, price);
  const attributes = planValueInputs(fields.attributes);

  return {
    price,
    sale,
    shippingChanges,
    withoutShippingData: without,
    attributes: attributes?.length ? attributes : undefined,
  };
}

const hasChange = (plan: VariantChangePlan): boolean =>
  plan.price !== undefined ||
  Object.keys(plan.shippingChanges).length > 0 ||
  plan.attributes !== undefined;

// the pictures of a change, read the way every form reads them: a list written whole (an empty list
// takes them all away); undefined when the request does not name them
function planChangeImages(images: unknown): VariantImageSpec[] | undefined {
  return images === undefined
    ? undefined
    : planVariantImages(images, { kind: 'gallery' }, { required: false });
}

// the fields of the same change for many variants of a product: the same list of pictures for every
// one of them (no article number, barcode or place: a code is unique and a place is one variant's)
export type VariantsChangeFields = VariantChangeFields & { images?: unknown };

export type VariantsChangePlan = VariantChangePlan & { images: VariantImageSpec[] | undefined };

// the fields of the same change for many variants, read and checked as far as the request alone
// tells; a change with nothing to change is refused
export function planVariantsChange(fields: VariantsChangeFields): VariantsChangePlan {
  const plan = planChange(fields);
  const images = planChangeImages(fields.images);
  if (!hasChange(plan) && images === undefined) throw new BadRequestError('NO_FIELDS_TO_UPDATE');

  return { ...plan, images };
}

// ---- a change of one variant ----

export type VariantUpdateFields = VariantChangeFields & {
  sku?: unknown;
  barcode?: unknown;
  position?: unknown;
  images?: unknown;
};

export type VariantUpdatePlan = ReturnType<typeof planVariantUpdate>;

// the fields sent, read and checked as far as the request alone tells; a change with nothing to
// change is refused
export function planVariantUpdate(fields: VariantUpdateFields) {
  const change = planChange(fields);

  const sku = normalizeSku(fields.sku);
  const barcode = normalizeBarcode(fields.barcode);

  let position: number | undefined;
  if (fields.position !== undefined) {
    if (!isInt(fields.position) || fields.position < 1 || fields.position > MAX_ID) {
      throw new BadRequestError('VARIANT_POSITION_INVALID');
    }
    position = fields.position;
  }

  const images = planChangeImages(fields.images);

  const hasAnyUpdates =
    hasChange(change) ||
    sku !== undefined ||
    barcode !== undefined ||
    position !== undefined ||
    images !== undefined;
  if (!hasAnyUpdates) throw new BadRequestError('NO_FIELDS_TO_UPDATE');

  return { ...change, sku, barcode, position, images };
}

// the variants of a product form: the text of the field `variants`, a JSON list. A field that is
// missing, empty or not a JSON list is VARIANTS_REQUIRED (planNewVariants says the same of a list
// with no element)
export function parseVariantsText(text: unknown): unknown {
  if (typeof text !== 'string' || !text.trim()) throw new BadRequestError('VARIANTS_REQUIRED');

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequestError('VARIANTS_REQUIRED');
  }
}
