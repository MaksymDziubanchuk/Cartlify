import { ProductId, UserId } from 'types/ids.js';
import { Role } from 'types/user.js';

async function showAllStats() {
  return {
    message: 'admin stats not implemented',
  };
}

async function setProductPopularity(productId: ProductId) {
  return {
    message: 'set product popularity not implemented',
  };
}

async function showAdminChats(userId: UserId, role: Role) {
  return {
    message: 'admin chats not implemented',
  };
}

export const adminServices = {
  showAllStats,
  setProductPopularity,
  showAdminChats,
};
