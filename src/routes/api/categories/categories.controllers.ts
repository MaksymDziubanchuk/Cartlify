import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type {
  GetAllCategoriesQueryDto,
  FindAllCategoriesDto,
  CreateCategoryBodyDto,
  CreateCategoryDto,
  UpdateCategoryParamsDto,
  UpdateCategoryBodyDto,
  UpdateCategoryDto,
  DeleteCategoryParamsDto,
  DeleteCategoryDto,
} from 'types/dto/categories.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { categoriesServices } from './categories.services.js';

const getCategories: ControllerRouter<
  {},
  {},
  GetAllCategoriesQueryDto,
  MessageResponseDto
> = async (req, reply) => {
  const { page: qp, limit: ql, search, parentId } = req.query;
  const page = qp ? Number(qp) : 1;
  const limit = ql ? Number(ql) : 10;

  const args = pickDefined<FindAllCategoriesDto>({}, { page, limit, search, parentId });
  const result = await categoriesServices.findAll(args);
  return reply.code(200).send(result);
};

const postCategory: ControllerRouter<{}, CreateCategoryBodyDto, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { name, slug, description, parentId } = req.body;

  const args = pickDefined<CreateCategoryDto>({ name }, { slug, description, parentId });
  const result = await categoriesServices.create(args);
  return reply.code(201).send(result);
};

const patchCategory: ControllerRouter<
  UpdateCategoryParamsDto,
  UpdateCategoryBodyDto,
  {},
  MessageResponseDto
> = async (req, reply) => {
  const { categoryId } = req.params;
  const { name, slug, description, parentId } = req.body;

  const args = pickDefined<UpdateCategoryDto>(
    { categoryId },
    { name, slug, description, parentId },
  );
  const result = await categoriesServices.update(args);
  return reply.code(200).send(result);
};

const deleteCategory: ControllerRouter<
  DeleteCategoryParamsDto,
  {},
  {},
  MessageResponseDto
> = async (req, reply) => {
  const { categoryId } = req.params;

  const args = pickDefined<DeleteCategoryDto>({ categoryId }, {});
  const result = await categoriesServices.remove(args);
  return reply.code(200).send(result);
};

export const categoriesController = {
  getCategories,
  postCategory,
  patchCategory,
  deleteCategory,
};
