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
  PasswordResetBodyDto,
  PasswordResetQueryDto,
  PasswordResetDto,
  RefreshDto,
} from 'types/dto/auth.dto.js';

import { authServices } from './auth.services.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { AppError } from '@utils/errors.js';

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

  const { result, refreshToken } = await authServices.login(args);

  // TODO: тут пізніше буде reply.setCookie('refreshToken', refreshToken, options)

  return result;
};

const postVerifyResend: ControllerRouter<{}, ResendVerifyDto, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const result = await authServices.resendVerify(req.body);
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
  MessageResponseDto
> = async (req) => {
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

  const result = await authServices.googleCallback(args);
  return result;
};

export const getVerifyEmail: ControllerRouter<{}, {}, VerifyEmailDto, MessageResponseDto> = async (
  req,
  reply,
) => {
  const result = await authServices.verifyEmail(req.query);
  return reply.code(200).send(result);
};

const postPasswordForgot: ControllerRouter<
  {},
  PasswordForgotBodyDto,
  {},
  MessageResponseDto
> = async (req, reply) => {
  const result = await authServices.passwordForgot(req.body);
  return reply.code(200).send(result);
};

const postPasswordReset: ControllerRouter<
  {},
  PasswordResetBodyDto,
  PasswordResetQueryDto,
  MessageResponseDto
> = async (req, reply) => {
  const args: PasswordResetDto = { token: req.query.token, newPassword: req.body.newPassword };
  const result = await authServices.passwordReset(args);
  return reply.code(200).send(result);
};

const postLogout: ControllerRouter<{}, {}, {}, unknown> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  await authServices.logout({ userId: id });
  return reply.code(204).send();
};

const postRefresh: ControllerRouter<{}, {}, {}, MessageResponseDto> = async (req, reply) => {
  const userId = (req.user as UserEntity | undefined)?.id;

  const args = pickDefined<RefreshDto>({}, { userId });

  const result = await authServices.refresh(args);
  return result;
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
