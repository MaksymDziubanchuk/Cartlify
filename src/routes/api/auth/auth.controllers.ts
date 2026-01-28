import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { User, UserEntity } from 'types/user.js';
import type {
  LoginBodyDto,
  LoginDto,
  LoginResponseDto,
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

  const result = await authServices.login(args);
  return result;
};

const postVerifyResend: ControllerRouter<{}, ResendVerifyDto, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const result = await authServices.resendVerify(req.body);
  return reply.code(200).send(result);
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
  postVerifyResend,
  getVerifyEmail,
  postPasswordForgot,
  postPasswordReset,
  postLogout,
  postRefresh,
};
