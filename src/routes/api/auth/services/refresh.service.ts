import { AppError, BadRequestError, isAppError } from '@utils/errors.js';

import type { RefreshDto, RefreshResponseDto } from 'types/dto/auth.dto.js';

import { refreshAccessTokenByRefreshToken } from './helpers/resignAccessToken.service.js';

export async function refresh({ refreshToken }: RefreshDto): Promise<{
  result: RefreshResponseDto;
  refreshToken: string;
  refreshMaxAgeSec: number;
}> {
  const rt = refreshToken?.trim();
  if (!rt) throw new BadRequestError('REFRESH_TOKEN_REQUIRED');

  try {
    const { accessToken, refreshToken, refreshMaxAgeSec } = await refreshAccessTokenByRefreshToken({
      refreshToken: rt,
    });
    return { result: { accessToken }, refreshToken, refreshMaxAgeSec };
  } catch (err) {
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`refresh(service): unexpected (${msg})`, 500);
  }
}
