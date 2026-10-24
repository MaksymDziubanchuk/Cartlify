import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { User } from 'types/user.js';
import type {
  LoginBodyDto,
  LoginDto,
  LoginResponseDto,
  GoogleStartDto,
  GoogleStartResponseDto,
  GoogleCallbackQueryDto,
  GoogleCallbackDto,
  GoogleCallbackSuccessQueryDto,
  GithubStartDto,
  GithubStartResponseDto,
  GithubCallbackQueryDto,
  GithubCallbackDto,
  GithubCallbackSuccessQueryDto,
  LinkedInStartDto,
  LinkedInStartResponseDto,
  LinkedInCallbackQueryDto,
  LinkedInCallbackSuccessQueryDto,
  LinkedInCallbackDto,
  RegisterBodyDto,
  RegisterResponseDto,
  RegisterDto,
  ResendVerifyDto,
  VerifyEmailDto,
  PasswordForgotBodyDto,
  PasswordForgotDto,
  PasswordResetBodyDto,
  PasswordResetQueryDto,
  PasswordResetDto,
  LogoutBodyDto,
  LogoutDto,
  PasswordChangeBodyDto,
  SessionIdParamsDto,
  SessionsResponseDto,
  RefreshDto,
  CsrfTokenResponseDto,
} from 'types/dto/auth.dto.js';

import { authServices } from './auth.services.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { isUuid } from '@db/dbContext.service.js';
import {
  AlreadyAuthenticatedError,
  BadRequestError,
  InternalError,
  UnauthorizedError,
  isAppError,
} from '@utils/errors.js';
import { webUrl } from '@helpers/webOrigin.js';
import { clearLoginFailures, recordLoginFailure } from '../../../plugins/requestLimits.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { getTtl, verifyRefreshToken } from '@utils/jwt.js';
import {
  clearGuestIdCookie,
  setAccessTokenCookie,
  setRefreshTokenCookie,
  clearAuthCookies,
  markAuthCookiesNoStore,
  shouldClearRefreshCookieOnRefreshError,
} from '@routes/api/auth/services/helpers/authCookies.helper.js';

const postRegister: ControllerRouter<{}, RegisterBodyDto, {}, RegisterResponseDto> = async (
  req,
  reply,
) => {
  const { email, password, name } = req.body;
  const { id, role } = req.user as User;
  // build register dto
  const args = pickDefined<RegisterDto>(
    {
      email,
      password,
      userId: id,
      role,
    },
    { name },
  );
  // create user in service
  const result = await authServices.register(args);
  return reply.code(201).send(result);
};

const postLogin: ControllerRouter<{}, LoginBodyDto, {}, LoginResponseDto> = async (req, reply) => {
  const { email, password, rememberMe } = req.body;
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];
  const { id, role } = req.user as User;
  // build login dto
  const args = pickDefined<LoginDto>(
    {
      email,
      password,
      userId: id,
      role,
    },
    {
      rememberMe,
      ip,
      userAgent,
    },
  );

  // authenticate and get tokens; a wrong password counts toward the pause of the account
  // (src/plugins/requestLimits.ts), the right one starts the count over
  let login: Awaited<ReturnType<typeof authServices.login>>;
  try {
    login = await authServices.login(args);
  } catch (err) {
    if (isAppError(err) && err.errorCode === 'INVALID_CREDENTIALS') recordLoginFailure(email);
    throw err;
  }
  clearLoginFailures(email);
  const { result, refreshToken, accessToken } = login;

  const refreshTtl = rememberMe ? getTtl(rememberMe, 'refresh') : getTtl(false, 'refresh');
  const accessTtl = rememberMe ? getTtl(rememberMe, 'access') : getTtl(false, 'access');

  if (!refreshTtl || !accessTtl) {
    throw new InternalError({ reason: 'AUTH_TTL_INVALID' });
  }
  // set auth cookies
  clearGuestIdCookie(reply);
  setAccessTokenCookie(reply, accessToken, accessTtl as number);
  setRefreshTokenCookie(reply, refreshToken, refreshTtl as number);

  return result;
};

const postVerifyResend: ControllerRouter<{}, ResendVerifyDto, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { email } = req.body;

  // validate email for resend
  assertEmail(email);

  const args = pickDefined<ResendVerifyDto>(
    {
      email,
    },
    {},
  );
  // resend verify email
  const result = await authServices.resendVerify(args);
  return reply.code(200).send(result);
};

const getGoogleStart: ControllerRouter<{}, {}, {}, GoogleStartResponseDto> = async (req, reply) => {
  const { id, role } = req.user as User;

  // allow oauth start for guest
  if (role !== 'GUEST') {
    throw new AlreadyAuthenticatedError();
  }

  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  // build google start dto
  const args = pickDefined<GoogleStartDto>({ guestId: id, role }, { ip, userAgent });

  const { url } = await authServices.googleStart(args);
  // redirect to google oauth
  reply.code(302).redirect(url);
  return;
};

// frontend page that finishes an oauth login, a placeholder until the frontend fixes its routes
const OAUTH_CALLBACK_PAGE = '/auth/callback';

// the codes a provider sends when the user declines: google and github use the standard one,
// linkedin its own for a cancelled login and for refused access
const OAUTH_DECLINED_ERRORS = new Set([
  'access_denied',
  'user_cancelled_login',
  'user_cancelled_authorize',
]);

// the provider sends the browser to the api, and whatever happens it goes back to the frontend:
// with the auth cookies on success, with ?error=<errorCode> otherwise
async function finishOAuthLogin(
  req: FastifyRequest,
  reply: FastifyReply,
  login: () => Promise<{ accessToken: string; refreshToken: string }>,
): Promise<void> {
  let error: string | undefined;

  try {
    // the provider reports a refused or failed login in the query
    const providerError = (req.query as { error?: unknown }).error;
    if (typeof providerError === 'string') {
      throw OAUTH_DECLINED_ERRORS.has(providerError)
        ? new UnauthorizedError('OAUTH_ACCESS_DENIED')
        : new BadRequestError('OAUTH_CALLBACK_ERROR', { providerError });
    }

    const { accessToken, refreshToken } = await login();

    // derive ttl from refresh
    const { rememberMe } = verifyRefreshToken(refreshToken);

    // set oauth auth cookies
    clearGuestIdCookie(reply);
    setAccessTokenCookie(reply, accessToken, getTtl(rememberMe, 'access') as number);
    setRefreshTokenCookie(reply, refreshToken, getTtl(rememberMe, 'refresh') as number);
  } catch (err) {
    // the page gets the reason of a refused login; a server failure stays in the log
    if (isAppError(err) && err.statusCode < 500) {
      error = err.errorCode;
      req.log.info({ errorCode: error }, 'oauth login rejected');
    } else if (isAppError(err) && err.errorCode === 'OAUTH_PROVIDER_UNAVAILABLE') {
      // the provider is out of reach or silent: the page tells the person to try again
      error = err.errorCode;
      req.log.warn({ errorCode: error, details: err.details }, 'oauth provider unavailable');
    } else {
      error = 'OAUTH_LOGIN_FAILED';
      req.log.error({ err }, 'oauth login failed');
    }
  }

  reply.code(302).redirect(webUrl(OAUTH_CALLBACK_PAGE, error ? { error } : {}));
}

const getGoogleCallback: ControllerRouter<{}, {}, GoogleCallbackQueryDto, void> = async (
  req,
  reply,
) => {
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  await finishOAuthLogin(req, reply, async () => {
    const { code, state } = req.query as GoogleCallbackSuccessQueryDto;
    // the guest of this browser, it has to be the one who started the login
    const { id: guestId, role } = req.user as User;

    // build google callback dto
    const args = pickDefined<GoogleCallbackDto>(
      { code, state, guestId, role, log: req.log },
      { ip, userAgent },
    );

    return authServices.googleCallback(args);
  });
};

const getGithubStart: ControllerRouter<{}, {}, {}, GithubStartResponseDto> = async (req, reply) => {
  const { id, role } = req.user as User;

  // allow oauth start for guest
  if (role !== 'GUEST') {
    throw new AlreadyAuthenticatedError();
  }

  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  // build github start dto
  const args = pickDefined<GithubStartDto>({ guestId: id, role }, { ip, userAgent });

  const { url } = await authServices.githubStart(args);
  // redirect to github oauth
  reply.code(302).redirect(url);
  return;
};

const getGithubCallback: ControllerRouter<{}, {}, GithubCallbackQueryDto, void> = async (
  req,
  reply,
) => {
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  await finishOAuthLogin(req, reply, async () => {
    const { code, state } = req.query as GithubCallbackSuccessQueryDto;
    // the guest of this browser, it has to be the one who started the login
    const { id: guestId, role } = req.user as User;

    // build github callback dto
    const args = pickDefined<GithubCallbackDto>(
      { code, state, guestId, role, log: req.log },
      { ip, userAgent },
    );

    return authServices.githubCallback(args);
  });
};

const getLinkedInStart: ControllerRouter<{}, {}, {}, LinkedInStartResponseDto> = async (
  req,
  reply,
) => {
  const { id, role } = req.user as User;

  // allow oauth start for guest
  if (role !== 'GUEST') {
    throw new AlreadyAuthenticatedError();
  }

  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  // build linkedin start dto
  const args = pickDefined<LinkedInStartDto>({ guestId: id, role }, { ip, userAgent });

  const { url } = await authServices.linkedInStart(args);
  // redirect to linkedin oauth
  reply.code(302).redirect(url);
  return;
};

const getLinkedInCallback: ControllerRouter<{}, {}, LinkedInCallbackQueryDto, void> = async (
  req,
  reply,
) => {
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  await finishOAuthLogin(req, reply, async () => {
    const { code, state } = req.query as LinkedInCallbackSuccessQueryDto;
    // the guest of this browser, it has to be the one who started the login
    const { id: guestId, role } = req.user as User;

    // build linkedin callback dto
    const args = pickDefined<LinkedInCallbackDto>(
      { code, state, guestId, role, log: req.log },
      { ip, userAgent },
    );

    return authServices.linkedInCallback(args);
  });
};

const getVerifyEmail: ControllerRouter<{}, {}, VerifyEmailDto, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { token } = req.query;
  // the route reads no session: the guest of the browser comes from its cookie
  const guestCookie = req.cookies?.guestId;
  const args = pickDefined<VerifyEmailDto>(
    {
      token,
    },
    { guestId: isUuid(guestCookie) ? guestCookie : undefined },
  );
  // verify email by token
  const result = await authServices.verifyEmail(args);
  return reply.code(200).send(result);
};

const postPasswordForgot: ControllerRouter<
  {},
  PasswordForgotBodyDto,
  {},
  MessageResponseDto
> = async (req, reply) => {
  const email = req.body?.email;
  const args = pickDefined<PasswordForgotDto>({ email }, {});
  // request password reset
  const result = await authServices.passwordForgot(args);

  // revoke auth cookies
  clearAuthCookies(reply);
  return reply.code(200).send(result);
};

const postPasswordReset: ControllerRouter<
  {},
  PasswordResetBodyDto,
  PasswordResetQueryDto,
  MessageResponseDto
> = async (req, reply) => {
  const token = req.query?.token;
  const newPassword = req.body?.newPassword;
  const args = pickDefined<PasswordResetDto>({ token, newPassword }, {});
  // reset password by token
  const result = await authServices.passwordReset(args);
  return reply.code(200).send(result);
};

const postLogout: ControllerRouter<{}, LogoutBodyDto, {}, void> = async (req, reply) => {
  // the guard may have renewed the session in this request: the cookie then holds a spent token
  const refreshToken = req.issuedRefreshToken ?? req.cookies?.refreshToken;
  const allDevices = req.body?.allDevices;
  const { id, role } = req.user as User;
  const args = pickDefined<LogoutDto>({ userId: Number(id), role }, { refreshToken, allDevices });

  // logout and clear cookies
  await authServices.logout(args);

  clearAuthCookies(reply);
  return reply.code(204).send();
};

// the refresh cookie of this browser: the guard may have renewed the session in this request
const refreshTokenOf = (req: FastifyRequest) => req.issuedRefreshToken ?? req.cookies?.refreshToken;

const getSessions: ControllerRouter<{}, {}, {}, SessionsResponseDto> = async (req, reply) => {
  const { id, role } = req.user as User;

  const result = await authServices.listSessions(
    pickDefined<Parameters<typeof authServices.listSessions>[0]>(
      { userId: Number(id), role },
      { refreshToken: refreshTokenOf(req) },
    ),
  );

  return reply.code(200).send(result);
};

const deleteSession: ControllerRouter<SessionIdParamsDto, {}, {}, void> = async (req, reply) => {
  const { id, role } = req.user as User;

  const { current } = await authServices.closeSession(
    pickDefined<Parameters<typeof authServices.closeSession>[0]>(
      { userId: Number(id), role, sessionId: req.params.sessionId },
      { refreshToken: refreshTokenOf(req) },
    ),
  );

  // the session of this browser ended: its cookies go, like at a logout
  if (current) clearAuthCookies(reply);
  return reply.code(204).send();
};

const postPasswordChange: ControllerRouter<{}, PasswordChangeBodyDto, {}, void> = async (
  req,
  reply,
) => {
  const { id, role } = req.user as User;

  await authServices.changePassword(
    pickDefined<Parameters<typeof authServices.changePassword>[0]>(
      {
        userId: Number(id),
        role,
        currentPassword: req.body.currentPassword,
        newPassword: req.body.newPassword,
        log: req.log,
      },
      { refreshToken: refreshTokenOf(req) },
    ),
  );

  return reply.code(204).send();
};

// the route runs without authGuard: with an expired access cookie the guard would rotate
// the refresh token itself, and the rotation here would then present an already used one
const postRefresh: ControllerRouter<{}, {}, {}, void> = async (req, reply) => {
  const refreshToken = req.cookies?.refreshToken;
  if (!refreshToken) throw new BadRequestError('REFRESH_TOKEN_REQUIRED');

  const args = pickDefined<RefreshDto>(
    {
      refreshToken,
    },
    {},
  );

  try {
    // rotate tokens from refresh cookie
    const {
      accessToken,
      refreshToken: newRefreshToken,
      refreshMaxAgeSec,
      rememberMe,
    } = await authServices.refresh(args);

    // both tokens go to httpOnly cookies only, page scripts never see them
    setAccessTokenCookie(reply, accessToken, getTtl(rememberMe, 'access') as number);
    setRefreshTokenCookie(reply, newRefreshToken, refreshMaxAgeSec);
  } catch (err) {
    // an invalid, expired or reused refresh token will not work again: drop both cookies
    if (shouldClearRefreshCookieOnRefreshError(err)) clearAuthCookies(reply);
    throw err;
  }

  return reply.code(204).send();
};

// the secret goes to an httpOnly cookie (made once, kept after), the token to the page;
// csrf.plugin.ts checks the pair on every request that changes data
const getCsrfToken: ControllerRouter<{}, {}, {}, CsrfTokenResponseDto> = async (_req, reply) => {
  markAuthCookiesNoStore(reply);

  return { csrfToken: reply.generateCsrf() };
};

export const authController = {
  postLogin,
  postRegister,
  getGoogleStart,
  getGoogleCallback,
  getGithubStart,
  getGithubCallback,
  getLinkedInStart,
  getLinkedInCallback,
  postVerifyResend,
  getVerifyEmail,
  postPasswordForgot,
  postPasswordReset,
  postLogout,
  getSessions,
  deleteSession,
  postPasswordChange,
  postRefresh,
  getCsrfToken,
};
