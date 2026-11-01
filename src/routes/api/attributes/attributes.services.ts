import {
  createAttributeGroup,
  deleteAttributeGroup,
  listAttributeGroups,
  reorderAttributeGroups,
  updateAttributeGroup,
} from './services/attributeGroups.service.js';
import {
  createAttribute,
  deleteAttribute,
  getAttribute,
  listAttributes,
  reorderGroupAttributes,
  updateAttribute,
} from './services/attributes.service.js';
import {
  createAttributeOption,
  deleteAttributeOption,
  listAttributeOptions,
  reorderAttributeOptions,
  replaceAttributeOption,
  updateAttributeOption,
} from './services/attributeOptions.service.js';

import {
  getCategoryAttributes,
  setCategoryAttributes,
} from './services/categoryAttributes.service.js';

export const attributesServices = {
  getCategoryAttributes,
  setCategoryAttributes,
  createAttributeGroup,
  deleteAttributeGroup,
  listAttributeGroups,
  reorderAttributeGroups,
  updateAttributeGroup,
  createAttribute,
  deleteAttribute,
  getAttribute,
  listAttributes,
  reorderGroupAttributes,
  updateAttribute,
  createAttributeOption,
  deleteAttributeOption,
  listAttributeOptions,
  reorderAttributeOptions,
  replaceAttributeOption,
  updateAttributeOption,
};
