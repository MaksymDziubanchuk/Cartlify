import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { User, UserEntity } from 'types/user.js';
import type {
  LoginBodyDto,
  LoginDto,
  LoginResponseDto,
  GoogleStartDto,
  GoogleStartResponseDto,
  GoogleCallbackQueryDto,
  GoogleCallbackDto,
  GoogleCallbackSuccessQueryDto,
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
import env from '@config/env.js';
import { getTtl } from '@utils/jwt.js';
import { assertEmail } from '@helpers/validateEmail.js';

const postRegister: ControllerRouter<{}, RegisterBodyDto, {}, RegisterResponseDto> = async (
  req,
  reply,
) => {
  const { email, password, name } = req.body;
  const { id, role } = req.user as User;
  const args = pickDefined<RegisterDto>(
    {
      email,
      password,
      userId: id,
      role,
    },
    { name },
  );
  const result = await authServices.register(args);
  return reply.code(201).send(result);
};

const postLogin: ControllerRouter<{}, LoginBodyDto, {}, LoginResponseDto> = async (req, reply) => {
  const { email, password, rememberMe } = req.body;
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];
  const { id, role } = req.user as User;
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

  const { result, refreshToken, accessToken } = await authServices.login(args);

  const isProd = env.NODE_ENV === 'production';

  const refreshTtl = rememberMe ? getTtl(rememberMe, 'refresh') : getTtl(false, 'refresh');
  const accessTtl = rememberMe ? getTtl(rememberMe, 'access') : getTtl(false, 'access');

  if (!refreshTtl || !accessTtl)
    throw new BadRequestError('Invalid JWT TTL: (expected e.g. "3600")');

  const baseCookie = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
  } as const;

  reply.clearCookie('guestId', {
    ...baseCookie,
    path: '/',
  });

  reply.clearCookie('accessToken', {
    ...baseCookie,
    path: '/',
  });

  reply.clearCookie('refreshToken', {
    ...baseCookie,
    path: '/',
  });

  reply.setCookie('accessToken', accessToken, {
    ...baseCookie,
    path: '/',
    maxAge: accessTtl as number,
  });

  reply.setCookie('refreshToken', refreshToken, {
    ...baseCookie,
    path: '/',
    maxAge: refreshTtl as number,
  });

  return result;
};

const postVerifyResend: ControllerRouter<{}, ResendVerifyDto, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { email } = req.body;

  assertEmail(email);

  const args = pickDefined<ResendVerifyDto>(
    {
      email,
    },
    {},
  );
  const result = await authServices.resendVerify(args);
  return reply.code(200).send(result);
};

export const getGoogleStart: ControllerRouter<{}, {}, {}, GoogleStartResponseDto> = async (
  req,
  reply,
) => {
  const { id, role } = req.user as User;

  if (role !== 'GUEST') {
    throw new AppError('Already authenticated', 409);
  }

  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  const args = pickDefined<GoogleStartDto>({ guestId: id, role }, { ip, userAgent });

  const { url } = await authServices.googleStart(args);
  reply.code(302).redirect(url);
  return;
};

export const getGoogleCallback: ControllerRouter<
  {},
  {},
  GoogleCallbackQueryDto,
  LoginResponseDto
> = async (req, reply) => {
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  const q = req.query;

  if ('error' in q && typeof q.error === 'string') {
    const code = q.error;
    const desc = q.error_description;

    if (code === 'access_denied') {
      throw new AppError(desc ?? 'OAuth access denied', 401);
    }

    throw new AppError(desc ?? code, 400);
  }

  const { code, state } = q as GoogleCallbackSuccessQueryDto;

  const args = pickDefined<GoogleCallbackDto>({ code, state }, { ip, userAgent });

  const { result, accessToken, refreshToken } = await authServices.googleCallback(args);

  const isProd = env.NODE_ENV === 'production';

  const refreshTtl = getTtl(true, 'refresh');
  const accessTtl = getTtl(true, 'access');

  if (!refreshTtl || !accessTtl)
    throw new BadRequestError('Invalid JWT TTL: (expected e.g. "3600")');

  const baseCookie = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
  } as const;

  reply.clearCookie('guestId', {
    ...baseCookie,
    path: '/',
  });

  reply.clearCookie('accessToken', {
    ...baseCookie,
    path: '/',
  });

  reply.clearCookie('refreshToken', {
    ...baseCookie,
    path: '/',
  });

  reply.setCookie('accessToken', accessToken, {
    ...baseCookie,
    path: '/',
    maxAge: accessTtl as number,
  });

  reply.setCookie('refreshToken', refreshToken, {
    ...baseCookie,
    path: '/',
    maxAge: refreshTtl as number,
  });

  return result;
};

export const getVerifyEmail: ControllerRouter<{}, {}, VerifyEmailDto, MessageResponseDto> = async (
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
  const result = await authServices.passwordForgot(args);
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

  const result = await authServices.passwordReset(args);
  return reply.code(200).send(result);
};

const postLogout: ControllerRouter<{}, LogoutBodyDto, {}, void> = async (req, reply) => {
  const refreshToken = req.cookies?.refreshToken;
  const allDevices = req.body?.allDevices;
  const args = pickDefined<LogoutDto>({}, { refreshToken, allDevices });

  await authServices.logout(args);

  const isProd = env.NODE_ENV === 'production';

  const baseCookie = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
  } as const;

  reply.clearCookie('accessToken', { ...baseCookie, path: '/' });
  reply.clearCookie('refreshToken', { ...baseCookie, path: '/' });
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
  const { accessToken } = await authServices.refresh(args);

  return { accessToken };
};

export const authController = {
  postLogin,
  postRegister,
  getGoogleStart,
  getGoogleCallback,
  postVerifyResend,
  getVerifyEmail,
  postPasswordForgot,
  postPasswordReset,
  postLogout,
  postRefresh,
};
