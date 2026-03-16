import { getCurrent } from './services/getCurrent.service.js';

import { addCurrentItem } from './services/addCurrentItem.service.js';

import { updateCurrentItem } from './services/updateCurrentItem.service.js';

import { deleteCurrentItem } from './services/deleteCurrentItem.service.js';

import { confirmOrder } from './services/confirmOrder.service.js';

import { findOrders } from './services/findOrders.service.js';

import { findById } from './services/findById.service.js';

import { updateOrderStatus } from './services/updateOrderStatus.service.js';

export const ordersServices = {
  getCurrent,
  addCurrentItem,
  updateCurrentItem,
  deleteCurrentItem,
  confirmOrder,

  findOrders,
  findById,
  updateOrderStatus,
};
