import { Prisma } from '@prisma/client';

import type { AuditChange } from '@db/adminAudit.helper.js';
import { MAX_ATTRIBUTE_MULTI_VALUES } from '@config/limits.js';
import { NUMBER_BOUND_MAX } from '@helpers/attributeFields.js';
import { requiredAttributesOf } from '@routes/api/attributes/services/helpers/categorySet.helper.js';
import { MAX_ID } from '@schemas/idPathParam.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  isAppError,
} from '@utils/errors.js';

type Tx = Prisma.TransactionClient;

// The values of the characteristics a variant has, as the routes of the variants write them: what a
// request says (planValueInputs), what the directory says it may be (loadValueContext,
// resolveValue), the rows (writeValues), and the rules over the whole product (the required
// characteristics of its category, a variant that repeats another: assertValuesAccepted). The
// database keeps the value within the type of its characteristic too (db/05); the errors here say
// what is wrong and where.

// the most characteristics one variant names in one request
export const VARIANT_ATTRIBUTES_PER_REQUEST_MAX = 200;
// a text of a characteristic: up to this many signs
export const TEXT_VALUE_MAX = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInt = (value: unknown): value is number => Number.isInteger(value);

export type ValueInput = { attributeId: number; value: unknown };

// The `attributes` of a variant of a request: a list of { attributeId, value }, each
// characteristic once. Nothing sent is undefined. A list that is wrong in its shape is 400
// VARIANT_ATTRIBUTES_INVALID, a characteristic named twice 400 VARIANT_ATTRIBUTES_REPEATED
export function planValueInputs(raw: unknown): ValueInput[] | undefined {
  if (raw === undefined) return undefined;

  if (!Array.isArray(raw) || raw.length > VARIANT_ATTRIBUTES_PER_REQUEST_MAX) {
    throw new BadRequestError('VARIANT_ATTRIBUTES_INVALID', {
      max: VARIANT_ATTRIBUTES_PER_REQUEST_MAX,
    });
  }

  const seen = new Set<number>();
  const repeated = new Set<number>();
  const inputs = raw.map((item): ValueInput => {
    if (!isRecord(item) || !isInt(item.attributeId) || !('value' in item)) {
      throw new BadRequestError('VARIANT_ATTRIBUTES_INVALID');
    }
    if (item.attributeId < 1 || item.attributeId > MAX_ID) {
      throw new BadRequestError('VARIANT_ATTRIBUTES_INVALID');
    }

    if (seen.has(item.attributeId)) repeated.add(item.attributeId);
    seen.add(item.attributeId);

    return { attributeId: item.attributeId, value: item.value };
  });

  if (repeated.size) {
    throw new BadRequestError('VARIANT_ATTRIBUTES_REPEATED', {
      attributeIds: [...repeated].sort((a, b) => a - b),
    });
  }

  return inputs;
}

// ---- the directory, as far as a value needs it ----

export type AttributeKind = 'text' | 'number' | 'boolean' | 'option' | 'options';

export type AttributeInfo = {
  id: number;
  name: string;
  type: AttributeKind;
  decimals: number | null;
  minValue: Prisma.Decimal | null;
  maxValue: Prisma.Decimal | null;
};

export type ValueContext = {
  attributes: Map<number, AttributeInfo>;
  // the characteristic each value of a list named by the request belongs to, by the id of the value
  optionOwner: Map<number, number>;
};

// Reads the characteristics a request names, and the values of lists it names, and keeps them as
// they are until the end of the transaction (the characteristic is locked FOR SHARE, so a change of
// its type or its delete waits; a value of a list FOR KEY SHARE, so its delete waits). A
// characteristic that is not there is 404 ATTRIBUTE_NOT_FOUND (details.attributeIds, all of them).
// A value of a list that is not there is left to the check of the value: it belongs to no
// characteristic. The locks come after the rows of the product, of its variants and of its pictures
export async function loadValueContext(
  tx: Tx,
  inputs: ReadonlyArray<ValueInput>,
): Promise<ValueContext> {
  const ids = [...new Set(inputs.map((input) => input.attributeId))].sort((a, b) => a - b);
  if (!ids.length) return { attributes: new Map(), optionOwner: new Map() };

  const rows = await tx.$queryRaw<
    Array<{
      id: number;
      name: string;
      type: AttributeKind;
      decimals: number | null;
      minValue: Prisma.Decimal | null;
      maxValue: Prisma.Decimal | null;
    }>
  >`
    select id, name, type::text as type, decimals, "minValue", "maxValue"
    from cartlify.attributes
    where id = any(${ids}::int[])
    order by id
    for share
  `;
  const attributes = new Map<number, AttributeInfo>(
    rows.map((row) => [
      row.id,
      {
        ...row,
        minValue: row.minValue === null ? null : new Prisma.Decimal(row.minValue),
        maxValue: row.maxValue === null ? null : new Prisma.Decimal(row.maxValue),
      },
    ]),
  );

  const missing = ids.filter((id) => !attributes.has(id));
  if (missing.length) throw new NotFoundError('ATTRIBUTE_NOT_FOUND', { attributeIds: missing });

  // the values of lists the request names: for a choice of one value its id, for a set its ids
  const named = new Set<number>();
  for (const input of inputs) {
    const type = attributes.get(input.attributeId)!.type;
    if (type === 'option' && isInt(input.value)) named.add(input.value);
    if (type === 'options' && Array.isArray(input.value)) {
      for (const item of input.value) if (isInt(item)) named.add(item);
    }
  }

  const optionOwner = new Map<number, number>();
  if (named.size) {
    const options = await tx.$queryRaw<Array<{ id: number; attributeId: number }>>`
      select id, "attributeId"
      from cartlify.attribute_options
      where id = any(${[...named].sort((a, b) => a - b)}::int[])
      order by id
      for key share
    `;
    for (const option of options) optionOwner.set(option.id, option.attributeId);
  }

  return { attributes, optionOwner };
}

// ---- what a value is ----

// a value as the rows keep it: a text, a number, yes/no, the value of a list (one id in a list), the
// values of a set (their ids, in the order of their ids)
export type HeldValue =
  | { type: 'text'; text: string }
  | { type: 'number'; number: Prisma.Decimal }
  | { type: 'boolean'; bool: boolean }
  | { type: 'option' | 'options'; optionIds: number[] };

// what a request does to the value of one characteristic: sets it, or (null) takes it away
export type ResolvedValue = { attributeId: number; value: HeldValue | null };

// the values to write for a variant, with what it holds now (by the id of the characteristic)
export type VariantValuesToWrite = {
  held: ReadonlyMap<number, HeldValue>;
  resolved: ReadonlyArray<ResolvedValue>;
};

const valueDetails = (info: AttributeInfo, extra: Record<string, unknown> = {}) => ({
  attributeId: info.id,
  attributeName: info.name,
  ...extra,
});

const invalid = (info: AttributeInfo, extra: Record<string, unknown> = {}) =>
  new BadRequestError('ATTRIBUTE_VALUE_INVALID', valueDetails(info, { type: info.type, ...extra }));

// The value of a request for a characteristic, checked against its type. null takes the value away
// where the request may (allowRemove, a change) and is no value where it may not (a new variant: the
// characteristic is left alone); the same for an empty set. Throws the 400 that says what is wrong:
// ATTRIBUTE_VALUE_INVALID (the wrong kind for the type: details.type), ATTRIBUTE_VALUE_TOO_SMALL and
// _TOO_LARGE (details.bound, details.value), ATTRIBUTE_VALUE_TOO_PRECISE (details.bound is the
// digits after the point the characteristic has), ATTRIBUTE_OPTION_NOT_FOUND (a value of a list that
// belongs to another characteristic or to none: details.optionIds), ATTRIBUTE_VALUES_REPEATED and
// ATTRIBUTE_VALUES_TOO_MANY (a set)
export function resolveValue(
  ctx: ValueContext,
  input: ValueInput,
  opts: { allowRemove: boolean },
): ResolvedValue | undefined {
  const info = ctx.attributes.get(input.attributeId)!;
  const { value } = input;
  const empty =
    value === null || (info.type === 'options' && Array.isArray(value) && !value.length);

  if (empty) return opts.allowRemove ? { attributeId: info.id, value: null } : undefined;

  switch (info.type) {
    case 'text': {
      if (typeof value !== 'string') throw invalid(info);
      const text = value.trim();
      if (!text || value.includes('\u0000')) throw invalid(info);
      if ([...text].length > TEXT_VALUE_MAX) throw invalid(info, { max: TEXT_VALUE_MAX });

      return { attributeId: info.id, value: { type: 'text', text } };
    }

    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(info);
      const number = new Prisma.Decimal(value);

      if (number.decimalPlaces() > (info.decimals ?? 0)) {
        throw new BadRequestError(
          'ATTRIBUTE_VALUE_TOO_PRECISE',
          valueDetails(info, { bound: info.decimals ?? 0, value }),
        );
      }

      // the column holds 15 digits before the point; the characteristic may hold less
      const floor = info.minValue ?? new Prisma.Decimal(-NUMBER_BOUND_MAX);
      const ceiling = info.maxValue ?? new Prisma.Decimal(NUMBER_BOUND_MAX);
      if (number.lessThan(floor)) {
        throw new BadRequestError(
          'ATTRIBUTE_VALUE_TOO_SMALL',
          valueDetails(info, { bound: Number(floor.toString()), value }),
        );
      }
      if (number.greaterThan(ceiling)) {
        throw new BadRequestError(
          'ATTRIBUTE_VALUE_TOO_LARGE',
          valueDetails(info, { bound: Number(ceiling.toString()), value }),
        );
      }

      return { attributeId: info.id, value: { type: 'number', number } };
    }

    case 'boolean': {
      if (typeof value !== 'boolean') throw invalid(info);
      return { attributeId: info.id, value: { type: 'boolean', bool: value } };
    }

    case 'option': {
      if (!isInt(value)) throw invalid(info);
      if (ctx.optionOwner.get(value) !== info.id) {
        throw new BadRequestError(
          'ATTRIBUTE_OPTION_NOT_FOUND',
          valueDetails(info, { optionIds: [value] }),
        );
      }

      return { attributeId: info.id, value: { type: 'option', optionIds: [value] } };
    }

    default: {
      if (!Array.isArray(value) || !value.every(isInt)) throw invalid(info);
      const ids = value as number[];

      const repeated = [...new Set(ids.filter((id, at) => ids.indexOf(id) !== at))];
      if (repeated.length) {
        throw new BadRequestError(
          'ATTRIBUTE_VALUES_REPEATED',
          valueDetails(info, { optionIds: repeated }),
        );
      }
      if (ids.length > MAX_ATTRIBUTE_MULTI_VALUES) {
        throw new BadRequestError(
          'ATTRIBUTE_VALUES_TOO_MANY',
          valueDetails(info, { max: MAX_ATTRIBUTE_MULTI_VALUES, have: ids.length }),
        );
      }

      const unknown = ids.filter((id) => ctx.optionOwner.get(id) !== info.id);
      if (unknown.length) {
        throw new BadRequestError(
          'ATTRIBUTE_OPTION_NOT_FOUND',
          valueDetails(info, { optionIds: unknown }),
        );
      }

      return {
        attributeId: info.id,
        value: { type: 'options', optionIds: [...ids].sort((a, b) => a - b) },
      };
    }
  }
}

// every value of a variant's request, the first problem of the variant (a request names a variant
// once, and the first thing wrong with it is enough to send it back); values that are no values (a
// new variant's null) are left out
export function resolveValues(
  ctx: ValueContext,
  inputs: ReadonlyArray<ValueInput>,
  opts: { allowRemove: boolean },
): ResolvedValue[] {
  return inputs.flatMap((input) => {
    const resolved = resolveValue(ctx, input, opts);
    return resolved ? [resolved] : [];
  });
}

// The values of the new variants of a request, each checked; a variant whose values are wrong is
// named with its error among the others (400 VARIANTS_INVALID, details.variants: index, errorCode,
// details), the way the other wrong variants of a request are
export function resolveNewVariants(
  ctx: ValueContext,
  plans: ReadonlyArray<{ attributes: ReadonlyArray<ValueInput> }>,
): ResolvedValue[][] {
  const problems: Array<{ index: number; errorCode: string; details?: unknown }> = [];

  const all = plans.map((plan, index) => {
    try {
      return resolveValues(ctx, plan.attributes, { allowRemove: false });
    } catch (err) {
      if (!isAppError(err)) throw err;

      problems.push({
        index,
        errorCode: err.errorCode,
        ...(err.details !== undefined ? { details: err.details } : {}),
      });
      return [];
    }
  });

  if (problems.length) throw new BadRequestError('VARIANTS_INVALID', { variants: problems });

  return all;
}

// a problem of the values of a variant, as the error of the variant it is about: the details name
// the variant
export function withVariant(
  err: AppError,
  variant: { variantId: number } | { index: number },
): AppError {
  const details = isRecord(err.details) ? err.details : {};
  return new AppError({
    statusCode: err.statusCode,
    errorCode: err.errorCode,
    message: err.message,
    details: { ...variant, ...details },
    cause: err,
  });
}

// ---- the rows ----

type HeldRow = {
  variantId: number;
  attributeId: number;
  textValue: string | null;
  numberValue: Prisma.Decimal | null;
  boolValue: boolean | null;
  optionId: number | null;
  attribute: { type: AttributeKind };
};

const heldSelect = {
  variantId: true,
  attributeId: true,
  textValue: true,
  numberValue: true,
  boolValue: true,
  optionId: true,
  attribute: { select: { type: true } },
} as const;

// the rows folded into what each variant holds, by the id of the characteristic
function foldHeld(rows: readonly HeldRow[]): Map<number, Map<number, HeldValue>> {
  const byVariant = new Map<number, Map<number, HeldValue>>();

  for (const row of rows) {
    const held = byVariant.get(row.variantId) ?? new Map<number, HeldValue>();
    byVariant.set(row.variantId, held);

    switch (row.attribute.type) {
      case 'text':
        held.set(row.attributeId, { type: 'text', text: row.textValue! });
        break;
      case 'number':
        held.set(row.attributeId, { type: 'number', number: new Prisma.Decimal(row.numberValue!) });
        break;
      case 'boolean':
        held.set(row.attributeId, { type: 'boolean', bool: row.boolValue! });
        break;
      default: {
        const had = held.get(row.attributeId);
        if (had && (had.type === 'option' || had.type === 'options')) {
          had.optionIds.push(row.optionId!);
        } else {
          held.set(row.attributeId, { type: row.attribute.type, optionIds: [row.optionId!] });
        }
      }
    }
  }

  return byVariant;
}

// what the variants hold now, by the id of the variant and of the characteristic
export async function readHeldValues(
  tx: Tx,
  variantIds: readonly number[],
): Promise<Map<number, Map<number, HeldValue>>> {
  if (!variantIds.length) return new Map();

  const rows = await tx.variantAttributeValue.findMany({
    where: { variantId: { in: [...variantIds] } },
    select: heldSelect,
    orderBy: [{ variantId: 'asc' }, { attributeId: 'asc' }, { optionId: 'asc' }],
  });

  return foldHeld(rows);
}

// a value as the admin log writes it
export function rawOf(value: HeldValue | null): unknown {
  if (value === null) return null;

  switch (value.type) {
    case 'text':
      return value.text;
    case 'number':
      return Number(value.number.toString());
    case 'boolean':
      return value.bool;
    case 'option':
      return value.optionIds[0];
    default:
      return value.optionIds;
  }
}

function sameValue(a: HeldValue, b: HeldValue): boolean {
  switch (a.type) {
    case 'text':
      return b.type === 'text' && a.text === b.text;
    case 'number':
      return b.type === 'number' && a.number.equals(b.number);
    case 'boolean':
      return b.type === 'boolean' && a.bool === b.bool;
    default:
      return (
        (b.type === 'option' || b.type === 'options') &&
        a.optionIds.length === b.optionIds.length &&
        a.optionIds.every((id, at) => id === b.optionIds[at])
      );
  }
}

// the columns a value fills
const columnsOf = (value: HeldValue) =>
  value.type === 'text'
    ? { textValue: value.text }
    : value.type === 'number'
      ? { numberValue: value.number }
      : value.type === 'boolean'
        ? { boolValue: value.bool }
        : {};

// Writes what changes of the values of a variant, the way a value is changed: the row of a text, a
// number, yes/no or a choice is changed in place, the rows of a set are added and taken away one by
// one. Gives the lines of the admin log of the variant (one for each characteristic that changed,
// field `attribute.<id>`). The caller holds the lock of the variant; what the variant holds is read
// by the caller (readHeldValues)
export async function writeValues(
  tx: Tx,
  variantId: number,
  held: ReadonlyMap<number, HeldValue>,
  resolved: ReadonlyArray<ResolvedValue>,
): Promise<AuditChange[]> {
  const changes: AuditChange[] = [];
  // the rows to make are written in one query
  const made: Array<Prisma.VariantAttributeValueCreateManyInput> = [];

  for (const item of [...resolved].sort((a, b) => a.attributeId - b.attributeId)) {
    const { attributeId } = item;
    const had = held.get(attributeId) ?? null;
    const next = item.value;
    const line = { field: `attribute.${attributeId}`, old: rawOf(had), new: rawOf(next) };

    if (next === null) {
      if (!had) continue;

      await tx.variantAttributeValue.deleteMany({ where: { variantId, attributeId } });
      changes.push(line);
      continue;
    }

    if (had && sameValue(had, next)) continue;

    if (next.type === 'options') {
      const before = had && had.type === 'options' ? had.optionIds : [];
      const gone = before.filter((id) => !next.optionIds.includes(id));
      const added = next.optionIds.filter((id) => !before.includes(id));

      if (gone.length) {
        await tx.variantAttributeValue.deleteMany({
          where: { variantId, attributeId, optionId: { in: gone } },
        });
      }
      for (const optionId of added) made.push({ variantId, attributeId, optionId });
    } else if (had) {
      // one row for a value: it is changed in place
      await tx.variantAttributeValue.updateMany({
        where: { variantId, attributeId },
        data: next.type === 'option' ? { optionId: next.optionIds[0]! } : columnsOf(next),
      });
    } else {
      made.push({
        variantId,
        attributeId,
        ...(next.type === 'option' ? { optionId: next.optionIds[0]! } : columnsOf(next)),
      });
    }

    changes.push(line);
  }

  if (made.length) await tx.variantAttributeValue.createMany({ data: made });

  return changes;
}

// ---- the rules over the whole product ----

// the variant of a request the rule is about: a variant that is not written yet is named by its
// place in the request (`index`), one that is there by its id
export type VariantRef = { index: number } | { variantId: number };

export type TouchedVariant = {
  variantId: number;
  productId: number;
  categoryId: number;
  ref: VariantRef;
};

// What a request that wrote values leaves the variants it touched with. The characteristics the
// category of the product asks (its own and its parents') must each have a value, so a variant of a
// category that asks for the colour is never left without one: 400 ATTRIBUTE_REQUIRED (details:
// `attributes` the missing ones, `variants` each variant with its `attributeIds`). A requirement
// added to the category later breaks no variant: only a variant whose values were written is
// checked (required: false skips it, for a restore). Then no live variant of the product has the
// same values of all the characteristics as another (409 VARIANT_DUPLICATE). Called after the rows
// are written, in the transaction that holds the lock of the product: it throws, the transaction
// rolls back
export async function assertValuesAccepted(
  tx: Tx,
  touched: readonly TouchedVariant[],
  opts: { required: boolean; single?: boolean },
): Promise<void> {
  if (!touched.length) return;

  if (opts.required) await assertRequired(tx, touched);
  await assertNoDuplicates(tx, touched, opts.single ?? false);
}

async function assertRequired(tx: Tx, touched: readonly TouchedVariant[]): Promise<void> {
  const rows = await tx.variantAttributeValue.findMany({
    where: { variantId: { in: touched.map((item) => item.variantId) } },
    select: { variantId: true, attributeId: true },
  });
  const held = new Map<number, Set<number>>();
  for (const row of rows) {
    const set = held.get(row.variantId) ?? new Set<number>();
    held.set(row.variantId, set);
    set.add(row.attributeId);
  }

  const requiredOf = new Map<number, Array<{ id: number; name: string }>>();
  const missingAttributes = new Map<number, string>();
  const variants: Array<VariantRef & { attributeIds: number[] }> = [];

  for (const item of touched) {
    if (!requiredOf.has(item.categoryId)) {
      requiredOf.set(item.categoryId, await requiredAttributesOf(tx, item.categoryId));
    }

    const missing = requiredOf
      .get(item.categoryId)!
      .filter((attribute) => !held.get(item.variantId)?.has(attribute.id));
    if (!missing.length) continue;

    for (const attribute of missing) missingAttributes.set(attribute.id, attribute.name);
    variants.push({ ...item.ref, attributeIds: missing.map((attribute) => attribute.id) });
  }

  if (variants.length) {
    throw new BadRequestError('ATTRIBUTE_REQUIRED', {
      attributes: [...missingAttributes]
        .sort(([a], [b]) => a - b)
        .map(([id, name]) => ({ id, name })),
      variants,
    });
  }
}

// the values of a variant as one text that two variants share only when they have the same values
// of all the characteristics (rows in the order of the characteristic and of the value)
const signatureOf = (
  rows: ReadonlyArray<{
    attributeId: number;
    textValue: string | null;
    numberValue: Prisma.Decimal | null;
    boolValue: boolean | null;
    optionId: number | null;
  }>,
): string =>
  JSON.stringify(
    rows.map((row) => [
      row.attributeId,
      row.textValue !== null
        ? ['t', row.textValue]
        : row.numberValue !== null
          ? ['n', new Prisma.Decimal(row.numberValue).toFixed()]
          : row.boolValue !== null
            ? ['b', row.boolValue]
            : ['o', row.optionId],
    ]),
  );

async function assertNoDuplicates(
  tx: Tx,
  touched: readonly TouchedVariant[],
  single: boolean,
): Promise<void> {
  const refOf = new Map(touched.map((item) => [item.variantId, item.ref]));
  const byProduct = new Map<number, TouchedVariant[]>();
  for (const item of touched) {
    byProduct.set(item.productId, [...(byProduct.get(item.productId) ?? []), item]);
  }

  const entries: Array<VariantRef & { sameAs: VariantRef[] }> = [];
  let first: number | undefined;

  for (const [productId, items] of [...byProduct].sort(([a], [b]) => a - b)) {
    const live = await tx.productVariant.findMany({
      where: { productId, deletedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const rows = await tx.variantAttributeValue.findMany({
      where: { variantId: { in: live.map((row) => row.id) } },
      select: {
        variantId: true,
        attributeId: true,
        textValue: true,
        numberValue: true,
        boolValue: true,
        optionId: true,
      },
      orderBy: [{ variantId: 'asc' }, { attributeId: 'asc' }, { optionId: 'asc' }],
    });

    const rowsOf = new Map<number, typeof rows>();
    for (const row of rows) rowsOf.set(row.variantId, [...(rowsOf.get(row.variantId) ?? []), row]);

    const signatures = new Map(live.map((row) => [row.id, signatureOf(rowsOf.get(row.id) ?? [])]));
    const sharing = new Map<string, number[]>();
    for (const [id, signature] of signatures) {
      sharing.set(signature, [...(sharing.get(signature) ?? []), id]);
    }

    for (const item of items) {
      const signature = signatures.get(item.variantId);
      if (signature === undefined) continue;

      const peers = sharing.get(signature)!.filter((id) => id !== item.variantId);
      if (!peers.length) continue;

      first ??= peers.find((id) => !refOf.has(id)) ?? peers[0];
      entries.push({
        ...item.ref,
        sameAs: peers.map((id) => refOf.get(id) ?? { variantId: id }),
      });
    }
  }

  if (entries.length) {
    throw new ConflictError('VARIANT_DUPLICATE', {
      ...(single && first !== undefined ? { variantId: first } : {}),
      variants: entries,
    });
  }
}
