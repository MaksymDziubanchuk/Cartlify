import env from '@config/env.js';

import { pickProvider } from '../provider.js';

import { cloudinaryStorage } from './cloudinary/cloudinary.storage.js';
import { FILE_STORAGE_PROVIDER_NAMES } from './names.js';

import type { FastifyBaseLogger } from 'fastify';
import type { FileStorageProvider } from './types.js';

export * from './files.js';
export * from './names.js';
export type * from './types.js';

// every storage of files this server has; FILE_STORAGE_PROVIDER names the one it keeps them in
const providers: readonly FileStorageProvider[] = [cloudinaryStorage];

// the list the settings take the names from is the list of the providers themselves
if (
  providers.length !== FILE_STORAGE_PROVIDER_NAMES.length ||
  providers.some((provider, i) => provider.name !== FILE_STORAGE_PROVIDER_NAMES[i])
) {
  throw new Error('FILE_STORAGE_PROVIDER_NAMES must name the file storages in the same order');
}

export const fileStorage: FileStorageProvider = pickProvider(
  'FILE_STORAGE_PROVIDER',
  env.FILE_STORAGE_PROVIDER,
  providers,
);

// deletes the waiting uploads of a request that was refused, once each has finished; it never
// throws, a file it cannot delete goes to the log. An upload that was moved to its place is gone
// from the waiting id already, which the storage takes as no error
export async function discardUploads(
  uploads: ReadonlyArray<Promise<{ publicId: string }>>,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<void> {
  const results = await Promise.allSettled(uploads);

  await Promise.all(
    results.map(async (result) => {
      if (result.status !== 'fulfilled') return;

      try {
        await fileStorage.deleteImage(result.value.publicId);
      } catch (err) {
        log.warn(
          { err, publicId: result.value.publicId },
          'upload of a refused request was not deleted',
        );
      }
    }),
  );
}
