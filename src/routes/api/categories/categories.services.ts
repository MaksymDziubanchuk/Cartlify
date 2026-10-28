import { findAllCategories } from './services/findAllCategories.service.js';
import { getCategoryTree } from './services/getCategoryTree.service.js';
import { createCategory } from './services/createCategory.service.js';
import { updateCategory } from './services/updateCategory.service.js';
import { deleteCategoryById } from './services/deleteCategory.service.js';
import { setCategoryImage } from './services/setCategoryImage.service.js';
import { removeCategoryImage } from './services/removeCategoryImage.service.js';

export const categoriesServices = {
  findAllCategories,
  getCategoryTree,
  createCategory,
  updateCategory,
  deleteCategoryById,
  setCategoryImage,
  removeCategoryImage,
};
