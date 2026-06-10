import type { ControllerRouter } from 'types/controller.js';
import type { User } from 'types/user.js';
import type {
  AdminStatsDto,
  AdminStatsQueryDto,
  GetAdminStatsResponseDto,
} from 'types/dto/admin.dto.js';
import { BadRequestError, UnauthorizedError } from '@utils/errors.js';
import { adminServices } from './admin.services.js';

const ALL_TIME_FROM_MS = 0;

function parseOptionalStatsDateMs(value: string | undefined, field: 'from' | 'to'): number | null {
  if (value === undefined) return null;

  const ms = Date.parse(value);

  if (Number.isNaN(ms)) {
    throw new BadRequestError('INVALID_STATS_PERIOD', {
      field,
      reason: 'INVALID_DATE',
    });
  }

  return ms;
}

function normalizeStatsQuery(query: AdminStatsQueryDto, actor: User): AdminStatsDto {
  const parsedFromMs = parseOptionalStatsDateMs(query.from, 'from');
  const parsedToMs = parseOptionalStatsDateMs(query.to, 'to');

  const fromMs = parsedFromMs ?? ALL_TIME_FROM_MS;
  const toMs = parsedToMs ?? Date.now();

  if (fromMs > toMs) {
    throw new BadRequestError('INVALID_STATS_PERIOD', {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      reason: 'FROM_AFTER_TO',
    });
  }

  return {
    from: new Date(fromMs),
    to: new Date(toMs),
    actorId: actor.id,
    actorRole: actor.role,
  };
}

const getAllStats: ControllerRouter<{}, {}, AdminStatsQueryDto, GetAdminStatsResponseDto> = async (
  req,
  reply,
) => {
  // authGuard should attach actor before role guard
  if (!req.user) {
    throw new UnauthorizedError('LOGIN_REQUIRED');
  }

  // normalize query and pass actor context into service
  const dto = normalizeStatsQuery(req.query, req.user);

  const result = await adminServices.showAllStats(dto);

  return reply.code(200).send(result);
};

export const adminController = {
  getAllStats,
};