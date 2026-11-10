import { findAdmins } from './services/getAdmins.service.js';

import { addAdmin } from './services/addAdmin.service.js';

import { removeAdmin } from './services/deleteAdmin.service.js';

import { updateAdmin } from './services/updateAdmin.service.js';

export const rootServices = {
  findAdmins,
  addAdmin,
  updateAdmin,
  removeAdmin,
};
