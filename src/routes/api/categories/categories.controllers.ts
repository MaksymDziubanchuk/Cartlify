import type { ControllerRouter } from 'types/controller.js';
import type { User } from 'types/user.js';
import type { MessageResponseDto } from 'types/common.js';
import type {
  GetAllCategoriesQueryDto,
  CategoriesListResponseDto,
  CategoryTreeResponseDto,
  FindAllCategoriesDto,
  CreateCategoryBodyDto,
  CreateCategoryDto,
  CreateCategoryResponseDto,
  UpdateCategoryParamsDto,
  UpdateCategoryBodyDto,
  UpdateCategoryDto,
  UpdateCategoryResponseDto,
  DeleteCategoryParamsDto,
  DeleteCategoryDto,
} from 'types/dto/categories.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { categoriesServices } from './categories.services.js';

const getCategories: ControllerRouter<
  {},
  {},
  GetAllCategoriesQueryDto,
  CategoriesListResponseDto
> = async (req, reply) => {
  const q = req.query;

  const limitRaw = q.limit != null ? Number(q.limit) : 50;
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 50;

  const cursor = typeof q.cursor === 'string' && q.cursor.trim() ? q.cursor.trim() : undefined;
  const search = typeof q.search === 'string' && q.search.trim() ? q.search.trim() : undefined;

  const parentIdRaw = q.parentId != null ? Number(q.parentId) : undefined;
  const parentId =
    parentIdRaw != null && Number.isInteger(parentIdRaw) && parentIdRaw > 0
      ? parentIdRaw
      : undefined;

  const args = pickDefined<FindAllCategoriesDto>({ limit }, { cursor, search, parentId });
  const result = await categoriesServices.findAllCategories(args);
  return reply.code(200).send(result);
};

const postCategory: ControllerRouter<
  {},
  CreateCategoryBodyDto,
  {},
  CreateCategoryResponseDto
> = async (req, reply) => {
  const { name, slug, description, parentId } = req.body;
  const { id: actorId, role: actorRole } = req.user as User;

  const args = pickDefined<CreateCategoryDto>(
    { name, slug, actorId, actorRole },
    { description, parentId },
  );

  const result = await categoriesServices.createCategory(args);
  return reply.code(201).send(result);
};

const patchCategory: ControllerRouter<
  UpdateCategoryParamsDto,
  UpdateCategoryBodyDto,
  {},
  UpdateCategoryResponseDto
> = async (req, reply) => {
  const categoryId = Number(req.params.categoryId);
  const { name, slug, description, parentId } = req.body;
  const { id: actorId, role: actorRole } = req.user as User;

  const args = pickDefined<UpdateCategoryDto>(
    { categoryId, actorId, actorRole },
    { name, slug, description, parentId },
  );

  const result = await categoriesServices.updateCategory(args);
  return reply.code(200).send(result);
};

const deleteCategory: ControllerRouter<
  DeleteCategoryParamsDto,
  {},
  {},
  MessageResponseDto
> = async (req, reply) => {
  const categoryId = Number(req.params.categoryId);
  const { id: actorId, role: actorRole } = req.user as User;

  const args = pickDefined<DeleteCategoryDto>({ categoryId, actorId, actorRole }, {});
  const result = await categoriesServices.deleteCategoryById(args);
  return reply.code(200).send(result);
};

// the whole tree with the products of each branch
const getCategoryTree: ControllerRouter<{}, {}, {}, CategoryTreeResponseDto> = async (
  _req,
  reply,
) => {
  const result = await categoriesServices.getCategoryTree();
  return reply.code(200).send(result);
};

export const categoriesController = {
  getCategories,
  getCategoryTree,
  postCategory,
  patchCategory,
  deleteCategory,
};
