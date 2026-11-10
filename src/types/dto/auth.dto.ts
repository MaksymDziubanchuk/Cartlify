import type { ProviderAvatarLogger } from '@routes/api/auth/services/helpers/providerAvatar.helper.js';
import type { Email } from 'types/common.js';
import type { UserId } from 'types/ids.js';
import type { UserResponseDto } from './users.dto.js';
import type { Role } from 'types/user.js';

export interface LoginBodyDto {
  email: Email;
  password: string;
  rememberMe?: boolean;
  acceptedDocumentIds?: number[];
}

export interface LoginDto {
  email: Email;
  password: string;
  userId: UserId;
  role: Role;
  rememberMe?: boolean;
  ip?: string;
  userAgent?: string;
  // the versions in force the customer accepts at this login
  acceptedDocumentIds?: number[];
}

export type LoginResponseDto = UserResponseDto;

export interface GoogleStartDto {
  guestId: UserId;
  role: Role;
  // the versions of the terms and of the contract the page sent with the start of the login
  acceptedDocumentIds?: number[];
  // the box of the newsletter the page ticked: a new account the login makes is subscribed
  newsletter?: boolean;
  ip?: string;
  userAgent?: string;
}

export interface OAuthStartQueryDto {
  acceptedDocumentIds?: string;
  newsletter?: boolean;
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
  // who finishes the login: it must be the guest who started it
  guestId: UserId;
  role: Role;
  ip?: string;
  userAgent?: string;
  // the copy of the picture of a new account logs what it could not take
  log: ProviderAvatarLogger;
}

export interface GithubStartDto {
  guestId: UserId;
  role: Role;
  // the versions of the terms and of the contract the page sent with the start of the login
  acceptedDocumentIds?: number[];
  // the box of the newsletter the page ticked: a new account the login makes is subscribed
  newsletter?: boolean;
  ip?: string;
  userAgent?: string;
}

export interface GithubStartResponseDto {
  url: string;
}

export interface GithubCallbackSuccessQueryDto {
  code: string;
  state: string;
}

export interface GithubCallbackErrorQueryDto {
  error: string;
  error_description?: string;
  error_uri?: string;
  state?: string;
}

export type GithubCallbackQueryDto = GithubCallbackSuccessQueryDto | GithubCallbackErrorQueryDto;

export interface GithubCallbackDto {
  code: string;
  state: string;
  // who finishes the login: it must be the guest who started it
  guestId: UserId;
  role: Role;
  ip?: string;
  userAgent?: string;
  // the copy of the picture of a new account logs what it could not take
  log: ProviderAvatarLogger;
}

export interface LinkedInStartDto {
  guestId: UserId;
  role: Role;
  // the versions of the terms and of the contract the page sent with the start of the login
  acceptedDocumentIds?: number[];
  // the box of the newsletter the page ticked: a new account the login makes is subscribed
  newsletter?: boolean;
  ip?: string;
  userAgent?: string;
}

export interface LinkedInStartResponseDto {
  url: string;
}

export interface LinkedInCallbackSuccessQueryDto {
  code: string;
  state: string;
}

export interface LinkedInCallbackErrorQueryDto {
  error: string;
  error_description?: string;
  error_uri?: string;
  state?: string;
}

export type LinkedInCallbackQueryDto =
  LinkedInCallbackSuccessQueryDto | LinkedInCallbackErrorQueryDto;

export interface LinkedInCallbackDto {
  code: string;
  state: string;
  // who finishes the login: it must be the guest who started it
  guestId: UserId;
  role: Role;
  ip?: string;
  userAgent?: string;
  // the copy of the picture of a new account logs what it could not take
  log: ProviderAvatarLogger;
}

export interface RegisterBodyDto {
  email: Email;
  password: string;
  userId: UserId;
  role: Role;
  name?: string;
  // a language the shop does not answer in, or the wrong shape, is dropped, not refused: the
  // confirmation mail still goes, in the language of the shop (src/helpers/locale.js)
  locale?: string;
  // the versions of the terms and of the contract in force the person accepts
  acceptedDocumentIds?: number[];
  // the box of the newsletter the form ticked: stored nowhere, it only puts a hint in the link of
  // the confirmation mail
  newsletter?: boolean;
  // the answer of the captcha, checked before the route runs (src/middlewares/requireCaptcha.ts)
  captchaToken: string;
}
export type RegisterDto = Omit<RegisterBodyDto, 'captchaToken'>;

export type RegisterResponseDto = UserResponseDto;

export interface ResendVerifyBodyDto {
  email: Email;
  // the answer of the captcha, checked before the route runs (src/middlewares/requireCaptcha.ts)
  captchaToken: string;
}

export type ResendVerifyDto = Omit<ResendVerifyBodyDto, 'captchaToken'>;

export interface VerifyEmailBodyDto {
  token: string;
  // the choice of the person on the page: subscribe the account once the email is confirmed
  newsletter?: boolean;
}

export interface VerifyEmailDto extends VerifyEmailBodyDto {
  // the guest of the browser that opens the link
  guestId?: string;
  // the address and the browser of the request, which the journal of a subscription keeps
  ip?: string | null;
  userAgent?: string | null;
}

export interface PasswordForgotBodyDto {
  email: Email;
  // the answer of the captcha, checked before the route runs (src/middlewares/requireCaptcha.ts)
  captchaToken: string;
}

export type PasswordForgotDto = Omit<PasswordForgotBodyDto, 'captchaToken'>;

export interface PasswordResetBodyDto {
  // the token of the link of the mail, which the page of the link reads after the # of the address
  token: string;
  newPassword: string;
}

export type PasswordResetDto = PasswordResetBodyDto;

export interface LogoutBodyDto {
  allDevices?: boolean;
}

export interface LogoutDto {
  // the signed-in user who logs out, the only one whose sessions may end
  userId: number;
  role: Role;
  refreshToken?: string;
  allDevices?: boolean;
}

export interface RefreshDto {
  refreshToken: string;
}

// GET /sessions, DELETE /sessions/:sessionId

export interface SessionItemDto {
  // the session, the same across its renewals
  id: string;
  // the user agent of the browser that opened it
  device: string | null;
  // when it was renewed last (or opened)
  lastUsedAt: Date;
  expiresAt: Date;
  // the session of this browser
  current: boolean;
}

export interface SessionsResponseDto {
  items: SessionItemDto[];
}

export interface SessionIdParamsDto {
  sessionId: string;
}

// POST /password/change

export interface PasswordChangeBodyDto {
  currentPassword: string;
  newPassword: string;
}

export interface CsrfTokenResponseDto {
  csrfToken: string;
}
