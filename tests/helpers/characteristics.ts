import {
  createAttribute,
  createAttributeOption,
  createProduct,
  createVariant,
  createVariantValue,
  type TestAttribute,
  type TestProduct,
  type TestValue,
} from './factories.js';

// helpers of the tests of the catalog by characteristics: lists grouped by the main ones, the filter
// `f` and the panel of the filter

// a characteristic of a choice with its values made in the order given (their places follow it)
export type TestChoice = {
  attribute: TestAttribute;
  // the id of a value by its name
  option: Record<string, number>;
};

export async function createChoice(
  names: string[],
  opts: { name?: string; isMain?: boolean; inFilters?: boolean; type?: 'option' | 'options' } = {},
): Promise<TestChoice> {
  const attribute = await createAttribute({
    type: opts.type ?? 'option',
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.isMain !== undefined ? { isMain: opts.isMain } : {}),
    ...(opts.inFilters !== undefined ? { inFilters: opts.inFilters } : {}),
  });

  const option: Record<string, number> = {};
  for (const name of names) option[name] = (await createAttributeOption(attribute.id, { name })).id;

  return { attribute, option };
}

// what a variant of a test holds of a characteristic: the id of the characteristic and its value
export type VariantValue = { attributeId: number; value: TestValue };

export type VariantSpec = {
  price?: number;
  stock?: number;
  values?: VariantValue[];
};

export const choose = (choice: TestChoice, name: string): VariantValue => ({
  attributeId: choice.attribute.id,
  value: { optionId: choice.option[name]! },
});

export const numberOf = (attribute: TestAttribute, number: number): VariantValue => ({
  attributeId: attribute.id,
  value: { number },
});

export const answerOf = (attribute: TestAttribute, bool: boolean): VariantValue => ({
  attributeId: attribute.id,
  value: { bool },
});

// a product with its variants in the order given (their places follow it), each with the values
// given; the first variant comes with the product
export async function createProductWith(
  categoryId: number,
  specs: VariantSpec[],
  opts: { name?: string } = {},
): Promise<{ product: TestProduct; variantIds: number[] }> {
  const [first, ...rest] = specs;
  const product = await createProduct({
    categoryId,
    price: first?.price ?? 10,
    stock: first?.stock ?? 5,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  });

  const variantIds = [product.variantId];
  for (const spec of rest) {
    const variant = await createVariant(product.id, {
      price: spec.price ?? 10,
      stock: spec.stock ?? 5,
    });
    variantIds.push(variant.id);
  }

  for (const [index, spec] of specs.entries()) {
    for (const { attributeId, value } of spec.values ?? []) {
      await createVariantValue(variantIds[index]!, attributeId, value);
    }
  }

  return { product, variantIds };
}

// A main characteristic of the file with a value for every place: a test that makes a product with
// several variants and wants each in a row of its own (the variants of a product with the same main
// values are one row) gives each a value of it
const APART_VALUES = 30;
let apart: Promise<TestChoice> | undefined;

const rowsApart = (): Promise<TestChoice> =>
  (apart ??= createChoice(
    Array.from({ length: APART_VALUES }, (_, index) => `row ${index + 1}`),
    { isMain: true },
  ));

// gives the variants, in the order given, values of the main characteristic that differ: no two of
// them merge into one row of a list of groups
export async function keepApart(variantIds: readonly number[]): Promise<void> {
  const choice = await rowsApart();

  for (const [index, variantId] of variantIds.entries()) {
    await createVariantValue(variantId, choice.attribute.id, {
      optionId: choice.option[`row ${index + 1}`]!,
    });
  }
}
