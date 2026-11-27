import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ControllerRouter } from 'types/controller.js';
import type { User } from 'types/user.js';
import type { UserId } from 'types/ids.js';
import type {
  LoginResponseDto,
  TrustedDeviceParamsDto,
  TwoFactorCodeBodyDto,
  TwoFactorConfirmBodyDto,
  TwoFactorProofBodyDto,
  TwoFactorRecoveryCodesResponseDto,
  TwoFactorSecretResponseDto,
  TwoFactorSetupResponseDto,
  TwoFactorStatusResponseDto,
  TwoFactorVerifyBodyDto,
} from 'types/dto/auth.dto.js';

import { getTtl } from '@utils/jwt.js';
import { isAppError } from '@utils/errors.js';

import { authServices } from './auth.services.js';
import {
  clearGuestIdCookie,
  setAccessTokenCookie,
  setRefreshTokenCookie,
} from './services/helpers/authCookies.helper.js';
import {
  clearTrustedDeviceCookie,
  clearTwoFactorTicketCookie,
  readTwoFactorTicket,
  setTrustedDeviceCookie,
  setTwoFactorTicketCookie,
  trustedDeviceCookieOf,
  twoFactorTicketCookieOf,
  type TwoFactorStage,
} from './services/helpers/twoFactorTicket.helper.js';
import type { SecondStepSession } from './services/twoFactor.service.js';

const cookiesOf = (req: FastifyRequest) =>
  (req.cookies ?? {}) as Record<string, string | undefined>;

const ticketOf = (req: FastifyRequest, stages: readonly TwoFactorStage[]) =>
  readTwoFactorTicket(twoFactorTicketCookieOf(cookiesOf(req)), stages);

const actorOf = (req: FastifyRequest) => {
  const { id, role } = req.user as User;
  return { id: Number(id), role };
};

// a pause of the second step gives the wait in retry-after too, as the pause of a password does
async function withPauseHeader<T>(reply: FastifyReply, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const wait = isAppError(err)
      ? (err.details as { retryAfterSeconds?: unknown })?.retryAfterSeconds
      : undefined;
    if (isAppError(err) && err.errorCode === 'TWO_FACTOR_PAUSED' && typeof wait === 'number') {
      reply.header('retry-after', String(wait));
    }
    throw err;
  }
}

// the session the second step opened: its cookies as after a login, the ticket goes, a browser the
// admin trusted gets its cookie
function setSessionCookies(reply: FastifyReply, session: SecondStepSession, rememberMe: boolean) {
  clearGuestIdCookie(reply);
  clearTwoFactorTicketCookie(reply);
  setAccessTokenCookie(reply, session.accessToken, getTtl(rememberMe, 'access'));
  setRefreshTokenCookie(reply, session.refreshToken, getTtl(rememberMe, 'refresh'));
  if (session.deviceCookie) setTrustedDeviceCookie(reply, session.deviceCookie);
}

const sessionContextOf = (req: FastifyRequest) => ({
  guestId: (req.user as User).id as UserId,
  ip: req.ip,
  userAgent: req.headers['user-agent'],
  log: req.log,
});

const postSetupStart: ControllerRouter<{}, {}, {}, TwoFactorSecretResponseDto> = async (
  req,
  reply,
) => {
  const started = await authServices.startTwoFactorSetup(ticketOf(req, ['setup']));
  setTwoFactorTicketCookie(reply, started.ticket);

  return { otpauthUrl: started.otpauthUrl, secret: started.secret };
};

const postSetupConfirm: ControllerRouter<
  {},
  TwoFactorConfirmBodyDto,
  {},
  TwoFactorSetupResponseDto
> = async (req, reply) => {
  const ticket = ticketOf(req, ['setup']);
  const session = await authServices.confirmTwoFactorSetup(ticket, {
    ...sessionContextOf(req),
    code: req.body.code,
    trustDevice: req.body.trustDevice,
  });
  setSessionCookies(reply, session, ticket.rememberMe);

  return { ...session.result, recoveryCodes: session.recoveryCodes ?? [] };
};

const postVerify: ControllerRouter<{}, TwoFactorVerifyBodyDto, {}, LoginResponseDto> = async (
  req,
  reply,
) => {
  const ticket = ticketOf(req, ['code']);
  const session = await withPauseHeader(reply, () =>
    authServices.verifyTwoFactor(ticket, {
      ...sessionContextOf(req),
      code: req.body.code,
      recoveryCode: req.body.recoveryCode,
      trustDevice: req.body.trustDevice,
    }),
  );
  setSessionCookies(reply, session, ticket.rememberMe);

  return session.result;
};

const getStatus: ControllerRouter<{}, {}, {}, TwoFactorStatusResponseDto> = async (req) =>
  authServices.twoFactorStatus(actorOf(req), trustedDeviceCookieOf(cookiesOf(req)));

const deleteDevice: ControllerRouter<TrustedDeviceParamsDto, {}, {}, void> = async (req, reply) => {
  const { deviceId } = req.params;
  await authServices.forgetTrustedDevice(actorOf(req), deviceId);

  // the cookie of this browser goes with it
  if (trustedDeviceCookieOf(cookiesOf(req))?.startsWith(`${deviceId}.`)) {
    clearTrustedDeviceCookie(reply);
  }
  return reply.code(204).send();
};

const postRecoveryCodes: ControllerRouter<
  {},
  TwoFactorCodeBodyDto,
  {},
  TwoFactorRecoveryCodesResponseDto
> = async (req, reply) => {
  const recoveryCodes = await withPauseHeader(reply, () =>
    authServices.renewRecoveryCodes(actorOf(req), req.body.code),
  );
  return { recoveryCodes };
};

const postReplaceStart: ControllerRouter<
  {},
  TwoFactorProofBodyDto,
  {},
  TwoFactorSecretResponseDto
> = async (req, reply) => {
  const started = await withPauseHeader(reply, () =>
    authServices.startTwoFactorReplace(
      actorOf(req),
      { code: req.body?.code, recoveryCode: req.body?.recoveryCode },
      req.issuedRefreshToken ?? cookiesOf(req).refreshToken,
    ),
  );
  setTwoFactorTicketCookie(reply, started.ticket);

  return { otpauthUrl: started.otpauthUrl, secret: started.secret };
};

const postReplaceConfirm: ControllerRouter<{}, TwoFactorCodeBodyDto, {}, void> = async (
  req,
  reply,
) => {
  await authServices.confirmTwoFactorReplace(
    actorOf(req),
    ticketOf(req, ['replace']),
    req.body.code,
  );
  clearTwoFactorTicketCookie(reply);
  // the new app forgets the trusted browsers, this one too
  clearTrustedDeviceCookie(reply);

  return reply.code(204).send();
};

export const twoFactorController = {
  postSetupStart,
  postSetupConfirm,
  postVerify,
  getStatus,
  deleteDevice,
  postRecoveryCodes,
  postReplaceStart,
  postReplaceConfirm,
};
