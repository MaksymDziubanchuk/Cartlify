import { BadRequestError, InternalError, isAppError } from '@utils/errors.js';

import type { RefreshDto } from 'types/dto/auth.dto.js';

import { refreshAccessTokenByRefreshToken } from './helpers/resignAccessToken.helper.js';

// refresh access by refresh token
// return new refresh deadline
export async function refresh({ refreshToken }: RefreshDto): Promise<{
  accessToken: string;
  refreshToken: string;
  refreshMaxAgeSec: number;
  rememberMe: boolean;
}> {
  const rt = refreshToken?.trim();
  if (!rt) throw new BadRequestError('REFRESH_TOKEN_REQUIRED');

  try {
    // rotate tokens by refresh
    const { accessToken, refreshToken, refreshMaxAgeSec, rememberMe } =
      await refreshAccessTokenByRefreshToken({ refreshToken: rt });

    // both tokens go to cookies only, the controller sets them
    return { accessToken, refreshToken, refreshMaxAgeSec, rememberMe };
  } catch (err) {
    // map unexpected errors
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'REFRESH_SERVICE_UNEXPECTED' }, err);
  }
}
