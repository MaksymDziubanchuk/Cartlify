import { MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { fileStorage, detectImageType, makePublicId } from '@providers/files/index.js';
import { isAppError } from '@utils/errors.js';

import type { Role } from '@prisma/client';
import type { LoginResponseDto } from 'types/dto/auth.dto.js';

import type { IdentityProvider } from '@providers/identity/index.js';

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

// the picture of the account at its provider becomes the avatar of a new account:
// only the login that creates the account takes it (a later login and a login that links an
// account we have take nothing, so an avatar the person removed never comes back). The server
// downloads the picture itself and keeps it in the file storage under the path of the avatar, with the
// checks of an uploaded avatar: the type by its first bytes, the size limit. It waits for it at
// most PROVIDER_AVATAR_WAIT_MS; whatever goes wrong, the login goes on with the drawn letter and
// the reason goes to the log, without the address of the picture

export const PROVIDER_AVATAR_WAIT_MS = 4000;

// the size the server asks for, the biggest avatar it gives
const AVATAR_SIZE = 256;

export type ProviderAvatarLogger = { warn: (obj: unknown, msg?: string) => void };

class PictureRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
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
  provider: IdentityProvider;
  pictureUrl: string;
  log: ProviderAvatarLogger;
}): Promise<string | null> {
  const { userId, provider, log } = args;
  const refused = (reason: string) => {
    log.warn({ userId, provider: provider.name, reason }, 'provider avatar was not copied');
    return null;
  };

  // https on a host of the provider at the size of the biggest avatar, or never opened
  const url = provider.pictureUrl(args.pictureUrl, AVATAR_SIZE);
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

    const uploaded = await fileStorage.uploadImage({
      file: data,
      mimetype,
      publicId: makePublicId({ kind: 'avatar', userId }),
      tags: ['avatar', `user:${userId}`, `provider:${provider.name}`],
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
