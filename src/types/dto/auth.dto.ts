import type { Email } from 'types/common.js';
import type { UserId } from 'types/ids.js';
import type { UserResponseDto } from './users.dto.js';
import type { Role } from 'types/user.js';

export interface LoginBodyDto {
  email: Email;
  password: string;
  rememberMe?: boolean;
}

export interface LoginDto {
  email: Email;
  password: string;
  userId: UserId;
  role: Role;
  rememberMe?: boolean;
  ip?: string;
  userAgent?: string;
}

export type LoginResponseDto = UserResponseDto;

export interface GoogleStartDto {
  guestId: UserId;
  role: Role;
  ip?: string;
  userAgent?: string;
}

export interface GoogleStartResponseDto {
  url: string;
}

export interface GoogleCallbackSuccessQueryDto {
  code: string;
  state: string;
}

export interface GoogleCallbackErrorQueryDto {
  error: string;
  error_description?: string;
  state?: string;
}

export type GoogleCallbackQueryDto = GoogleCallbackSuccessQueryDto | GoogleCallbackErrorQueryDto;

export interface GoogleCallbackDto {
  code: string;
  state: string;
  ip?: string;
  userAgent?: string;
}

export interface RegisterBodyDto {
  email: Email;
  password: string;
  userId: UserId;
  role: Role;
  name?: string;
}
export type RegisterDto = RegisterBodyDto;

export type RegisterResponseDto = UserResponseDto;

export interface ResendVerifyDto {
  email: Email;
}

export interface VerifyEmailDto {
  token: string;
}

export interface PasswordForgotBodyDto {
  email: Email;
}

export type PasswordForgotDto = PasswordForgotBodyDto;

export interface PasswordResetBodyDto {
  newPassword: string;
}

export interface PasswordResetQueryDto {
  token: string;
}

export interface PasswordResetDto {
  token: string;
  newPassword: string;
}

export interface LogoutDto {
  userId: UserId;
}

export interface RefreshDto {
  userId?: UserId;
}

export type RefreshResponseDto = UserResponseDto;
