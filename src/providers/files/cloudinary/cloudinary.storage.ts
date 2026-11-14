import { Readable } from 'node:stream';

import {
  BadRequestError,
  InternalError,
  ServiceUnavailableError,
  isAppError,
} from '@utils/errors.js';

import { assertImageFile } from '../files.js';

import cloudinary from './cloudinaryClient.js';
import { letterAvatarUrls, prepareLetterAvatars } from './cloudinaryLetterAvatar.js';

import type { UploadApiOptions, UploadApiResponse } from 'cloudinary';

import type {
  FileStorageProvider,
  ImagePresetName,
  UploadDocumentResult,
  UploadImageArgs,
  UploadImageResult,
} from '../types.js';

import type { AvatarUrls } from 'types/dto/users.dto.js';
import type { ProductImagesUrls } from 'types/dto/products.dto.js';

// The files of the shop in an account of Cloudinary: a picture is an image of it, a pdf of a
// document an image too (the way Cloudinary keeps a pdf), a size of a picture is a transformation in
// its address

// the same three formats for cloudinary, which refuses anything else itself
const ALLOWED_FORMATS = ['jpg', 'png', 'webp'];

// a move or a delete at cloudinary waits this long at most, not the minute of the sdk: a move runs
// inside the transaction of its request and must end before it does, a delete holds up the answer.
// An upload sends a whole file and keeps the time of the sdk unless its call names one
const CLOUDINARY_CALL_TIMEOUT_MS = 8_000;

// the sdk takes a timeout on every call of the upload api (it sets it on the request), its types
// name it for the uploads only
const withCallTimeout = <T extends object>(options: T): T =>
  ({ ...options, timeout: CLOUDINARY_CALL_TIMEOUT_MS }) as T;

// the codes of node for a connection that could not be made or broke
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

// cloudinary did not answer in time, could not be reached or failed itself: nothing of the file
// changed at it, the request can come again. The sdk gives a call that ran out of time and a broken
// connection wrapped in error, a status it does not read as it is (node_modules/cloudinary/lib/uploader.js)
function outOfReach(err: unknown): ServiceUnavailableError | null {
  const wrapped = (err as { error?: unknown } | null)?.error;
  const e = (wrapped ?? err) as { name?: unknown; http_code?: unknown; code?: unknown } | null;
  if (!e || typeof e !== 'object') return null;

  const timedOut = e.name === 'TimeoutError' || e.http_code === 499;
  const failed = typeof e.http_code === 'number' && e.http_code >= 500;
  const broken = typeof e.code === 'string' && NETWORK_ERROR_CODES.has(e.code);

  return timedOut || failed || broken
    ? new ServiceUnavailableError('IMAGE_STORAGE_UNAVAILABLE', undefined, err)
    : null;
}

// fast guard for url builders and dto mapping
// avoid throwing when urlBase is empty or not cloudinary
function isCloudinaryUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;

  const urlRaw = value.trim();
  if (!urlRaw) return false;

  let u: URL;
  try {
    u = new URL(urlRaw);
  } catch {
    return false;
  }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;

  const host = u.hostname.toLowerCase();

  // default delivery domain
  if (host === 'res.cloudinary.com' || host.endsWith('.res.cloudinary.com')) return true;

  return false;
}

function toReadable(file: Buffer | NodeJS.ReadableStream): NodeJS.ReadableStream {
  if (Buffer.isBuffer(file)) return Readable.from(file);
  return file;
}

// wrap cloudinary upload_stream into a promise
async function uploadViaStream(
  fileStream: NodeJS.ReadableStream,
  options: UploadApiOptions,
): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    fileStream.once('error', reject);

    const uploadStream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      if (!result) return reject(new InternalError({ reason: 'FILE_STORAGE_UPLOAD_EMPTY' }));
      return resolve(result);
    });

    fileStream.pipe(uploadStream);
  });
}

// cloudinary refuses a file it cannot read as an image, or of a format it was not let keep:
// that is the file of the client, not a failure of the server. A webp it cannot read has an
// answer of its own, "Invalid webp file" (checked 21.10.2026)
function refusedImage(err: unknown): BadRequestError | null {
  const e = err as { http_code?: unknown; message?: unknown } | null;
  if (e?.http_code !== 400 || typeof e.message !== 'string') return null;

  if (/format .* not allowed/i.test(e.message)) {
    return new BadRequestError('IMAGE_TYPE_NOT_ALLOWED', undefined, err);
  }
  if (/invalid (image|webp) file/i.test(e.message)) {
    return new BadRequestError('IMAGE_INVALID', undefined, err);
  }
  return null;
}

// upload a new image and return stable identifiers for db storage
async function uploadImage(args: UploadImageArgs): Promise<UploadImageResult> {
  assertImageFile({ mimetype: args.mimetype });

  const options: UploadApiOptions = { resource_type: 'image', allowed_formats: ALLOWED_FORMATS };

  if (args.tags?.length) options.tags = args.tags;
  if (typeof args.invalidate === 'boolean') options.invalidate = args.invalidate;
  if (args.timeout) options.timeout = args.timeout;

  if (args.publicId) {
    // allow deterministic ids for overwrite and cleanup
    options.public_id = args.publicId;
  }

  try {
    const stream = toReadable(args.file);
    const res = await uploadViaStream(stream, options);

    return {
      publicId: res.public_id,
      urlBase: res.secure_url,
    };
  } catch (err) {
    // avoid leaking sdk errors to clients
    if (isAppError(err)) throw err;

    const refused = refusedImage(err);
    if (refused) throw refused;

    throw outOfReach(err) ?? new InternalError({ reason: 'FILE_STORAGE_UPLOAD_FAILED' }, err);
  }
}

// puts an uploaded image at its place: a file already there is replaced. invalidate drops the
// copies cached of the place, for a place a page may show already (the avatar of an account); a
// new place has none. The answer has the url of the image at the new place
async function moveImage(
  fromPublicId: string,
  toPublicId: string,
  opts: { invalidate: boolean },
): Promise<UploadImageResult> {
  if (!fromPublicId.trim() || !toPublicId.trim()) throw new BadRequestError('PUBLIC_ID_REQUIRED');

  try {
    const res = await cloudinary.uploader.rename(
      fromPublicId,
      toPublicId,
      withCallTimeout({
        resource_type: 'image' as const,
        overwrite: true,
        invalidate: opts.invalidate,
      }),
    );

    return { publicId: res.public_id, urlBase: res.secure_url };
  } catch (err) {
    throw outOfReach(err) ?? new InternalError({ reason: 'FILE_STORAGE_MOVE_FAILED' }, err);
  }
}

// remove an image by public_id, for example the avatar of a deleted account;
// an image that is already gone is not an error, cloudinary answers "not found" for it
async function deleteImage(publicId: string): Promise<void> {
  if (!publicId.trim()) throw new BadRequestError('PUBLIC_ID_REQUIRED');

  try {
    await cloudinary.uploader.destroy(
      publicId,
      withCallTimeout({ resource_type: 'image' as const, invalidate: true }),
    );
  } catch (err) {
    throw outOfReach(err) ?? new InternalError({ reason: 'FILE_STORAGE_DELETE_FAILED' }, err);
  }
}

// how long the upload of a document may take: a file is up to DOCUMENT_MAX_BYTES, more than a picture
const DOCUMENT_UPLOAD_TIMEOUT_MS = 60_000;

// cloudinary reads the structure of a pdf it is given: a file that starts as a pdf does but has no
// page to read is the file of the client ("Invalid PDF file", checked 31.10.2026)
function refusedDocument(err: unknown): BadRequestError | null {
  const e = err as { http_code?: unknown; message?: unknown } | null;
  if (e?.http_code !== 400 || typeof e.message !== 'string') return null;

  return /invalid pdf file/i.test(e.message)
    ? new BadRequestError('DOCUMENT_INVALID', undefined, err)
    : null;
}

// keeps the PDF file of a document (checked by requirePdfStream) in the account under the id the
// app gave it, the way Cloudinary keeps a pdf, and gives what the row of the document stores
async function uploadDocument(args: {
  file: Buffer | NodeJS.ReadableStream;
  publicId: string;
}): Promise<UploadDocumentResult> {
  const options: UploadApiOptions = {
    resource_type: 'image',
    allowed_formats: ['pdf'],
    public_id: args.publicId,
    timeout: DOCUMENT_UPLOAD_TIMEOUT_MS,
  };

  try {
    const res = await uploadViaStream(toReadable(args.file), options);

    return { publicId: res.public_id, url: res.secure_url, sizeBytes: res.bytes };
  } catch (err) {
    if (isAppError(err)) throw err;

    const refused = refusedDocument(err);
    if (refused) throw refused;

    throw outOfReach(err) ?? new InternalError({ reason: 'FILE_STORAGE_UPLOAD_FAILED' }, err);
  }
}

// removes the file of a document; one that is gone already is not an error
async function deleteDocument(publicId: string): Promise<void> {
  if (!publicId.trim()) throw new BadRequestError('PUBLIC_ID_REQUIRED');

  try {
    await cloudinary.uploader.destroy(
      publicId,
      withCallTimeout({ resource_type: 'image' as const, invalidate: true }),
    );
  } catch (err) {
    throw outOfReach(err) ?? new InternalError({ reason: 'FILE_STORAGE_DELETE_FAILED' }, err);
  }
}

// insert transforms right after /upload/
// keep version segment from urlBase to avoid cache issues
function insertTransforms(urlBase: string, transforms: string): string {
  const marker = '/upload/';
  const idx = urlBase.indexOf(marker);
  if (idx === -1) return urlBase;

  const t = transforms.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!t) return urlBase;

  return urlBase.slice(0, idx + marker.length) + t + '/' + urlBase.slice(idx + marker.length);
}

// build urls for frontend without storing multiple urls in db

function buildImageUrls(urlBase: string, kind: 'avatar'): AvatarUrls;
function buildImageUrls(urlBase: string, kind: 'product'): ProductImagesUrls;
function buildImageUrls(urlBase: string, preset: ImagePresetName) {
  if (preset === 'avatar') {
    const mk = (s: number) => `c_fill,g_face,w_${s},h_${s},f_auto,q_auto`;

    return {
      url32: insertTransforms(urlBase, mk(32)),
      url64: insertTransforms(urlBase, mk(64)),
      url128: insertTransforms(urlBase, mk(128)),
      url256: insertTransforms(urlBase, mk(256)),
    } satisfies AvatarUrls;
  }

  // product images: keep the whole item visible by default
  const mk = (s: number) => `c_fit,w_${s},h_${s},f_auto,q_auto`;

  return {
    url200: insertTransforms(urlBase, mk(200)),
    url400: insertTransforms(urlBase, mk(400)),
    url800: insertTransforms(urlBase, mk(800)),
  } satisfies ProductImagesUrls;
}

export const cloudinaryStorage: FileStorageProvider = {
  name: 'cloudinary',
  label: 'Cloudinary',
  uploadImage,
  moveImage,
  deleteImage,
  uploadDocument,
  deleteDocument,
  imageUrls: buildImageUrls,
  isOwnUrl: isCloudinaryUrl,
  letterAvatarUrls,
  prepareLetterAvatars: (log) => prepareLetterAvatars(log, uploadImage),
};
