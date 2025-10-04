import type {
  AdminStatsDto,
  GetAdminStatsResponseDto,
  SetProductPopularityDto,
  AdminChatsDto,
} from 'types/dto/admin.dto.js';
import { ProductId, UserId } from 'types/ids.js';
import { Role } from 'types/user.js';

async function showAllStats({
  from,
  to,
  userId,
}: AdminStatsDto): Promise<GetAdminStatsResponseDto> {
  return {
    users: { total: 0, new7d: 0, new30d: 0, verifiedRate: 0 },
    orders: {
      total: 0,
      byStatus: { pending: 0, paid: 0, shipped: 0, delivered: 0, cancelled: 0 },
      revenue: { total: 0, last7d: 0, last30d: 0 },
      averageOrderValue: 0,
    },
    products: {
      total: 0,
      topProductsByRevenue: [],
      topCategoriesByRevenue: [],
    },
    reviews: { total: 0, avgRating: 0, negativeCount: 0 },
    createdAt: new Date(),
  };
}

async function setProductPopularity({ productId, popularity, actorId }: SetProductPopularityDto) {
  return {
    message: 'set product popularity not implemented',
  };
}

async function showAdminChats({ userId, page, limit, offset, status, type }: AdminChatsDto) {
  return {
    message: 'admin chats not implemented',
  };
}

export const adminServices = {
  showAllStats,
  setProductPopularity,
  showAdminChats,
};
