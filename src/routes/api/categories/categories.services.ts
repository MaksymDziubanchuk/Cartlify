import { findAllCategories } from './services/findAllCategories.service.js';
import { createCategory } from './services/createCategory.service.js';
import { updateCategory } from './services/updateCategory.service.js';
import { deleteCategoryById } from './services/deleteCategory.service.js';

export const categoriesServices = {
  findAllCategories,
  createCategory,
  updateCategory,
  deleteCategoryById,
};
