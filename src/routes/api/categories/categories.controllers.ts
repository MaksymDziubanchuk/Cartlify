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
  CategoryResponseDto,
  UpdateCategoryParamsDto,
  UpdateCategoryBodyDto,
  UpdateCategoryDto,
  UpdateCategoryResponseDto,
  DeleteCategoryParamsDto,
  DeleteCategoryDto,
  CategoryImageParamsDto,
  UploadedCategoryImage,
} from 'types/dto/categories.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { BadRequestError } from '@utils/errors.js';
import { discardUploads } from '@utils/cloudinary.util.js';
import { categoriesServices } from './categories.services.js';
import { beginCategoryImageUpload } from './services/setCategoryImage.service.js';

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

  const args = pickDefined<DeleteCategoryDto>({ categoryId, actorId, actorRole }, { log: req.log });
  const result = await categoriesServices.deleteCategoryById(args);
  return reply.code(200).send(result);
};

// puts the picture of the form on a category; the file is read while the form is parsed
const putCategoryImage: ControllerRouter<
  CategoryImageParamsDto,
  {},
  {},
  CategoryResponseDto
> = async (req, reply) => {
  const categoryId = Number(req.params.categoryId);
  const { id: actorId, role: actorRole } = req.user as User;

  if (!req.isMultipart()) throw new BadRequestError('MULTIPART_REQUIRED');

  let upload: Promise<UploadedCategoryImage> | undefined;

  try {
    for await (const part of req.parts()) {
      // text fields say nothing here
      if (part.type !== 'file') continue;

      if (part.fieldname !== 'image') {
        part.file.resume();
        continue;
      }

      // one picture to a category
      if (upload) {
        part.file.resume();
        throw new BadRequestError('CATEGORY_IMAGE_MULTIPLE');
      }

      upload = beginCategoryImageUpload({
        categoryId,
        image: { file: part.file, mimetype: part.mimetype, filename: part.filename },
      });
      // awaited after the loop; a failure before that must not stop the process
      upload.catch(() => undefined);
    }

    if (!upload) throw new BadRequestError('CATEGORY_IMAGE_REQUIRED');

    const result = await categoriesServices.setCategoryImage({
      categoryId,
      actorId,
      actorRole,
      upload,
      log: req.log,
    });
    return reply.code(200).send(result);
  } catch (err) {
    // the picture that waits on Cloudinary goes with the refused request
    if (upload) await discardUploads([upload], req.log);
    throw err;
  }
};

const deleteCategoryImage: ControllerRouter<
  CategoryImageParamsDto,
  {},
  {},
  CategoryResponseDto
> = async (req, reply) => {
  const categoryId = Number(req.params.categoryId);
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await categoriesServices.removeCategoryImage({
    categoryId,
    actorId,
    actorRole,
    log: req.log,
  });
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
  putCategoryImage,
  deleteCategoryImage,
};
