import type { FastifyBaseLogger } from 'fastify';

import type { Provider } from '../provider.js';

import type { FileStorageProviderName } from './names.js';

import type { AvatarUrls } from 'types/dto/users.dto.js';
import type { ProductImagesUrls } from 'types/dto/products.dto.js';

export type UploadImageArgs = {
  file: Buffer | NodeJS.ReadableStream;
  mimetype: string;
  filename?: string;
  publicId?: string;
  tags?: string[];
  invalidate?: boolean;
  // how long the upload may take, in ms; without it the storage waits as long as it waits
  timeout?: number;
};

// what the row of a picture keeps: its id at the storage and the address it is served from, which
// the sizes a page shows are made of (imageUrls)
export type UploadImageResult = {
  publicId: string;
  urlBase: string;
};

export type ImagePresetName = 'avatar' | 'product';

export type UploadDocumentResult = { publicId: string; url: string; sizeBytes: number };

// The errors of a storage: IMAGE_STORAGE_UNAVAILABLE (503) when it did not answer in time, could not
// be reached or failed itself (nothing of the file changed, the request can come again); a file it
// cannot read is the file of the client (400 IMAGE_TYPE_NOT_ALLOWED, IMAGE_INVALID,
// DOCUMENT_INVALID); anything else it answers is a server error with the reason
// FILE_STORAGE_UPLOAD_FAILED, FILE_STORAGE_UPLOAD_EMPTY, FILE_STORAGE_MOVE_FAILED or
// FILE_STORAGE_DELETE_FAILED, what it answered in the cause

// what the rest of the app asks of the storage of the files. How it keeps them is its own: its
// client, its folders and its ways to serve a picture in a size stay in its folder
export interface FileStorageProvider extends Provider<FileStorageProviderName> {
  // keeps a picture (its type checked by the kind first, assertImageFile), under the id given
  // or one of its own
  uploadImage(args: UploadImageArgs): Promise<UploadImageResult>;
  // puts an uploaded picture at its place, replacing a file there; invalidate drops the copies
  // served of the place
  moveImage(
    fromPublicId: string,
    toPublicId: string,
    opts: { invalidate: boolean },
  ): Promise<UploadImageResult>;
  // removes a picture; one that is gone already is not an error
  deleteImage(publicId: string): Promise<void>;
  // keeps the pdf file of a document under the id given
  uploadDocument(args: {
    file: Buffer | NodeJS.ReadableStream;
    publicId: string;
  }): Promise<UploadDocumentResult>;
  // removes the file of a document; one that is gone already is not an error
  deleteDocument(publicId: string): Promise<void>;
  // the addresses of the sizes a page shows a picture in
  imageUrls(urlBase: string, preset: 'avatar'): AvatarUrls;
  imageUrls(urlBase: string, preset: 'product'): ProductImagesUrls;
  // whether an address is one this storage serves
  isOwnUrl(value: unknown): value is string;
  // the addresses, in the sizes of an avatar, of a picture of one letter in white on a color (six
  // hex digits), drawn by the storage: the avatar of an account without a picture of its own
  letterAvatarUrls(letter: string, color: string): AvatarUrls;
  // makes ready what the storage draws the letters with, when it is not; never throws, a failure
  // goes to the log
  prepareLetterAvatars(log: Pick<FastifyBaseLogger, 'info' | 'warn'>): Promise<void>;
}
