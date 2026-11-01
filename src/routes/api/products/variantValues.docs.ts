// The texts of the Swagger of the routes that write the values of the characteristics of variants
// (POST /api/products, the routes of the variants): the refusals they share, in the form
// "CODE: why" that the contract tests read

// the codes the values of the characteristics of a variant are refused with
export const VALUE_CODES =
  'ATTRIBUTE_VALUE_INVALID, ATTRIBUTE_VALUE_TOO_PRECISE, ATTRIBUTE_VALUE_TOO_SMALL, ' +
  'ATTRIBUTE_VALUE_TOO_LARGE, ATTRIBUTE_OPTION_NOT_FOUND, ATTRIBUTE_VALUES_REPEATED, ' +
  'ATTRIBUTE_VALUES_TOO_MANY, VARIANT_ATTRIBUTES_INVALID, VARIANT_ATTRIBUTES_REPEATED';

export const VALUES_400 =
  ' The values of the characteristics (`attributes`): ATTRIBUTE_VALUE_INVALID (the wrong kind for the type, `details.type`), ATTRIBUTE_VALUE_TOO_PRECISE (`details.bound` is the digits after the point the characteristic has), ATTRIBUTE_VALUE_TOO_SMALL and ATTRIBUTE_VALUE_TOO_LARGE (`details.bound`, `details.value`), ATTRIBUTE_OPTION_NOT_FOUND (a value of the list of another characteristic, `details.optionIds`), ATTRIBUTE_VALUES_REPEATED, ATTRIBUTE_VALUES_TOO_MANY (`details.max`, `details.have`), VARIANT_ATTRIBUTES_INVALID, VARIANT_ATTRIBUTES_REPEATED (`details.attributeIds`); each carries `details.attributeId` and `details.attributeName`.';

// in a request that makes variants the same codes come inside VARIANTS_INVALID, for each variant
// by its `index` (`details.variants`)
export const VALUES_400_WRAPPED =
  ' VARIANTS_INVALID also names a variant whose values are wrong, with its own `errorCode` among ' +
  'ATTRIBUTE_VALUE_INVALID, ATTRIBUTE_VALUE_TOO_PRECISE, ATTRIBUTE_VALUE_TOO_SMALL, ATTRIBUTE_VALUE_TOO_LARGE, ATTRIBUTE_OPTION_NOT_FOUND, ATTRIBUTE_VALUES_REPEATED, ATTRIBUTE_VALUES_TOO_MANY, VARIANT_ATTRIBUTES_INVALID, VARIANT_ATTRIBUTES_REPEATED' +
  ' (`details.attributeId`, `details.bound`, `details.value`).';

export const REQUIRED_400 =
  " ATTRIBUTE_REQUIRED: a characteristic the category of the product asks as required (its own and the parents') has no value in a variant that is made or whose values change (`details.attributes` the missing ones, `details.variants` each variant with its `attributeIds`, by `index` or by `variantId`).";

export const NOT_FOUND_ATTRIBUTE =
  ' ATTRIBUTE_NOT_FOUND: a characteristic of `attributes` is not in the directory (`details.attributeIds`, every one that is missing).';

export const DUPLICATE_409 =
  ' VARIANT_DUPLICATE: a live variant of the product would have the same values of all the characteristics as another (a variant with no values repeats another with none; the ones taken out of sale do not count): `details.variants` names each such variant, by `index` (not made yet) or `variantId`, with the ones it repeats in `sameAs`; for one variant `details.variantId` is the variant that has the values already. Nothing is changed.';

// the name of a variant of the examples: the product, a dash (written as an escape, the sources are
// plain ASCII) and the value that tells it from the others
export const EXAMPLE_VARIANT_NAME = 'Wireless headphones \u2014 black';

// the characteristics that tell the variants of a product apart, as the short variant lists them
export const EXAMPLE_VARIANT_VALUES = [{ attributeId: 12, name: 'Colour', value: 'black' }];

// every characteristic a variant has, as the full variant lists them: by the groups of the card
export const EXAMPLE_VARIANT_ATTRIBUTES = [
  {
    group: { id: 2, name: 'Look', position: 1 },
    items: [
      {
        attribute: { id: 12, name: 'Colour', unit: null, type: 'option', isMain: true },
        value: 'black',
        raw: 41,
        colorCode: '#000000',
      },
    ],
  },
  {
    group: { id: 3, name: 'Battery', position: 2 },
    items: [
      {
        attribute: { id: 15, name: 'Battery life', unit: 'h', type: 'number', isMain: false },
        value: '30 h',
        raw: 30,
      },
    ],
  },
];
