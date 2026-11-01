import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';
import type { AttributeType } from '@helpers/attributeFields.js';

// the directory of characteristics: groups (sections of the tab of a card), characteristics, and
// the values of a characteristic that is a choice

export interface AttributeGroupDto {
  id: number;
  name: string;
  position: number;
  attributesCount: number;
}

export interface AttributeGroupsListResponseDto {
  items: AttributeGroupDto[];
}

export interface AttributeOptionDto {
  id: number;
  attributeId: number;
  name: string;
  position: number;
  colorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttributeOptionsListResponseDto {
  items: AttributeOptionDto[];
}

export interface AttributeDto {
  id: number;
  name: string;
  type: AttributeType;
  unit: string | null;
  groupId: number;
  group: { id: number; name: string };
  position: number;
  isMain: boolean;
  inFilters: boolean;
  decimals: number | null;
  minValue: number | null;
  maxValue: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttributeListItemDto extends AttributeDto {
  optionsCount: number;
}

export interface AttributesListResponseDto {
  items: AttributeListItemDto[];
  total: number;
}

export interface AttributeDetailDto extends AttributeDto {
  options: AttributeOptionDto[];
  // how many categories ask for the characteristic
  usage: { categories: number };
}

export interface GroupParamsDto {
  groupId: string;
}

export interface AttributeParamsDto {
  attributeId: string;
}

export interface OptionParamsDto {
  attributeId: string;
  optionId: string;
}

// a value of a characteristic put in the place of another of it in the variants
export interface ReplaceOptionBodyDto {
  withOptionId: number;
}

export interface ReplaceOptionResponseDto {
  // how many variants changed
  updatedCount: number;
}

export interface OrderBodyDto {
  ids: number[];
}

export interface AttributesListQueryDto {
  q?: string;
  groupId?: number;
  type?: AttributeType;
}

// the actor of a service call
export interface AttributeActorDto {
  actorId: UserId;
  actorRole: Role;
}

// a characteristic a category asks for: its own, or a parent's (inherited), the nearest category
// that asks for it deciding `required`
export interface CategoryAttributeDto {
  attribute: AttributeDto;
  required: boolean;
  // the category whose set the characteristic is in: this one or a parent
  categoryId: number;
  inherited: boolean;
}

export interface CategoryAttributesResponseDto {
  items: CategoryAttributeDto[];
}

export interface CategoryParamsDto {
  categoryId: string;
}
