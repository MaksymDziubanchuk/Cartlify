import { AppError, BadRequestError, isAppError } from '@utils/errors.js';

import type { RefreshDto, RefreshResponseDto } from 'types/dto/auth.dto.js';

import { refreshAccessTokenByRefreshToken } from './helpers/resignAccessToken.helper.js';

// refresh access by refresh token
// return new refresh deadline
export async function refresh({ refreshToken }: RefreshDto): Promise<{
  result: RefreshResponseDto;
  refreshToken: string;
  refreshMaxAgeSec: number;
}> {
  const rt = refreshToken?.trim();
  if (!rt) throw new BadRequestError('REFRESH_TOKEN_REQUIRED');

  try {
    // rotate tokens by refresh
    const { accessToken, refreshToken, refreshMaxAgeSec } = await refreshAccessTokenByRefreshToken({
      refreshToken: rt,
    });
    // return tokens for cookie layer
    return { result: { accessToken }, refreshToken, refreshMaxAgeSec };
  } catch (err) {
    // map unexpected errors
    if (isAppError(err)) throw err;

    throw new AppError(`refresh(service): unexpected`, 500);
  }
}
