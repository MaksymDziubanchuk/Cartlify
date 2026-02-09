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
  RefreshDto,
  RefreshResponseDto,
} from 'types/dto/auth.dto.js';

import { authServices } from './auth.services.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { AppError, BadRequestError } from '@utils/errors.js';
import { getTtl } from '@utils/jwt.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { verifyRefreshToken } from '@utils/jwt.js';
import {
  clearGuestIdCookie,
  setAccessTokenCookie,
  setRefreshTokenCookie,
  clearAuthCookies,
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

  // authenticate and get tokens
  const { result, refreshToken, accessToken } = await authServices.login(args);

  const refreshTtl = rememberMe ? getTtl(rememberMe, 'refresh') : getTtl(false, 'refresh');
  const accessTtl = rememberMe ? getTtl(rememberMe, 'access') : getTtl(false, 'access');

  if (!refreshTtl || !accessTtl)
    throw new BadRequestError('Invalid JWT TTL: (expected e.g. "3600")');

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
    throw new AppError('Already authenticated', 409);
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

const getGoogleCallback: ControllerRouter<
  {},
  {},
  GoogleCallbackQueryDto,
  LoginResponseDto
> = async (req, reply) => {
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  const q = req.query;

  // handle oauth error callback
  if ('error' in q && typeof q.error === 'string') {
    const code = q.error;
    const desc = q.error_description;

    if (code === 'access_denied') {
      throw new AppError(desc ?? 'OAuth access denied', 401);
    }

    throw new AppError(desc ?? code, 400);
  }

  const { code, state } = q as GoogleCallbackSuccessQueryDto;

  // build google callback dto
  const args = pickDefined<GoogleCallbackDto>({ code, state }, { ip, userAgent });

  const { result, accessToken, refreshToken } = await authServices.googleCallback(args);

  // derive ttl from refresh
  const { rememberMe } = verifyRefreshToken(refreshToken);
  const refreshTtl = getTtl(rememberMe, 'refresh');
  const accessTtl = getTtl(rememberMe, 'access');

  // set oauth auth cookies
  clearGuestIdCookie(reply);
  setAccessTokenCookie(reply, accessToken, accessTtl as number);
  setRefreshTokenCookie(reply, refreshToken, refreshTtl as number);

  return result;
};

const getGithubStart: ControllerRouter<{}, {}, {}, GithubStartResponseDto> = async (req, reply) => {
  const { id, role } = req.user as User;

  // allow oauth start for guest
  if (role !== 'GUEST') {
    throw new AppError('Already authenticated', 409);
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

const getGithubCallback: ControllerRouter<
  {},
  {},
  GithubCallbackQueryDto,
  LoginResponseDto
> = async (req, reply) => {
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  const q = req.query;

  // handle oauth error callback
  if ('error' in q && typeof q.error === 'string') {
    const code = q.error;
    const desc = q.error_description;

    if (code === 'access_denied') {
      throw new AppError(desc ?? 'OAuth access denied', 401);
    }

    throw new AppError(desc ?? code, 400);
  }

  const { code, state } = q as GithubCallbackSuccessQueryDto;

  // handle oauth error callback
  const args = pickDefined<GithubCallbackDto>({ code, state }, { ip, userAgent });

  const { result, accessToken, refreshToken } = await authServices.githubCallback(args);

  // derive ttl from refresh
  const { rememberMe } = verifyRefreshToken(refreshToken);
  const refreshTtl = getTtl(rememberMe, 'refresh');
  const accessTtl = getTtl(rememberMe, 'access');

  // set oauth auth cookies
  clearGuestIdCookie(reply);
  setAccessTokenCookie(reply, accessToken, accessTtl as number);
  setRefreshTokenCookie(reply, refreshToken, refreshTtl as number);

  return result;
};

const getLinkedInStart: ControllerRouter<{}, {}, {}, LinkedInStartResponseDto> = async (
  req,
  reply,
) => {
  const { id, role } = req.user as User;

  // allow oauth start for guest
  if (role !== 'GUEST') {
    throw new AppError('Already authenticated', 409);
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

const getLinkedInCallback: ControllerRouter<
  {},
  {},
  LinkedInCallbackQueryDto,
  LoginResponseDto
> = async (req, reply) => {
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  const q = req.query;

  // handle oauth error callback
  if ('error' in q && typeof q.error === 'string') {
    const code = q.error;
    const desc = q.error_description;

    if (code === 'access_denied') {
      throw new AppError(desc ?? 'OAuth access denied', 401);
    }

    throw new AppError(desc ?? code, 400);
  }

  const { code, state } = q as LinkedInCallbackSuccessQueryDto;

  // build linkedin callback dto
  const args = pickDefined<LinkedInCallbackDto>({ code, state }, { ip, userAgent });

  const { result, accessToken, refreshToken } = await authServices.linkedInCallback(args);

  // derive ttl from refresh
  const { rememberMe } = verifyRefreshToken(refreshToken);
  const refreshTtl = getTtl(rememberMe, 'refresh');
  const accessTtl = getTtl(rememberMe, 'access');

  // set oauth auth cookies
  clearGuestIdCookie(reply);
  setAccessTokenCookie(reply, accessToken, accessTtl as number);
  setRefreshTokenCookie(reply, refreshToken, refreshTtl as number);

  return result;
};

const getVerifyEmail: ControllerRouter<{}, {}, VerifyEmailDto, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { token } = req.query;
  const args = pickDefined<VerifyEmailDto>(
    {
      token,
    },
    {},
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
  const refreshToken = req.cookies?.refreshToken;
  const allDevices = req.body?.allDevices;
  const args = pickDefined<LogoutDto>({}, { refreshToken, allDevices });

  // logout and clear cookies
  await authServices.logout(args);

  clearAuthCookies(reply);
  return reply.code(204).send();
};

const postRefresh: ControllerRouter<{}, {}, {}, RefreshResponseDto> = async (req, reply) => {
  const refreshToken = req.cookies?.refreshToken;
  if (!refreshToken) throw new BadRequestError('REFRESH_TOKEN_REQUIRED');

  const args = pickDefined<RefreshDto>(
    {
      refreshToken,
    },
    {},
  );

  // rotate tokens from refresh cookie
  const {
    result,
    refreshToken: newRefreshToken,
    refreshMaxAgeSec,
  } = await authServices.refresh(args);
  const { accessToken } = result;

  // store new refresh cookie
  setRefreshTokenCookie(reply, newRefreshToken, refreshMaxAgeSec);

  return { accessToken };
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
  postRefresh,
};
