import { createParty } from './services/createParty.service.js';
import { deleteParty } from './services/deleteParty.service.js';
import { getParty } from './services/getParty.service.js';
import { listParties } from './services/listParties.service.js';
import { updateParty } from './services/updateParty.service.js';

export const partiesServices = {
  createParty,
  deleteParty,
  getParty,
  listParties,
  updateParty,
};
