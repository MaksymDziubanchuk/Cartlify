import { b64urlJson, signState } from '@helpers/b64Payload.js';
import { createPlaceholder, decodePlaceholderInternal } from '@helpers/placeholder.js';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  InternalError,
  UnauthorizedError,
} from '@utils/errors.js';

// The state of a login with a provider of accounts: it goes to the provider with the start and
// comes back with the callback, signed with the secret of the provider (its *_STATE_SECRET), alive
// for ten minutes and bound to the guest of the browser that started the login

export type OAuthState = {
  guestId: string;
  nonce: string;
  iat: number;
  exp: number;
  // the versions of the terms and of the contract the page of the shop sent with the start:
  // an account this login makes takes the consent to them
  accepted?: number[];
  // the box of the newsletter the page ticked: a new account this login makes is subscribed.
  // Read from a verified state only, and only the boolean true counts
  newsletter?: true;
};

const STATE_SECONDS = 10 * 60;

// a state signed with the secret of the provider
export function createOAuthState(
  provider: string,
  secret: string,
  guestId: string,
  accepted: readonly number[] = [],
  newsletter = false,
): string {
  if (!secret) throw new InternalError({ reason: 'OAUTH_STATE_SECRET_MISSING', provider });

  const now = Math.floor(Date.now() / 1000);

  const payload: OAuthState = {
    guestId,
    nonce: createPlaceholder(16, 'base64url'),
    iat: now,
    exp: now + STATE_SECONDS,
    ...(accepted.length ? { accepted: [...accepted] } : {}),
    ...(newsletter ? { newsletter: true as const } : {}),
  };

  // sign state for tamper check
  const payloadB64 = b64urlJson(payload);
  const sig = signState(payloadB64, secret);

  return `${payloadB64}.${sig}`;
}

// checks the signature of a state, its time window and the guest who finishes the login
export function verifyOAuthState(
  provider: string,
  secret: string,
  state: string,
  guestId: string,
): OAuthState {
  if (!secret) throw new InternalError({ reason: 'OAUTH_STATE_SECRET_MISSING', provider });

  // split payload and signature
  const [payloadB64, sig] = state.split('.');
  if (!payloadB64 || !sig) throw new BadRequestError('INVALID_STATE');

  // compare expected signature
  const expected = signState(payloadB64, secret);
  if (sig !== expected) throw new BadRequestError('INVALID_PAYLOAD');

  try {
    const json = decodePlaceholderInternal(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as OAuthState;

    const now = Math.floor(Date.now() / 1000);

    if (typeof payload.exp !== 'number' || payload.exp < now) {
      throw new UnauthorizedError('OAUTH_STATE_EXPIRED');
    }

    if (typeof payload.iat !== 'number') {
      throw new UnauthorizedError('OAUTH_STATE_IAT_INVALID');
    }

    if (payload.iat > now + 30) {
      throw new UnauthorizedError('OAUTH_STATE_IAT_IN_FUTURE');
    }

    if (payload.exp <= payload.iat) {
      throw new UnauthorizedError('OAUTH_STATE_TIME_RANGE_INVALID');
    }

    // the login was started by another guest, in another browser: finishing it here
    // would sign this browser into someone else's account (login csrf)
    if (payload.guestId !== guestId) {
      throw new ForbiddenError('OAUTH_STATE_GUEST_MISMATCH');
    }

    return payload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new InternalError({ reason: 'OAUTH_STATE_PARSE_FAILED', provider }, err);
  }
}
