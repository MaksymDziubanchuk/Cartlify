import { MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { detectImageType, makePublicId, uploadImage } from '@utils/cloudinary.util.js';
import { isAppError } from '@utils/errors.js';

import type { Role } from '@prisma/client';
import type { LoginResponseDto } from 'types/dto/auth.dto.js';

import type { OAuthProvider } from './oauthUserUpsert.helper.js';

// what an oauth login gives its service: the session, and whether it made the account
export type OAuthLoginOutcome = {
  result: LoginResponseDto;
  accessToken: string;
  refreshToken: string;
  created: boolean;
  role: Role;
  userId: number;
};

export type OAuthAvatarRole = 'USER' | 'ADMIN' | 'ROOT';

// the picture of the account at Google, GitHub or LinkedIn becomes the avatar of a new account:
// only the login that creates the account takes it (a later login and a login that links an
// account we have take nothing, so an avatar the person removed never comes back). The server
// downloads the picture itself and keeps it at Cloudinary under the path of the avatar, with the
// checks of an uploaded avatar: the type by its first bytes, the size limit. It waits for it at
// most PROVIDER_AVATAR_WAIT_MS; whatever goes wrong, the login goes on with the drawn letter and
// the reason goes to the log, without the address of the picture

export const PROVIDER_AVATAR_WAIT_MS = 4000;

// the size the server asks for, the biggest avatar it gives
const AVATAR_SIZE = 256;

// the hosts the providers keep the pictures on; any other address is never opened, the address
// comes from the provider but the server does not follow it anywhere
const PICTURE_HOSTS: Record<OAuthProvider, (host: string) => boolean> = {
  GOOGLE: (host) => host.endsWith('.googleusercontent.com'),
  GITHUB: (host) => host === 'avatars.githubusercontent.com',
  LINKEDIN: (host) => host === 'media.licdn.com',
};

export type ProviderAvatarLogger = { warn: (obj: unknown, msg?: string) => void };

class PictureRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

// the address to download: https on a host of the provider, at the size of the biggest avatar
// (Google takes the size at the end of the path, =s96-c by default; GitHub in the query)
export function providerPictureUrl(provider: OAuthProvider, raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!PICTURE_HOSTS[provider](host)) return null;

  if (provider === 'GOOGLE') {
    url.pathname = url.pathname.replace(/=s\d+(-c)?$/, `=s${AVATAR_SIZE}-c`);
  }
  if (provider === 'GITHUB') url.searchParams.set('s', String(AVATAR_SIZE));

  return url;
}

// the body of the answer, stopped as soon as it is over the limit
async function readPicture(res: Response): Promise<Buffer> {
  const length = Number(res.headers.get('content-length'));
  if (length > MAX_UPLOAD_SIZE_BYTES) throw new PictureRefused('too_big');

  const reader = res.body?.getReader();
  if (!reader) throw new PictureRefused('empty');

  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    size += value.length;
    if (size > MAX_UPLOAD_SIZE_BYTES) {
      await reader.cancel();
      throw new PictureRefused('too_big');
    }
    chunks.push(Buffer.from(value));
  }

  if (!size) throw new PictureRefused('empty');
  return Buffer.concat(chunks);
}

// copies the picture into the avatar of the account; the url of the avatar, or null when there is
// none to take. It never throws
export async function copyProviderAvatar(args: {
  userId: number;
  role: 'USER' | 'ADMIN' | 'ROOT';
  provider: OAuthProvider;
  pictureUrl: string;
  log: ProviderAvatarLogger;
}): Promise<string | null> {
  const { userId, provider, log } = args;
  const refused = (reason: string) => {
    log.warn({ userId, provider, reason }, 'provider avatar was not copied');
    return null;
  };

  const url = providerPictureUrl(provider, args.pictureUrl);
  if (!url) return refused('host_not_allowed');

  const deadline = Date.now() + PROVIDER_AVATAR_WAIT_MS;
  const signal = AbortSignal.timeout(PROVIDER_AVATAR_WAIT_MS);

  try {
    // a redirect could lead anywhere: the picture is at the address of the provider or nowhere
    const res = await fetch(url, { signal, redirect: 'error' });
    if (!res.ok) throw new PictureRefused(`status_${res.status}`);

    const data = await readPicture(res);
    const mimetype = detectImageType(data);
    if (!mimetype) throw new PictureRefused('not_an_image');

    const uploaded = await uploadImage({
      file: data,
      mimetype,
      publicId: makePublicId({ kind: 'avatar', userId }),
      tags: ['avatar', `user:${userId}`, `provider:${provider.toLowerCase()}`],
      timeout: Math.max(deadline - Date.now(), 1),
    });

    // the account was created by this login and has no avatar of its own yet
    await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId, role: args.role });
      await tx.user.updateMany({
        where: { id: userId, avatarUrl: null },
        data: { avatarUrl: uploaded.urlBase, publicId: uploaded.publicId },
      });
    });

    return uploaded.urlBase;
  } catch (err) {
    if (err instanceof PictureRefused) return refused(err.reason);
    if (signal.aborted) return refused('timeout');
    return refused(isAppError(err) ? err.errorCode : 'failed');
  }
}
