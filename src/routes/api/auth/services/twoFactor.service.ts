import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type Role } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { shopSettings } from '@config/shopSettings.js';
import { deviceLabel } from '@helpers/twoFactor/deviceLabel.js';
import { newRecoveryCodes, recoveryCodeHash } from '@helpers/twoFactor/recoveryCodes.js';
import { matchTotpCode, newTotpSecret, otpauthUrl } from '@helpers/twoFactor/totp.js';
import {
  decryptTwoFactorSecret,
  encryptTwoFactorSecret,
} from '@helpers/twoFactor/twoFactorKeys.js';
import { hashToken, verifyTokenHash } from '@helpers/tokenHash.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} from '@utils/errors.js';
import type { UserId } from 'types/ids.js';

import { openSession, type OpenedSession } from './helpers/openSession.helper.js';
import { currentSessionIdOf } from './sessions.service.js';
import { sendTwoFactorNoticeEmail } from './helpers/sendTwoFactorNoticeEmail.helper.js';
import { TRUSTED_DEVICE_TTL_SEC, type TwoFactorTicket } from './helpers/twoFactorTicket.helper.js';

type Tx = Prisma.TransactionClient;

// A browser an admin trusts: the code of the app is not asked on it for 30 days
export type TrustedDevice = {
  id: string;
  tokenHash: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
};

type Row = {
  userId: number;
  secretEnc: string;
  enabledAt: Date;
  lastUsedStep: number;
  recoveryCodes: string[];
  usedRecoveryCodes: string[];
  trustedDevices: TrustedDevice[];
  failedCodes: number;
  pausedUntil: Date | null;
};

// what proves the person at the second step: a code of the app, or a recovery code
export type TwoFactorProof = { code?: string | undefined; recoveryCode?: string | undefined };

// five wrong codes in a row pause the second step of the account for 15 minutes; a used recovery
// code is no guess and does not count
const FAILURES_BEFORE_PAUSE = 5;
const PAUSE_MS = 15 * 60 * 1000;
// a login with a recovery code lets the move to a new app go without another proof this long
const RECENT_RECOVERY_LOGIN_MS = 10 * 60 * 1000;
const MAX_TRUSTED_DEVICES = 10;

export const isStaff = (role: Role): role is 'ADMIN' | 'ROOT' =>
  role === 'ADMIN' || role === 'ROOT';

// the row of the account, locked for the rest of the transaction: two logins of one admin at once
// change the codes and the browsers one after the other
async function lockRow(tx: Tx, userId: number): Promise<Row | null> {
  const rows = await tx.$queryRaw<Row[]>`
    select "userId", "secretEnc", "enabledAt", "lastUsedStep", "recoveryCodes",
      "usedRecoveryCodes", "trustedDevices", "failedCodes", "pausedUntil"
    from cartlify.user_two_factor
    where "userId" = ${userId}::int
    for update
  `;

  return rows[0] ?? null;
}

const liveDevices = (devices: TrustedDevice[], now: Date) =>
  devices.filter((device) => new Date(device.expiresAt).getTime() > now.getTime());

const devicesJson = (devices: TrustedDevice[]) => devices as unknown as Prisma.InputJsonValue;

// the device of the cookie <id>.<token> among the live ones of the row
function deviceOfCookie(devices: TrustedDevice[], cookie: string | undefined) {
  if (!cookie) return undefined;
  const dot = cookie.indexOf('.');
  if (dot <= 0) return undefined;

  const id = cookie.slice(0, dot);
  const token = cookie.slice(dot + 1);
  const device = devices.find((one) => one.id === id);

  return device && token && verifyTokenHash(token, device.tokenHash) ? device : undefined;
}

// a new trusted browser; the eleventh pushes out the oldest
function trustDevice(devices: TrustedDevice[], userAgent: string | undefined, now: Date) {
  const token = randomBytes(32).toString('base64url');
  const device: TrustedDevice = {
    id: randomUUID(),
    tokenHash: hashToken(token),
    label: deviceLabel(userAgent),
    createdAt: now.toISOString(),
    lastUsedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TRUSTED_DEVICE_TTL_SEC * 1000).toISOString(),
  };
  const kept = [...devices]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-(MAX_TRUSTED_DEVICES - 1));

  return { devices: [...kept, device], cookie: `${device.id}.${token}` };
}

function assertNotPaused(row: Row, now: Date) {
  if (row.pausedUntil && row.pausedUntil.getTime() > now.getTime()) {
    const retryAfterSeconds = Math.ceil((row.pausedUntil.getTime() - now.getTime()) / 1000);
    throw new TooManyRequestsError('TWO_FACTOR_PAUSED', { retryAfterSeconds });
  }
}

type ProofTaken =
  | { ok: true; data: Prisma.UserTwoFactorUpdateInput; recovery: boolean; codesLeft: number }
  | { ok: false; data: Prisma.UserTwoFactorUpdateInput; error: AppError };

// checks the proof against the row: the update it needs (the step taken, the recovery code moved to
// the used ones, the count of wrong codes back at 0) or the refusal and the count it leaves
function takeProof(
  row: Row,
  proof: TwoFactorProof,
  now: Date,
  { recovery }: { recovery: boolean },
): ProofTaken {
  const code = proof.code?.trim();
  const recoveryCode = recovery ? proof.recoveryCode?.trim() : undefined;
  if (!code === !recoveryCode) {
    throw new BadRequestError(recovery ? 'TWO_FACTOR_PROOF_REQUIRED' : 'TWO_FACTOR_CODE_REQUIRED');
  }

  const passed = { failedCodes: 0, pausedUntil: null };

  if (code) {
    const step = matchTotpCode(decryptTwoFactorSecret(row.secretEnc), code, {
      lastUsedStep: row.lastUsedStep,
      nowMs: now.getTime(),
    });
    if (step !== null) {
      return {
        ok: true,
        data: { ...passed, lastUsedStep: step },
        recovery: false,
        codesLeft: row.recoveryCodes.length,
      };
    }
  } else if (recoveryCode) {
    const hash = recoveryCodeHash(recoveryCode);
    if (row.recoveryCodes.includes(hash)) {
      const left = row.recoveryCodes.filter((one) => one !== hash);
      return {
        ok: true,
        data: {
          ...passed,
          recoveryCodes: left,
          usedRecoveryCodes: [...row.usedRecoveryCodes, hash],
        },
        recovery: true,
        codesLeft: left.length,
      };
    }
    if (row.usedRecoveryCodes.includes(hash)) {
      return { ok: false, data: {}, error: new UnauthorizedError('TWO_FACTOR_RECOVERY_CODE_USED') };
    }
  }

  const failures = row.failedCodes + 1;
  const paused = failures >= FAILURES_BEFORE_PAUSE;

  return {
    ok: false,
    data: paused
      ? { failedCodes: 0, pausedUntil: new Date(now.getTime() + PAUSE_MS) }
      : { failedCodes: failures },
    error: new UnauthorizedError('TWO_FACTOR_CODE_INVALID'),
  };
}

const auditOf = (
  tx: Tx,
  actor: { id: number; role: Role },
  entityId: number,
  event:
    | 'two_factor.enable'
    | 'two_factor.replace'
    | 'two_factor.recovery_login'
    | 'two_factor.recovery_renew'
    | 'two_factor.device_forget'
    | 'two_factor.reset',
  change: { field: string; old: unknown; new: unknown },
) =>
  writeAdminAuditLog(tx, {
    actorId: actor.id as UserId,
    actorRole: actor.role,
    entityType: 'user',
    entityId,
    action: 'OTHER',
    event,
    changes: [change],
  });

// runs the work in a transaction as the account; a refusal the work returns (a wrong code) is
// thrown after the commit, so the count of wrong codes it wrote stays
async function asAccount<T>(
  user: { id: number; role: Role },
  work: (tx: Tx) => Promise<T | AppError>,
): Promise<T> {
  let outcome: T | AppError;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: user.id, role: user.role });
      return work(tx);
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new InternalError({ reason: 'TWO_FACTOR_SERVICE_UNEXPECTED' }, err);
  }

  if (outcome instanceof AppError) throw outcome;
  return outcome;
}

// THE FIRST STEP

export type SecondStep = {
  twoFactor: 'setup' | 'code';
  canTrustDevice: boolean;
  ticket: TwoFactorTicket;
};

// After the password or the provider let an ADMIN or ROOT in: the second step the login asks for, or
// null when the login goes on at once (a customer; an admin on a browser it trusts, whose last use
// moves to now). It runs inside the login transaction and leaves it in the context of the account.
export async function secondStepOfLogin(
  tx: Tx,
  args: {
    userId: number;
    role: Role;
    event: TwoFactorTicket['event'];
    rememberMe: boolean;
    deviceCookie?: string | undefined;
    now?: Date;
  },
): Promise<SecondStep | null> {
  const { userId, role } = args;
  if (!isStaff(role)) return null;

  const now = args.now ?? new Date();
  await setUserContext(tx, { userId, role });
  const row = await lockRow(tx, userId);

  const ticket = (stage: 'setup' | 'code'): SecondStep => ({
    twoFactor: stage,
    canTrustDevice: role === 'ADMIN',
    ticket: { userId, role, stage, event: args.event, rememberMe: args.rememberMe },
  });

  if (!row) return ticket('setup');

  const devices = liveDevices(row.trustedDevices, now);
  const device = role === 'ADMIN' ? deviceOfCookie(devices, args.deviceCookie) : undefined;
  if (device) device.lastUsedAt = now.toISOString();

  if (device || devices.length !== row.trustedDevices.length) {
    await tx.userTwoFactor.update({
      where: { userId },
      data: { trustedDevices: devicesJson(devices) },
    });
  }

  return device ? null : ticket('code');
}

// THE SECOND STEP OF A LOGIN

// the account of the ticket as it is now: the role it had at the first step, not deleted since. A
// role changed or an account deleted while the ticket was out ends the login: it starts again
async function accountOfTicket(tx: Tx, ticket: TwoFactorTicket): Promise<{ email: string }> {
  const found = await tx.user.findUnique({
    where: { id: ticket.userId },
    select: { email: true, role: true, deletedAt: true },
  });
  if (!found || found.deletedAt || found.role !== ticket.role) {
    throw new UnauthorizedError('TWO_FACTOR_TICKET_INVALID');
  }
  return { email: found.email };
}

type SessionContext = {
  guestId: UserId;
  ip?: string | undefined;
  userAgent?: string | undefined;
  log: FastifyBaseLogger;
};

export type SecondStepSession = OpenedSession & { deviceCookie?: string; recoveryCodes?: string[] };

// an account without a second step starts its setup: a new secret, kept encrypted in the ticket
// until the first code of the app confirms it
export async function startTwoFactorSetup(
  ticket: TwoFactorTicket,
): Promise<{ ticket: TwoFactorTicket; otpauthUrl: string; secret: string }> {
  const user = { id: ticket.userId, role: ticket.role };

  const email = await asAccount(user, async (tx) => {
    const { email: address } = await accountOfTicket(tx, ticket);
    if (await lockRow(tx, user.id)) return new ConflictError('TWO_FACTOR_ALREADY_ENABLED');
    return address;
  });

  const secret = newTotpSecret();

  return {
    ticket: { ...ticket, pending: encryptTwoFactorSecret(secret) },
    otpauthUrl: otpauthUrl({ secret, issuer: shopSettings().shopName, account: email }),
    secret,
  };
}

// the first code of the new app confirms the secret: the row is written with a set of recovery
// codes (shown this once), and the session opens
export async function confirmTwoFactorSetup(
  ticket: TwoFactorTicket,
  args: SessionContext & { code: string; trustDevice?: boolean | undefined },
): Promise<SecondStepSession> {
  if (!ticket.pending) throw new UnauthorizedError('TWO_FACTOR_TICKET_INVALID');

  const now = new Date();
  const step = matchTotpCode(decryptTwoFactorSecret(ticket.pending), args.code, {
    lastUsedStep: 0,
    nowMs: now.getTime(),
  });
  if (step === null) throw new UnauthorizedError('TWO_FACTOR_CODE_INVALID');

  const user = { id: ticket.userId, role: ticket.role };
  const codes = newRecoveryCodes();
  const trusted =
    args.trustDevice && user.role === 'ADMIN' ? trustDevice([], args.userAgent, now) : undefined;

  const session = await asAccount(user, async (tx) => {
    await accountOfTicket(tx, ticket);

    // a confirmation of the same ticket at the same time waits for this one and writes nothing
    const written = await tx.$queryRaw<{ userId: number }[]>`
      insert into cartlify.user_two_factor
        ("userId", "secretEnc", "enabledAt", "lastUsedStep", "recoveryCodes", "trustedDevices")
      values (
        ${user.id}::int,
        ${ticket.pending},
        ${now},
        ${step}::int,
        ${codes.map(recoveryCodeHash)}::text[],
        ${JSON.stringify(trusted?.devices ?? [])}::jsonb
      )
      on conflict ("userId") do nothing
      returning "userId"
    `;
    if (written.length === 0) return new ConflictError('TWO_FACTOR_ALREADY_ENABLED');

    await auditOf(tx, user, user.id, 'two_factor.enable', {
      field: 'twoFactor',
      old: null,
      new: 'enabled',
    });

    return openSession(tx, {
      userId: user.id,
      role: user.role,
      guestId: args.guestId,
      rememberMe: ticket.rememberMe,
      event: ticket.event,
      ip: args.ip,
      userAgent: args.userAgent,
    });
  });

  return { ...session, recoveryCodes: codes, ...(trusted ? { deviceCookie: trusted.cookie } : {}) };
}

// the code of the app or a recovery code finishes the login; an admin may trust the browser
export async function verifyTwoFactor(
  ticket: TwoFactorTicket,
  args: SessionContext & TwoFactorProof & { trustDevice?: boolean | undefined },
): Promise<SecondStepSession> {
  const user = { id: ticket.userId, role: ticket.role };
  const now = new Date();
  let recoveryLeft: number | undefined;
  let deviceCookie: string | undefined;

  const session = await asAccount(user, async (tx) => {
    // root reset the second step, changed the role or deleted the account while the ticket was
    // out: the login starts again
    await accountOfTicket(tx, ticket);
    const row = await lockRow(tx, user.id);
    if (!row) return new UnauthorizedError('TWO_FACTOR_TICKET_INVALID');
    assertNotPaused(row, now);

    const taken = takeProof(row, args, now, { recovery: true });
    if (!taken.ok) {
      if (Object.keys(taken.data).length) {
        await tx.userTwoFactor.update({ where: { userId: user.id }, data: taken.data });
      }
      return taken.error;
    }

    let devices = liveDevices(row.trustedDevices, now);
    if (args.trustDevice && user.role === 'ADMIN') {
      const trusted = trustDevice(devices, args.userAgent, now);
      devices = trusted.devices;
      deviceCookie = trusted.cookie;
    }

    await tx.userTwoFactor.update({
      where: { userId: user.id },
      data: { ...taken.data, trustedDevices: devicesJson(devices) },
    });

    const opened = await openSession(tx, {
      userId: user.id,
      role: user.role,
      guestId: args.guestId,
      rememberMe: ticket.rememberMe,
      event: ticket.event,
      ip: args.ip,
      userAgent: args.userAgent,
    });

    // the line names the session the recovery code opened: only that session moves to a new app
    // without another proof (recentRecoveryLogin)
    if (taken.recovery) {
      recoveryLeft = taken.codesLeft;
      await writeAdminAuditLog(tx, {
        actorId: user.id as UserId,
        actorRole: user.role,
        entityType: 'user',
        entityId: user.id,
        action: 'OTHER',
        event: 'two_factor.recovery_login',
        changes: [
          { field: 'recoveryCodes', old: taken.codesLeft + 1, new: taken.codesLeft },
          {
            field: 'sessionId',
            old: null,
            new: await currentSessionIdOf(tx, user.id, opened.refreshToken),
          },
        ],
      });
    }

    return opened;
  });

  if (recoveryLeft !== undefined) {
    await sendTwoFactorNoticeEmail(
      {
        kind: 'recovery',
        to: session.result.email,
        at: now,
        recoveryCodesLeft: recoveryLeft,
        userName: session.result.name ?? null,
        locale: session.result.locale ?? null,
      },
      args.log,
    );
  }

  return { ...session, ...(deviceCookie ? { deviceCookie } : {}) };
}

// SIGNED IN

type Actor = { id: number; role: Role };

const requireRow = async (tx: Tx, userId: number) => {
  const row = await lockRow(tx, userId);
  // an access token of a session from before the second step, or of a reset one
  if (!row) throw new NotFoundError('TWO_FACTOR_NOT_FOUND');
  return row;
};

export type TwoFactorStatus = {
  enabledAt: Date;
  recoveryCodesLeft: number;
  devices: {
    id: string;
    label: string;
    createdAt: string;
    lastUsedAt: string;
    expiresAt: string;
    current: boolean;
  }[];
};

// the second step of the account as its profile shows it: the browsers without their tokens
export async function twoFactorStatus(
  actor: Actor,
  deviceCookie: string | undefined,
): Promise<TwoFactorStatus> {
  return asAccount(actor, async (tx) => {
    const row = await requireRow(tx, actor.id);
    const now = new Date();
    const devices = liveDevices(row.trustedDevices, now);
    const current = deviceOfCookie(devices, deviceCookie);

    return {
      enabledAt: row.enabledAt,
      recoveryCodesLeft: row.recoveryCodes.length,
      devices: devices.map(({ id, label, createdAt, lastUsedAt, expiresAt }) => ({
        id,
        label,
        createdAt,
        lastUsedAt,
        expiresAt,
        current: id === current?.id,
      })),
    };
  });
}

// the admin no longer trusts a browser: the code is asked on it at the next login
export async function forgetTrustedDevice(actor: Actor, deviceId: string): Promise<void> {
  await asAccount(actor, async (tx) => {
    const row = await requireRow(tx, actor.id);
    const device = row.trustedDevices.find((one) => one.id === deviceId);
    if (!device) return new NotFoundError('TRUSTED_DEVICE_NOT_FOUND');

    await tx.userTwoFactor.update({
      where: { userId: actor.id },
      data: {
        trustedDevices: devicesJson(row.trustedDevices.filter((one) => one.id !== deviceId)),
      },
    });
    await auditOf(tx, actor, actor.id, 'two_factor.device_forget', {
      field: 'trustedDevice',
      old: device.label,
      new: null,
    });
    return undefined;
  });
}

// a new set of recovery codes for a code of the app; the old ones stop working
export async function renewRecoveryCodes(actor: Actor, code: string): Promise<string[]> {
  const now = new Date();
  const codes = newRecoveryCodes();

  return asAccount(actor, async (tx) => {
    const row = await requireRow(tx, actor.id);
    assertNotPaused(row, now);

    const taken = takeProof(row, { code }, now, { recovery: false });
    if (!taken.ok) {
      await tx.userTwoFactor.update({ where: { userId: actor.id }, data: taken.data });
      return taken.error;
    }

    await tx.userTwoFactor.update({
      where: { userId: actor.id },
      data: { ...taken.data, recoveryCodes: codes.map(recoveryCodeHash), usedRecoveryCodes: [] },
    });
    await auditOf(tx, actor, actor.id, 'two_factor.recovery_renew', {
      field: 'recoveryCodes',
      old: row.recoveryCodes.length,
      new: codes.length,
    });
    return codes;
  });
}

// whether this session was opened by a recovery code in the last minutes: that login proved the
// person, the move to a new app asks nothing more. Another session of the account (a stolen one)
// gets no such way
async function recentRecoveryLogin(
  tx: Tx,
  actor: Actor,
  now: Date,
  refreshToken: string | undefined,
): Promise<boolean> {
  const sessionId = await currentSessionIdOf(tx, actor.id, refreshToken);
  if (!sessionId) return false;

  const since = new Date(now.getTime() - RECENT_RECOVERY_LOGIN_MS);
  const lines = await tx.$queryRaw<{ id: number }[]>`
    select id from cartlify.admin_audit_log
    where "actorId" = ${actor.id}::int
      and event = 'two_factor.recovery_login'
      and "createdAt" > ${since}
      and meta @> ${JSON.stringify([{ field: 'sessionId', new: sessionId }])}::jsonb
    limit 1
  `;
  return lines.length > 0;
}

// the move to a new app: a code of the old app or a recovery code proves the person (none needed
// right after a login with a recovery code); the new secret waits in the ticket
export async function startTwoFactorReplace(
  actor: Actor,
  proof: TwoFactorProof,
  refreshToken?: string,
): Promise<{ ticket: TwoFactorTicket; otpauthUrl: string; secret: string }> {
  if (!isStaff(actor.role)) throw new ForbiddenError('INSUFFICIENT_ROLE');
  const now = new Date();

  const email = await asAccount(actor, async (tx) => {
    const row = await requireRow(tx, actor.id);
    assertNotPaused(row, now);

    const found = await tx.user.findUnique({ where: { id: actor.id }, select: { email: true } });
    if (!found) throw new NotFoundError('TWO_FACTOR_NOT_FOUND');

    if (
      !proof.code &&
      !proof.recoveryCode &&
      (await recentRecoveryLogin(tx, actor, now, refreshToken))
    ) {
      return found.email;
    }

    const taken = takeProof(row, proof, now, { recovery: true });
    // a used recovery code changes nothing
    if (Object.keys(taken.data).length) {
      await tx.userTwoFactor.update({ where: { userId: actor.id }, data: taken.data });
    }
    return taken.ok ? found.email : taken.error;
  });

  const secret = newTotpSecret();

  return {
    ticket: {
      userId: actor.id,
      role: actor.role,
      stage: 'replace',
      event: 'login.password',
      rememberMe: false,
      pending: encryptTwoFactorSecret(secret),
    },
    otpauthUrl: otpauthUrl({ secret, issuer: shopSettings().shopName, account: email }),
    secret,
  };
}

// the first code of the new app makes it the one: the old app stops working, the session goes on
export async function confirmTwoFactorReplace(
  actor: Actor,
  ticket: TwoFactorTicket,
  code: string,
): Promise<void> {
  if (ticket.userId !== actor.id || !ticket.pending) {
    throw new UnauthorizedError('TWO_FACTOR_TICKET_INVALID');
  }

  const now = new Date();
  const step = matchTotpCode(decryptTwoFactorSecret(ticket.pending), code, {
    lastUsedStep: 0,
    nowMs: now.getTime(),
  });
  if (step === null) throw new UnauthorizedError('TWO_FACTOR_CODE_INVALID');

  await asAccount(actor, async (tx) => {
    await requireRow(tx, actor.id);
    await tx.userTwoFactor.update({
      where: { userId: actor.id },
      // the browsers trusted while the old app was in use are trusted no more: the code is asked on
      // each at its next login
      data: {
        secretEnc: ticket.pending!,
        lastUsedStep: step,
        failedCodes: 0,
        pausedUntil: null,
        trustedDevices: devicesJson([]),
      },
    });
    await auditOf(tx, actor, actor.id, 'two_factor.replace', {
      field: 'twoFactorApp',
      old: 'replaced',
      new: 'new',
    });
    return undefined;
  });
}
