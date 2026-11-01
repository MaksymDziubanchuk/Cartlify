import {
  ATTRIBUTE_TYPES,
  CATEGORY_ATTRIBUTES_MAX,
  COLOR_PATTERN,
  DECIMALS_MAX,
  DIRECTORY_NAME_MAX,
  ORDER_IDS_MAX,
  UNIT_MAX,
} from '@helpers/attributeFields.js';
import { MAX_ID, idPathParam } from '@schemas/idPathParam.js';

// the names, the unit, the colour and the settings of a number are checked by the service, which
// names a wrong one with a code of its own and `details.fields`; the schemas hold the types and the
// enum of the types of a characteristic

const nameDescription = `The name, kept trimmed, up to ${DIRECTORY_NAME_MAX} signs, one in its scope with the letter case ignored.`;

const typeField = {
  type: 'string',
  enum: [...ATTRIBUTE_TYPES],
  description:
    'text, number, boolean (yes or no), option (one value of a list) or options (several of them).',
} as const;

const groupParams = {
  $id: 'attributeGroupParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: { groupId: idPathParam('the group') },
  required: ['groupId'],
} as const;

const attributeParams = {
  $id: 'attributeParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: { attributeId: idPathParam('the characteristic') },
  required: ['attributeId'],
} as const;

const optionParams = {
  $id: 'attributeOptionParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    attributeId: idPathParam('the characteristic'),
    optionId: idPathParam('the value'),
  },
  required: ['attributeId', 'optionId'],
} as const;

const idField = { type: 'integer', minimum: 1, maximum: MAX_ID } as const;

const orderBody = {
  $id: 'attributeOrderBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ids: {
      type: 'array',
      maxItems: ORDER_IDS_MAX,
      items: idField,
      description:
        'Every row of the scope once, in the new order; a list that leaves a row out, names one that is not ' +
        'of the scope or names one twice is 400 ORDER_IDS_MISMATCH with `details`.',
    },
  },
  required: ['ids'],
} as const;

const groupCreateBody = {
  $id: 'attributeGroupCreateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: { name: { type: 'string', description: nameDescription } },
  required: ['name'],
} as const;

const groupUpdateBody = {
  $id: 'attributeGroupUpdateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: { name: { type: 'string', description: nameDescription } },
} as const;

const groupResponse = {
  $id: 'attributeGroupResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    position: { type: 'integer', description: 'The place of the group in the card, from 1.' },
    attributesCount: { type: 'integer', description: 'How many characteristics it has.' },
  },
  required: ['id', 'name', 'position', 'attributesCount'],
} as const;

const groupsListResponse = {
  $id: 'attributeGroupsListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: { items: { type: 'array', items: { $ref: 'attributeGroupResponseSchema#' } } },
  required: ['items'],
} as const;

const settingsProperties = {
  unit: {
    type: ['string', 'null'],
    description: `A label of the value ("GB", "mm"), up to ${UNIT_MAX} signs; nothing is converted. null or blank is none.`,
  },
  isMain: {
    type: 'boolean',
    description:
      'A main characteristic splits the products of a list into rows by its value (a colour). Only a number, yes/no or a choice of one value can be one (ATTRIBUTE_MAIN_NOT_ALLOWED).',
  },
  inFilters: {
    type: 'boolean',
    description: 'A buyer may filter the catalog by it (a text never is). True when not said.',
  },
  decimals: {
    type: ['integer', 'null'],
    description: `A number: the digits after the point, 0 to ${DECIMALS_MAX} (0 when not said); no other type has them.`,
  },
  minValue: {
    type: ['number', 'null'],
    description: 'A number: the lowest value; no other type has it.',
  },
  maxValue: {
    type: ['number', 'null'],
    description: 'A number: the highest value, not below the lowest; no other type has it.',
  },
} as const;

const attributeCreateBody = {
  $id: 'attributeCreateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: nameDescription },
    type: typeField,
    groupId: {
      ...idField,
      description: 'The group of the characteristic (ATTRIBUTE_GROUP_NOT_FOUND).',
    },
    ...settingsProperties,
  },
  required: ['name', 'type', 'groupId'],
} as const;

const attributeUpdateBody = {
  $id: 'attributeUpdateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: nameDescription },
    type: {
      ...typeField,
      description:
        typeField.description +
        ' A type changes only while the characteristic has no values (ATTRIBUTE_TYPE_LOCKED).',
    },
    groupId: {
      ...idField,
      description: 'A new group: the characteristic goes to its end (ATTRIBUTE_GROUP_NOT_FOUND).',
    },
    ...settingsProperties,
  },
} as const;

const attributeFields = {
  id: { type: 'integer' },
  name: { type: 'string' },
  type: typeField,
  unit: { type: ['string', 'null'] },
  groupId: { type: 'integer' },
  group: {
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'integer' }, name: { type: 'string' } },
    required: ['id', 'name'],
  },
  position: { type: 'integer', description: 'The place in its group, from 1.' },
  isMain: { type: 'boolean' },
  inFilters: { type: 'boolean' },
  decimals: { type: ['integer', 'null'] },
  minValue: { type: ['number', 'null'] },
  maxValue: { type: ['number', 'null'] },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
} as const;

const attributeRequired = [
  'id',
  'name',
  'type',
  'unit',
  'groupId',
  'group',
  'position',
  'isMain',
  'inFilters',
  'decimals',
  'minValue',
  'maxValue',
  'createdAt',
  'updatedAt',
];

const attributeResponse = {
  $id: 'attributeResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: attributeFields,
  required: attributeRequired,
} as const;

const attributeListItem = {
  $id: 'attributeListItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...attributeFields,
    optionsCount: { type: 'integer', description: 'How many values of a choice it has.' },
  },
  required: [...attributeRequired, 'optionsCount'],
} as const;

const attributesListResponse = {
  $id: 'attributesListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'attributeListItemSchema#' } },
    total: { type: 'integer' },
  },
  required: ['items', 'total'],
} as const;

const attributesListQuery = {
  $id: 'attributesListQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 200, description: 'A part of the name, letter case ignored.' },
    groupId: { ...idField, description: 'Only the characteristics of this group.' },
    type: typeField,
  },
} as const;

const optionCreateBody = {
  $id: 'attributeOptionCreateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: nameDescription },
    colorCode: {
      type: ['string', 'null'],
      description: `For a swatch of a colour on the storefront: ${COLOR_PATTERN.source.replace('^', '').replace('$', '')} as #RRGGBB, kept in small letters.`,
    },
  },
  required: ['name'],
} as const;

const optionUpdateBody = {
  $id: 'attributeOptionUpdateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: optionCreateBody.properties,
} as const;

const optionReplaceBody = {
  $id: 'attributeOptionReplaceBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    withOptionId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description:
        'The value to put in its place: another value of the same characteristic (ATTRIBUTE_OPTION_NOT_FOUND otherwise).',
    },
  },
  required: ['withOptionId'],
} as const;

const optionReplaceResponse = {
  $id: 'attributeOptionReplaceResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    updatedCount: {
      type: 'integer',
      minimum: 0,
      description: 'How many variants changed (the ones taken out of sale too).',
    },
  },
  required: ['updatedCount'],
} as const;

const optionFields = {
  id: { type: 'integer' },
  attributeId: { type: 'integer' },
  name: { type: 'string' },
  position: { type: 'integer', description: 'The place among the values, from 1.' },
  colorCode: { type: ['string', 'null'] },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
} as const;

const optionResponse = {
  $id: 'attributeOptionResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: optionFields,
  required: ['id', 'attributeId', 'name', 'position', 'colorCode', 'createdAt', 'updatedAt'],
} as const;

const optionsListResponse = {
  $id: 'attributeOptionsListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: { items: { type: 'array', items: { $ref: 'attributeOptionResponseSchema#' } } },
  required: ['items'],
} as const;

const attributeDetailResponse = {
  $id: 'attributeDetailResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...attributeFields,
    options: { type: 'array', items: { $ref: 'attributeOptionResponseSchema#' } },
    usage: {
      type: 'object',
      additionalProperties: false,
      description: 'How many categories ask for the characteristic.',
      properties: { categories: { type: 'integer' } },
      required: ['categories'],
    },
  },
  required: [...attributeRequired, 'options', 'usage'],
} as const;

const deleteResponse = {
  $id: 'attributeDeleteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: { message: { type: 'string' } },
  required: ['message'],
} as const;

const categoryParams = {
  $id: 'attributeCategoryParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: { categoryId: idPathParam('the category') },
  required: ['categoryId'],
} as const;

const categoryAttributesBody = {
  $id: 'categoryAttributesBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      maxItems: CATEGORY_ATTRIBUTES_MAX,
      description: `The characteristics the category asks for itself, once each, up to ${CATEGORY_ATTRIBUTES_MAX}; the set is written whole, so one that is left out goes. The ones of the parent categories are not listed (they come with the child by themselves).`,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attributeId: { ...idField, description: 'The characteristic (ATTRIBUTE_NOT_FOUND).' },
          required: {
            type: 'boolean',
            description:
              'A variant must have a value of it (ATTRIBUTE_REQUIRED). False when not said.',
          },
        },
        required: ['attributeId'],
      },
    },
  },
  required: ['items'],
} as const;

const categoryAttributeItem = {
  $id: 'categoryAttributeItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    attribute: { $ref: 'attributeResponseSchema#' },
    required: { type: 'boolean' },
    categoryId: {
      type: 'integer',
      description: 'The category whose set it is in: this one or a parent.',
    },
    inherited: { type: 'boolean', description: 'True when a parent category asks for it.' },
  },
  required: ['attribute', 'required', 'categoryId', 'inherited'],
} as const;

const categoryAttributesResponse = {
  $id: 'categoryAttributesResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      description:
        'The set the category has, the parent categories included (the nearest category decides one characteristic), in the order of the directory: the group, then the place in it.',
      items: { $ref: 'categoryAttributeItemSchema#' },
    },
  },
  required: ['items'],
} as const;

export const attributesDtoSchemas = [
  categoryParams,
  categoryAttributesBody,
  categoryAttributeItem,
  categoryAttributesResponse,
  groupParams,
  attributeParams,
  optionParams,
  orderBody,
  groupCreateBody,
  groupUpdateBody,
  groupResponse,
  groupsListResponse,
  attributeCreateBody,
  attributeUpdateBody,
  attributeResponse,
  attributeListItem,
  attributesListResponse,
  attributesListQuery,
  optionCreateBody,
  optionUpdateBody,
  optionReplaceBody,
  optionReplaceResponse,
  optionResponse,
  optionsListResponse,
  attributeDetailResponse,
  deleteResponse,
];
