import type {
  FindAllCategoriesDto,
  CreateCategoryDto,
  UpdateCategoryDto,
  DeleteCategoryDto,
} from 'types/dto/categories.dto.js';
import type { MessageResponseDto } from 'types/common.js';

import { createCategory } from './services/create.service.js';

async function findAll({
  page = 1,
  limit = 10,
  search,
  parentId,
}: FindAllCategoriesDto): Promise<MessageResponseDto> {
  return { message: 'categories list not implemented' };
}

async function update({
  categoryId,
  actorId,
  actorRole,
  name,
  slug,
  description,
  parentId,
}: UpdateCategoryDto): Promise<MessageResponseDto> {
  return { message: 'update category not implemented' };
}

async function remove({ categoryId }: DeleteCategoryDto): Promise<MessageResponseDto> {
  return { message: 'delete category not implemented' };
}

export const categoriesServices = {
  findAll,
  createCategory,
  update,
  remove,
};
