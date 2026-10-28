import { getCurrent } from './services/getCurrent.service.js';

import { addCurrentItem } from './services/addCurrentItem.service.js';

import { updateCurrentItem } from './services/updateCurrentItem.service.js';

import { deleteCurrentItem } from './services/deleteCurrentItem.service.js';

import { confirmOrder } from './services/confirmOrder.service.js';

import { findOrders, findOrdersCsv } from './services/findOrders.service.js';

import { findById } from './services/findById.service.js';

import { updateOrderStatus } from './services/updateOrderStatus.service.js';

import { updateOrdersStatus } from './services/updateOrdersStatus.service.js';

import { updateShipment } from './services/updateShipment.service.js';

import { updateOrderDelivery } from './services/updateOrderDelivery.service.js';

import { cancelOrderPayment } from './services/cancelOrderPayment.service.js';

import { cancelPaidOrder } from './services/cancelPaidOrder.service.js';

export const ordersServices = {
  getCurrent,
  addCurrentItem,
  updateCurrentItem,
  deleteCurrentItem,
  confirmOrder,

  findOrders,
  findOrdersCsv,
  findById,
  updateOrderStatus,
  updateOrdersStatus,
  updateShipment,
  updateOrderDelivery,

  cancelOrderPayment,
  cancelPaidOrder,
};
