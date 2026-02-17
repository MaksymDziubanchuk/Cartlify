import { findAllCategories } from './services/findAllCategories.service.js';
import { createCategory } from './services/create.service.js';
import { updateCategory } from './services/update.service.js';
import { deleteCategoryById } from './services/delete.service.js';

export const categoriesServices = {
  findAllCategories,
  createCategory,
  updateCategory,
  deleteCategoryById,
};
