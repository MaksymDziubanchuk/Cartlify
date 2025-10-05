import type { CategoryId } from 'types/ids.js';

export interface GetAllCategoriesQueryDto {
  page?: number;
  limit?: number;
  search?: string;
  parentId?: CategoryId;
}

export interface FindAllCategoriesDto {
  page?: number;
  limit?: number;
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
  page?: number;
  limit?: number;
  total?: number;
}

export interface CreateCategoryBodyDto {
  name: string;
  slug?: string;
  description?: string;
  parentId?: CategoryId;
}

export type CreateCategoryDto = CreateCategoryBodyDto;

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
}

export type UpdateCategoryResponseDto = CategoryResponseDto;

export interface DeleteCategoryParamsDto {
  categoryId: CategoryId;
}

export interface DeleteCategoryDto {
  categoryId: CategoryId;
}

export interface DeleteCategoryResponseDto {
  message: string;
}
