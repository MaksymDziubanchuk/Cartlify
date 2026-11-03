import type { WithdrawalRuleName } from '@helpers/withdrawal.js';
import type { CategoryId, IdParam, UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';
import type { ProductImagesUrls } from './products.dto.js';

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
  // the picture of the category in three sizes, null without one
  imageUrls: ProductImagesUrls | null;
  // the rule of withdrawal its products follow while they have none of their own; null follows the
  // category above it
  withdrawal: WithdrawalRuleName | null;
  // only in the answer of a change of the rule: how many live products took another rule by it
  affectedProducts?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoriesListResponseDto {
  items: CategoryResponseDto[];
  limit: number;
  nextCursor?: string;
}

// a category of the tree with the categories below it; productCount counts the products of the
// catalog of its whole branch
export interface CategoryTreeNodeDto {
  id: CategoryId;
  name: string;
  slug: string;
  imageUrls: ProductImagesUrls | null;
  productCount: number;
  children: CategoryTreeNodeDto[];
}

export interface CategoryTreeResponseDto {
  items: CategoryTreeNodeDto[];
}

export interface CreateCategoryBodyDto {
  name: string;
  slug: string;
  description?: string;
  parentId?: CategoryId;
  // one of the rules of withdrawal, or none (the category follows the one above); checked by the service
  withdrawal?: string | null;
}

export interface CreateCategoryDto extends CreateCategoryBodyDto {
  actorId: UserId;
  actorRole: Role;
}

export type CreateCategoryResponseDto = CategoryResponseDto;

export interface UpdateCategoryParamsDto {
  categoryId: IdParam;
}

export interface UpdateCategoryBodyDto {
  name?: string;
  slug?: string;
  description?: string;
  parentId?: CategoryId;
  // one of the rules, or null (empty) to follow the category above; checked by the service
  withdrawal?: string | null;
}

export interface UpdateCategoryDto extends UpdateCategoryBodyDto {
  categoryId: CategoryId;
  actorId: UserId;
  actorRole: Role;
}

export type UpdateCategoryResponseDto = CategoryResponseDto;

export interface DeleteCategoryParamsDto {
  categoryId: IdParam;
}

export interface DeleteCategoryDto {
  categoryId: CategoryId;
  actorId: UserId;
  actorRole: Role;
}

// the picture of a category in its form part: the stream is read while the request is parsed
export interface CategoryImagePart {
  file: NodeJS.ReadableStream;
  mimetype: string;
  filename?: string;
}

// a picture waiting on Cloudinary under an id of its own until the category is written
export interface UploadedCategoryImage {
  publicId: string;
}

export interface CategoryImageParamsDto {
  categoryId: IdParam;
}

export interface DeleteCategoryResponseDto {
  message: string;
}
