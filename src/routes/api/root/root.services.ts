import { findAdmins } from './services/getAdmins.service.js';

import { addAdmin } from './services/addAdmin.service.js';

import { removeAdmin } from './services/deleteAdmin.service.js';

export const rootServices = {
  findAdmins,
  addAdmin,
  removeAdmin,
};
