import type { CategoryId, UserId } from 'types/ids.js';
import type { User, Role } from 'types/user.js';

export interface GetAllCategoriesQueryDto {
  limit?: number;
  cursor?: string;

  search?: string;
  parentId?: CategoryId;
}

export interface FindAllCategoriesDto {
  limit: number;
  cursor?: string;

  search?: string;
  parentId?: CategoryId;
}

export interface CategoryResponseDto {
  id: CategoryId;
  name: string;
  slug?: string;
  description?: string;
  parentId?: CategoryId;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoriesListResponseDto {
  items: CategoryResponseDto[];
  limit: number;
  nextCursor?: string;
}

export interface CreateCategoryBodyDto {
  name: string;
  slug: string;
  description?: string;
  parentId?: CategoryId;
}

export interface CreateCategoryDto extends CreateCategoryBodyDto {
  actorId: UserId;
  actorRole: Role;
}

export type CreateCategoryResponseDto = CategoryResponseDto;

export interface UpdateCategoryParamsDto {
  categoryId: CategoryId;
}

export interface UpdateCategoryBodyDto {
  name?: string;
  slug?: string;
  description?: string;
  parentId?: CategoryId;
}

export interface UpdateCategoryDto extends UpdateCategoryBodyDto {
  categoryId: CategoryId;
  actorId: UserId;
  actorRole: Role;
}

export type UpdateCategoryResponseDto = CategoryResponseDto;

export interface DeleteCategoryParamsDto {
  categoryId: CategoryId;
}

export interface DeleteCategoryDto extends DeleteCategoryParamsDto {
  actorId: UserId;
  actorRole: Role;
}

export interface DeleteCategoryResponseDto {
  message: string;
}
