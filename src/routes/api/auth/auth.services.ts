import type {
  LoginDto,
  RegisterDto,
  ResendVerifyDto,
  PasswordForgotDto,
  PasswordResetDto,
  LogoutDto,
  RefreshDto,
} from 'types/dto/auth.dto.js';
import type { MessageResponseDto } from 'types/common.js';

async function login({
  email,
  password,
  rememberMe = false,
  ip,
  userAgent,
}: LoginDto): Promise<MessageResponseDto> {
  return { message: 'login not implemented' };
}

async function register({ email, password, name }: RegisterDto): Promise<MessageResponseDto> {
  return { message: 'register not implemented' };
}

async function resendVerify({ userId }: ResendVerifyDto): Promise<MessageResponseDto> {
  return { message: 'verify resend not implemented' };
}

async function passwordForgot({ email }: PasswordForgotDto): Promise<MessageResponseDto> {
  return { message: 'password forgot not implemented' };
}

async function passwordReset({
  token,
  newPassword,
}: PasswordResetDto): Promise<MessageResponseDto> {
  return { message: 'password reset not implemented' };
}

async function logout({ userId }: LogoutDto): Promise<void> {
  return;
}

async function refresh({ userId }: RefreshDto): Promise<MessageResponseDto> {
  return { message: 'refresh not implemented' };
}

export const authServices = {
  login,
  register,
  resendVerify,
  passwordForgot,
  passwordReset,
  logout,
  refresh,
};
