import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';
import type {
  LoginBodyDto,
  LoginDto,
  RegisterBodyDto,
  RegisterDto,
  ResendVerifyDto,
  PasswordForgotBodyDto,
  PasswordResetBodyDto,
  PasswordResetQueryDto,
  PasswordResetDto,
  RefreshDto,
} from 'types/dto/auth.dto.js';

import { authServices } from './auth.services.js';
import pickDefined from '@helpers/parameterNormalize.js';

const postRegister: ControllerRouter<{}, RegisterBodyDto, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { email, password, name } = req.body;
  const args = pickDefined<RegisterDto>(
    {
      email,
      password,
    },
    { name },
  );
  const result = await authServices.register(args);
  return reply.code(201).send(result);
};

const postLogin: ControllerRouter<{}, LoginBodyDto, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { email, password, rememberMe } = req.body;
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];
  const args = pickDefined<LoginDto>(
    {
      email,
      password,
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
  postPasswordForgot,
  postPasswordReset,
  postLogout,
  postRefresh,
};
