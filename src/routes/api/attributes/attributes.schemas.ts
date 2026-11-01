import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { MAX_ATTRIBUTE_OPTIONS } from '@config/limits.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

// the Swagger of the directory of characteristics: for an admin or a root, under /api/admin. Each
// answer names the codes the route gives in the form "`CODE`: why", the contract tests check them

const error = (description: string) => ({ description, $ref: 'errorResponseSchema#' });

const common = {
  401: error('Authentication is required.'),
  403: error('Only an admin or a root keeps the directory of characteristics.'),
  500: error('Unexpected server error.'),
};

const orderMismatch =
  '`ORDER_IDS_MISMATCH`: the list leaves a row of the scope out, names one that is not of it, or ' +
  'names one twice (`details`: `missing`, `unknown`, `repeated`).';

const groupExample = { id: 2, name: 'Screen', position: 2, attributesCount: 5 };
const optionExample = {
  id: 14,
  attributeId: 6,
  name: 'black',
  position: 1,
  colorCode: '#000000',
  createdAt: '2026-10-31T10:00:00.000Z',
  updatedAt: '2026-10-31T10:00:00.000Z',
};
const attributeExample = {
  id: 6,
  name: 'Colour',
  type: 'option',
  unit: null,
  groupId: 1,
  group: { id: 1, name: 'General' },
  position: 1,
  isMain: true,
  inFilters: true,
  decimals: null,
  minValue: null,
  maxValue: null,
  createdAt: '2026-10-31T10:00:00.000Z',
  updatedAt: '2026-10-31T10:00:00.000Z',
};

const idParams = (ref: string, example: Record<string, string>) => ({
  $ref: ref,
  examples: [example],
});

const postGroup = {
  operationId: 'createAttributeGroup',
  summary: 'Create a group of characteristics',
  description:
    'A group is a section of the tab of the characteristics of a card ("Screen", "Memory"). The ' +
    'new group goes to the end of the others; one name is one group, letter case ignored.',
  body: { $ref: 'attributeGroupCreateBodySchema#', examples: [{ name: 'Screen' }] },
  response: {
    201: {
      description: 'The group was created.',
      $ref: 'attributeGroupResponseSchema#',
      examples: [groupExample],
    },
    400: error(
      '`ATTRIBUTE_GROUP_FIELDS_INVALID`: the name is blank or too long (`details.fields`).',
    ),
    409: error('`ATTRIBUTE_GROUP_NAME_TAKEN`: another group has the name (`details.groupId`).'),
    ...common,
  },
} satisfies FastifySchema;

const getGroups = {
  operationId: 'getAttributeGroups',
  summary: 'Get the groups of characteristics',
  description:
    'All the groups in the order of the card, each with how many characteristics it has.',
  response: {
    200: {
      description: 'The groups.',
      $ref: 'attributeGroupsListResponseSchema#',
      examples: [{ items: [groupExample] }],
    },
    ...common,
  },
} satisfies FastifySchema;

const putGroupsOrder = {
  operationId: 'orderAttributeGroups',
  summary: 'Order the groups of characteristics',
  description:
    'Writes a new order of all the groups: the ids of every group, once, in the order wanted. The ' +
    'answer is the groups in it.',
  body: { $ref: 'attributeOrderBodySchema#', examples: [{ ids: [2, 1, 3] }] },
  response: {
    200: {
      description: 'The groups in the new order.',
      $ref: 'attributeGroupsListResponseSchema#',
    },
    400: error(orderMismatch),
    ...common,
  },
} satisfies FastifySchema;

const patchGroup = {
  operationId: 'updateAttributeGroup',
  summary: 'Rename a group of characteristics',
  description: 'Changes the name of a group; the name it has already is 200 with nothing written.',
  params: idParams('attributeGroupParamsSchema#', { groupId: '2' }),
  body: { $ref: 'attributeGroupUpdateBodySchema#', examples: [{ name: 'Display' }] },
  response: {
    200: {
      description: 'The group.',
      $ref: 'attributeGroupResponseSchema#',
      examples: [groupExample],
    },
    400: error(
      '`NO_FIELDS_TO_UPDATE`: no name; `ATTRIBUTE_GROUP_FIELDS_INVALID`: the name is blank or too long.',
    ),
    404: error('`ATTRIBUTE_GROUP_NOT_FOUND`: there is no such group.'),
    409: error('`ATTRIBUTE_GROUP_NAME_TAKEN`: another group has the name (`details.groupId`).'),
    ...common,
  },
} satisfies FastifySchema;

const deleteGroup = {
  operationId: 'deleteAttributeGroup',
  summary: 'Delete a group of characteristics',
  description: 'Deletes a group that has no characteristics.',
  params: idParams('attributeGroupParamsSchema#', { groupId: '2' }),
  response: {
    200: { description: 'The group was deleted.', $ref: 'attributeDeleteResponseSchema#' },
    404: error('`ATTRIBUTE_GROUP_NOT_FOUND`: there is no such group.'),
    409: error(
      '`ATTRIBUTE_GROUP_IN_USE`: the group has characteristics (`details`: `attributeIds` of up to 20, `total`).',
    ),
    ...common,
  },
} satisfies FastifySchema;

const putAttributesOrder = {
  operationId: 'orderGroupAttributes',
  summary: 'Order the characteristics of a group',
  description:
    'Writes a new order of all the characteristics of a group: their ids, once, in the order ' +
    'wanted. The answer is the characteristics of the group in it.',
  params: idParams('attributeGroupParamsSchema#', { groupId: '2' }),
  body: { $ref: 'attributeOrderBodySchema#', examples: [{ ids: [8, 6, 7] }] },
  response: {
    200: {
      description: 'The characteristics in the new order.',
      $ref: 'attributesListResponseSchema#',
    },
    400: error(orderMismatch),
    404: error('`ATTRIBUTE_GROUP_NOT_FOUND`: there is no such group.'),
    ...common,
  },
} satisfies FastifySchema;

const postAttribute = {
  operationId: 'createAttribute',
  summary: 'Create a characteristic',
  description:
    'A characteristic of the directory ("Colour", "Memory") that a variant has a value of. It goes ' +
    'to the end of its group. A number has its digits after the point (0 when not said) and may ' +
    'have bounds; a main characteristic splits the products of a list into rows by its value and ' +
    'is a choice of one value, a number or yes/no.',
  body: {
    $ref: 'attributeCreateBodySchema#',
    examples: [{ name: 'Colour', type: 'option', groupId: 1, isMain: true }],
  },
  response: {
    201: {
      description: 'The characteristic was created.',
      $ref: 'attributeResponseSchema#',
      examples: [attributeExample],
    },
    400: error(
      '`ATTRIBUTE_FIELDS_INVALID`: a value is wrong, `details.fields` names it (a blank or long name, a long unit, ' +
        'digits or bounds on what is no number, digits over 3, bounds the wrong way round); ' +
        '`ATTRIBUTE_MAIN_NOT_ALLOWED`: a text or a set of values cannot be a main characteristic (`details.type`).',
    ),
    404: error('`ATTRIBUTE_GROUP_NOT_FOUND`: there is no such group.'),
    409: error(
      '`ATTRIBUTE_NAME_TAKEN`: another characteristic has the name (`details.attributeId`).',
    ),
    ...common,
  },
} satisfies FastifySchema;

const getAttributes = {
  operationId: 'getAttributes',
  summary: 'Get the characteristics',
  description:
    'The characteristics in the order of the card (group, then place), with how many values each ' +
    'has. `q` finds a part of the name.',
  querystring: { $ref: 'attributesListQuerySchema#' },
  response: {
    200: { description: 'The characteristics.', $ref: 'attributesListResponseSchema#' },
    ...common,
  },
} satisfies FastifySchema;

const getAttribute = {
  operationId: 'getAttribute',
  summary: 'Get a characteristic',
  description:
    'A characteristic with its values in their order and how many categories ask for it.',
  params: idParams('attributeParamsSchema#', { attributeId: '6' }),
  response: {
    200: { description: 'The characteristic.', $ref: 'attributeDetailResponseSchema#' },
    404: error('`ATTRIBUTE_NOT_FOUND`: there is no such characteristic.'),
    ...common,
  },
} satisfies FastifySchema;

const patchAttribute = {
  operationId: 'updateAttribute',
  summary: 'Change a characteristic',
  description:
    'Changes what is named. A new group puts the characteristic at its end. A type changes only ' +
    'while no values of a choice would be left without a choice (and, with the variants, while the ' +
    "characteristic has no values); a number's settings go with its type.",
  params: idParams('attributeParamsSchema#', { attributeId: '6' }),
  body: { $ref: 'attributeUpdateBodySchema#', examples: [{ inFilters: false }] },
  response: {
    200: {
      description: 'The characteristic.',
      $ref: 'attributeResponseSchema#',
      examples: [attributeExample],
    },
    400: error(
      '`NO_FIELDS_TO_UPDATE`: nothing named; `ATTRIBUTE_FIELDS_INVALID` and `ATTRIBUTE_MAIN_NOT_ALLOWED` as when it is created.',
    ),
    404: error(
      '`ATTRIBUTE_NOT_FOUND`: there is no such characteristic; `ATTRIBUTE_GROUP_NOT_FOUND`: no such group.',
    ),
    409: error(
      '`ATTRIBUTE_NAME_TAKEN`: another characteristic has the name (`details.attributeId`); ' +
        '`ATTRIBUTE_TYPE_LOCKED`: the type cannot change while a variant has a value of it (`details.reason`: variants, `details.variantsCount`, `details.productsTotal`, `details.productIds` of up to 20) or the characteristic has values of a choice (`details.reason`: options, `details.optionsCount`).',
    ),
    ...common,
  },
} satisfies FastifySchema;

const deleteAttribute = {
  operationId: 'deleteAttribute',
  summary: 'Delete a characteristic',
  description:
    'Deletes a characteristic with its values; one that a category asks for, or that a variant has a value of, stays.',
  params: idParams('attributeParamsSchema#', { attributeId: '6' }),
  response: {
    200: { description: 'The characteristic was deleted.', $ref: 'attributeDeleteResponseSchema#' },
    404: error('`ATTRIBUTE_NOT_FOUND`: there is no such characteristic.'),
    409: error(
      '`ATTRIBUTE_IN_USE`: a category asks for it (`details`: `categoryIds` of up to 20, `total`), or a variant has a value of it (`details`: `productIds` of up to 20, `productsTotal`, `variantsCount`); both reasons come together when both are there.',
    ),
    ...common,
  },
} satisfies FastifySchema;

const postOption = {
  operationId: 'createAttributeOption',
  summary: 'Create a value of a characteristic',
  description:
    'A value of a characteristic that is a choice ("black", "XL"), at the end of the others, up to ' +
    `${MAX_ATTRIBUTE_OPTIONS} of them. A colour is #RRGGBB, for a swatch on the storefront.`,
  params: idParams('attributeParamsSchema#', { attributeId: '6' }),
  body: {
    $ref: 'attributeOptionCreateBodySchema#',
    examples: [{ name: 'black', colorCode: '#000000' }],
  },
  response: {
    201: {
      description: 'The value was created.',
      $ref: 'attributeOptionResponseSchema#',
      examples: [optionExample],
    },
    400: error(
      '`ATTRIBUTE_OPTION_FIELDS_INVALID`: the name or the colour is wrong (`details.fields`); ' +
        '`ATTRIBUTE_OPTIONS_NOT_ALLOWED`: only a choice has values (`details.type`); ' +
        '`ATTRIBUTE_OPTIONS_TOO_MANY`: the characteristic has the most it may (`details.max`).',
    ),
    404: error('`ATTRIBUTE_NOT_FOUND`: there is no such characteristic.'),
    409: error(
      '`ATTRIBUTE_OPTION_NAME_TAKEN`: another value of it has the name (`details.optionId`).',
    ),
    ...common,
  },
} satisfies FastifySchema;

const getOptions = {
  operationId: 'getAttributeOptions',
  summary: 'Get the values of a characteristic',
  description: 'The values of a characteristic in their order.',
  params: idParams('attributeParamsSchema#', { attributeId: '6' }),
  response: {
    200: { description: 'The values.', $ref: 'attributeOptionsListResponseSchema#' },
    404: error('`ATTRIBUTE_NOT_FOUND`: there is no such characteristic.'),
    ...common,
  },
} satisfies FastifySchema;

const putOptionsOrder = {
  operationId: 'orderAttributeOptions',
  summary: 'Order the values of a characteristic',
  description:
    'Writes a new order of all the values of a characteristic: their ids, once, in the order wanted.',
  params: idParams('attributeParamsSchema#', { attributeId: '6' }),
  body: { $ref: 'attributeOrderBodySchema#', examples: [{ ids: [15, 14, 16] }] },
  response: {
    200: {
      description: 'The values in the new order.',
      $ref: 'attributeOptionsListResponseSchema#',
    },
    400: error(orderMismatch),
    404: error('`ATTRIBUTE_NOT_FOUND`: there is no such characteristic.'),
    ...common,
  },
} satisfies FastifySchema;

const patchOption = {
  operationId: 'updateAttributeOption',
  summary: 'Change a value of a characteristic',
  description:
    'Changes the name and the colour of a value; a rename breaks no filter, which holds the value by its id.',
  params: idParams('attributeOptionParamsSchema#', { attributeId: '6', optionId: '14' }),
  body: { $ref: 'attributeOptionUpdateBodySchema#', examples: [{ name: 'graphite' }] },
  response: {
    200: {
      description: 'The value.',
      $ref: 'attributeOptionResponseSchema#',
      examples: [optionExample],
    },
    400: error(
      '`NO_FIELDS_TO_UPDATE`: nothing named; `ATTRIBUTE_OPTION_FIELDS_INVALID`: the name or the colour is wrong.',
    ),
    404: error('`ATTRIBUTE_OPTION_NOT_FOUND`: the characteristic has no such value.'),
    409: error(
      '`ATTRIBUTE_OPTION_NAME_TAKEN`: another value of it has the name (`details.optionId`).',
    ),
    ...common,
  },
} satisfies FastifySchema;

const postOptionReplace = {
  operationId: 'replaceAttributeOption',
  summary: 'Put a value of a characteristic in the place of another in the variants',
  description:
    'Puts the value in the place of another value of the same characteristic in every variant that ' +
    'has it (the ones taken out of sale too), for example "graphite" by "black". All of them or ' +
    'none. A variant that holds both values of a set just loses the old one. When two variants of ' +
    'a product would be left with the same values of all the characteristics, nothing changes and ' +
    'the answer lists them. The old value stays in the directory: delete it apart. The names of ' +
    'the variants follow at once; the orders that are confirmed keep theirs. A line ' +
    '(`attribute_option.replace`) says in the admin log how many variants changed.',
  params: idParams('attributeOptionParamsSchema#', { attributeId: '6', optionId: '14' }),
  body: { $ref: 'attributeOptionReplaceBodySchema#', examples: [{ withOptionId: 15 }] },
  response: {
    200: {
      description: 'How many variants changed (0 when no variant had the value).',
      $ref: 'attributeOptionReplaceResponseSchema#',
      examples: [{ updatedCount: 12 }],
    },
    400: error(
      '`ATTRIBUTE_OPTION_REPLACE_SAME`: the value is put in its own place; `ATTRIBUTE_OPTIONS_NOT_ALLOWED`: only a choice has values (`details.type`).',
    ),
    404: error(
      '`ATTRIBUTE_NOT_FOUND`: there is no such characteristic; `ATTRIBUTE_OPTION_NOT_FOUND`: the characteristic has no such value (`details.withOptionId` when the value to put in its place is the one that is missing).',
    ),
    409: error(
      '`VARIANT_DUPLICATE`: two variants of a product would have the same values (`details.variants`: each variant with the ones it would repeat, `variantId`).',
    ),
    ...common,
  },
} satisfies FastifySchema;

const deleteOption = {
  operationId: 'deleteAttributeOption',
  summary: 'Delete a value of a characteristic',
  description:
    'Deletes a value that no variant has. A value that a variant has stays: replace it first ' +
    '(POST .../options/{optionId}/replace).',
  params: idParams('attributeOptionParamsSchema#', { attributeId: '6', optionId: '14' }),
  response: {
    200: { description: 'The value was deleted.', $ref: 'attributeDeleteResponseSchema#' },
    404: error('`ATTRIBUTE_OPTION_NOT_FOUND`: the characteristic has no such value.'),
    409: error(
      '`ATTRIBUTE_OPTION_IN_USE`: a variant has the value (`details`: `variantsTotal`, `productsTotal`, `products`: up to 20 products with up to 20 of their variants each).',
    ),
    ...common,
  },
} satisfies FastifySchema;

const getCategoryAttributes = {
  operationId: 'getCategoryAttributes',
  summary: 'Get the characteristics a category asks for',
  description:
    'The set of the category: its own characteristics and those of the categories above it (a ' +
    'child has the set of its parents and adds its own; for one characteristic the nearest ' +
    'category decides), with which are required. In the order of the directory. A set is a hint ' +
    'to the form of the admin, not a ban: a characteristic outside it is allowed.',
  params: idParams('attributeCategoryParamsSchema#', { categoryId: '2' }),
  response: {
    200: { description: 'The set of the category.', $ref: 'categoryAttributesResponseSchema#' },
    400: error('The id of the category is not a number.'),
    404: error('`CATEGORY_NOT_FOUND`: there is no such category.'),
    ...common,
  },
} satisfies FastifySchema;

const putCategoryAttributes = {
  operationId: 'setCategoryAttributes',
  summary: 'Write the characteristics a category asks for',
  description:
    'Writes the own set of the category whole: what is left out goes, what is new comes, a ' +
    'changed `required` is written. The ones of the parent categories are not listed. The same ' +
    'set as it was is 200 with nothing written. The answer is the set the category has now, the ' +
    'parent categories included.',
  params: idParams('attributeCategoryParamsSchema#', { categoryId: '2' }),
  body: {
    $ref: 'categoryAttributesBodySchema#',
    examples: [{ items: [{ attributeId: 6, required: true }, { attributeId: 8 }] }],
  },
  response: {
    200: { description: 'The set of the category.', $ref: 'categoryAttributesResponseSchema#' },
    400: error(
      'The body is wrong; `CATEGORY_ATTRIBUTES_REPEATED`: a characteristic is named twice (`details.attributeIds`).',
    ),
    404: error(
      '`CATEGORY_NOT_FOUND`: there is no such category; `ATTRIBUTE_NOT_FOUND`: a characteristic is not there (`details.attributeIds`).',
    ),
    409: error('`RESOURCE_BUSY`: another request wrote the set at the same time, come again.'),
    ...common,
  },
} satisfies FastifySchema;

const tagged = withOpenApiTag(
  {
    getCategoryAttributes,
    putCategoryAttributes,
    postGroup,
    getGroups,
    putGroupsOrder,
    patchGroup,
    deleteGroup,
    putAttributesOrder,
    postAttribute,
    getAttributes,
    getAttribute,
    patchAttribute,
    deleteAttribute,
    postOption,
    getOptions,
    putOptionsOrder,
    patchOption,
    postOptionReplace,
    deleteOption,
  },
  'attributes',
);

export const attributesSchema = withOpenApiSecurityFor(
  tagged,
  openApiSecurity.accessTokenCookie,
  Object.keys(tagged) as Array<keyof typeof tagged>,
);
