import type { ControllerRouter } from 'types/controller.js';
import type {
  AdminStatsQueryDto,
  AdminStatsDto,
  GetAdminStatsResponseDto,
  SetProductPopularityParamsDto,
  SetProductPopularityBodyDto,
  GetAdminChatsQueryDto,
  AdminChatsDto,
} from 'types/dto/admin.dto.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';
import { adminServices } from './admin.services.js';
import pickDefined from '@helpers/parameterNormalize.js';

const getAllStats: ControllerRouter<{}, {}, AdminStatsQueryDto, GetAdminStatsResponseDto> = async (
  req,
  reply,
) => {
  const { from, to, range } = req.query;
  const { id } = req.user as UserEntity;
  const toRange = (from?: string, to?: string, range?: '7d' | '30d'): AdminStatsDto => {
    const DAY_MS = 86_400_000;
    const nowMs = Date.now();
    const days = range === '30d' ? 30 : 7;

    const parseMs = (s?: string) => {
      if (!s) return NaN;
      const t = Date.parse(s);
      return Number.isNaN(t) ? NaN : t;
    };

    let fromMs = parseMs(from);
    let toMs = parseMs(to);

    if (Number.isNaN(fromMs) && Number.isNaN(toMs)) {
      toMs = nowMs;
      fromMs = toMs - days * DAY_MS;
    } else if (!Number.isNaN(fromMs) && Number.isNaN(toMs)) {
      toMs = nowMs;
    } else if (Number.isNaN(fromMs) && !Number.isNaN(toMs)) {
      fromMs = toMs - days * DAY_MS;
    }

    if (fromMs > toMs) [fromMs, toMs] = [toMs, fromMs];

    return { from: new Date(fromMs), to: new Date(toMs), userId: id };
  };
  const dto = toRange(from, to, range);
  const result = await adminServices.showAllStats(dto);
  return result;
};

const postProductPopularity: ControllerRouter<
  SetProductPopularityParamsDto,
  SetProductPopularityBodyDto,
  {},
  MessageResponseDto
> = async (req, reply) => {
  const { productId } = req.params;
  const { popularity } = req.body;
  const { id } = req.user as UserEntity;
  const prodId = Number(productId);
  const result = await adminServices.setProductPopularity({
    productId: prodId,
    popularity,
    actorId: id,
  });
  return result;
};

const getAdminsChats: ControllerRouter<{}, {}, GetAdminChatsQueryDto, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;
  const { status, type, page: qp, limit: ql } = req.query;

  const page = qp ? Number(qp) : 1;
  const limit = ql ? Number(ql) : 10;
  const offset = (page - 1) * limit;

  const args = pickDefined<AdminChatsDto>({ userId: id, page, limit, offset }, { status, type });
  const result = await adminServices.showAdminChats(args);
  return result;
};

export const adminController = {
  getAllStats,
  postProductPopularity,
  getAdminsChats,
};
