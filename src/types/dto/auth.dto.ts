import type { Email } from 'types/common.js';
import type { UserId } from 'types/ids.js';
import type { UserResponseDto } from './users.dto.js';

export interface LoginBodyDto {
  email: Email;
  password: string;
  rememberMe?: boolean;
}

export interface LoginDto {
  email: Email;
  password: string;
  rememberMe?: boolean;
  ip?: string;
  userAgent?: string;
}

export type LoginResponseDto = UserResponseDto;

export interface RegisterBodyDto {
  email: Email;
  password: string;
  name?: string;
}
export type RegisterDto = RegisterBodyDto;

export type RegisterResponseDto = UserResponseDto;

export interface ResendVerifyDto {
  userId: UserId;
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
