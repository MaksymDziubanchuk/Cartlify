import { FastifyRequest, FastifyReply } from 'fastify';
import { ProductId } from 'types/ids.js';
import { adminServices } from './admin.services.js';
import { User } from 'types/user.js';

async function getAllStats(req: FastifyRequest, reply: FastifyReply) {
  const result = await adminServices.showAllStats();
  return result;
}

async function postProductPopularity(req: FastifyRequest, reply: FastifyReply) {
  const { productId } = req.params as { productId: ProductId };
  const id = Number(productId);
  const result = await adminServices.setProductPopularity(id);
  return result;
}

async function getAdminsChats(req: FastifyRequest, reply: FastifyReply) {
  const { id, role } = req.user as User;
  const result = await adminServices.showAdminChats(id, role);
  return result;
}

export const adminController = {
  getAllStats,
  postProductPopularity,
  getAdminsChats,
};
