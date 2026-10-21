import { randomUUID } from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';

import cloudinary from '@config/cloudinary.js';
import env from '@config/env.js';
import { BadRequestError, InternalError, isAppError } from '@utils/errors.js';

import type { FastifyBaseLogger } from 'fastify';
import type { UploadApiOptions, UploadApiResponse } from 'cloudinary';

import type { AvatarUrls } from 'types/dto/users.dto.js';
import type { ProductImagesUrls } from 'types/dto/products.dto.js';

const DEFAULT_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

// the same three formats for cloudinary, which refuses anything else itself
const ALLOWED_FORMATS = ['jpg', 'png', 'webp'];

// the start of a file that tells its type: webp needs the most, 12 bytes
const IMAGE_HEAD_BYTES = 12;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// a file that does not send its start in this time holds the request no longer
const IMAGE_HEAD_TIMEOUT_MS = 8000;

export type MakePublicIdOpts =
  | { kind: 'avatar'; userId: string | number }
  | { kind: 'product'; productId: string | number; imageKey: string | number };

export type ImageFileMeta = {
  mimetype?: string | null;
  filename?: string | null;
};

export type AssertImageFileOpts = {
  allowedMimeTypes?: readonly string[];
};

export type UploadImageArgs = {
  file: Buffer | NodeJS.ReadableStream;
  mimetype: string;
  filename?: string;
  publicId?: string;
  tags?: string[];
  invalidate?: boolean;
  // how long the upload may take, in ms; without it the sdk waits as long as it waits
  timeout?: number;
};

export type UploadImageResult = {
  publicId: string;
  urlBase: string;
};

export type ImagePresetName = 'avatar' | 'product';

// normalize id parts to a stable, path-safe segment
// prevent slashes and unsafe chars from leaking into public_id
function cleanSegment(input: string | number): string {
  const raw = String(input).trim();
  if (!raw) return '';

  return raw
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .join('_')
    .replaceAll(' ', '-')
    .replace(/[^a-zA-Z0-9._-]/g, '');
}

export type ImageStreamOpts = {
  // the type the form names for the file
  mimetype: string;
  // the error code for an empty or broken file
  emptyCode: string;
};

// the type of an image by its first bytes, null for anything else: the type a form names is only
// the word of the client, these bytes are the file itself
export function detectImageType(head: Buffer): (typeof DEFAULT_ALLOWED_MIME)[number] | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'image/png';
  if (
    head.length >= IMAGE_HEAD_BYTES &&
    head.toString('ascii', 0, 4) === 'RIFF' &&
    head.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

// reads the start of an uploaded file and gives back a stream that begins with it again.
// An empty file, a type outside the list the form names, and a file that is not a jpeg, png or
// webp by its own bytes are refused before anything goes to cloudinary; a refused file is
// drained, so the parser goes on to the rest of the form (and to the size limit of the file)
export async function requireImageStream(
  stream: NodeJS.ReadableStream,
  opts: ImageStreamOpts,
): Promise<NodeJS.ReadableStream> {
  const s = stream as NodeJS.ReadableStream & { destroyed?: boolean; readableEnded?: boolean };

  // a stream that is gone or finished has no bytes to read
  if (!stream || typeof stream.on !== 'function' || s.destroyed || s.readableEnded) {
    throw new BadRequestError(opts.emptyCode);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onError);
      fn();
    };

    const refuse = (errorCode: string, ended: boolean) => {
      if (!ended) stream.resume();
      reject(new BadRequestError(errorCode));
    };

    // called with the start of the file, or with all of it when it ends sooner
    const decide = (ended: boolean) =>
      settle(() => {
        if (!size) return refuse(opts.emptyCode, ended);

        const head = Buffer.concat(chunks);
        try {
          assertImageFile({ mimetype: opts.mimetype });
        } catch {
          return refuse('IMAGE_TYPE_NOT_ALLOWED', ended);
        }
        if (!detectImageType(head)) return refuse('IMAGE_TYPE_NOT_ALLOWED', ended);

        const out = new PassThrough();
        out.write(head);
        if (ended) {
          out.end();
        } else {
          // a file cut by the size limit fails its upload instead of leaving it waiting
          stream.once('error', (err) => out.destroy(err));
          stream.pipe(out);
        }
        resolve(out);
      });

    // the listener runs as the chunk comes, so the pipe above is set before the next one
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      chunks.push(buf);
      size += buf.length;
      if (size >= IMAGE_HEAD_BYTES) decide(false);
    };

    // some streams close without an end
    const onEnd = () => decide(true);

    const onError = (err: unknown) => settle(() => reject(err));

    const timer = setTimeout(
      () => settle(() => refuse(opts.emptyCode, false)),
      IMAGE_HEAD_TIMEOUT_MS,
    );

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    stream.once('error', onError);
  });
}

// the folder of the environment: every environment numbers its users and products from 1, so
// without it user 5 of dev and user 5 of prod would write and delete the same file of a shared
// account. Files uploaded before the folder existed keep their paths, the rows store them
export const ENV_FOLDER =
  env.NODE_ENV === 'production' ? 'prod' : env.NODE_ENV === 'test' ? 'test' : 'dev';

// build deterministic public_id for overwrite and cleanup flows
export function makePublicId(opts: MakePublicIdOpts): string {
  if (opts.kind === 'avatar') {
    const userId = cleanSegment(opts.userId);
    if (!userId) throw new BadRequestError('PUBLIC_ID_USER_REQUIRED');

    // one avatar per user
    return `${ENV_FOLDER}/users/${userId}/avatar`;
  }

  const productId = cleanSegment(opts.productId);
  const imageKey = cleanSegment(opts.imageKey);

  if (!productId) throw new BadRequestError('PUBLIC_ID_PRODUCT_REQUIRED');
  if (!imageKey) throw new BadRequestError('PUBLIC_ID_IMAGEKEY_REQUIRED');

  // multiple images per product
  return `${ENV_FOLDER}/products/${productId}/${imageKey}`;
}

// where an upload waits until the request that brought it is written: a refused request deletes
// it (discardUploads), a written one moves it to its place at makePublicId (moveImage)
export function makeUploadPublicId(): string {
  return `${ENV_FOLDER}/uploads/${randomUUID()}`;
}

// a file of this environment. A file of another environment, or one uploaded before the folders
// existed, can belong to another database too (dev is restored from a copy of prod): never delete it
export function isOwnFile(publicId: string | null | undefined): publicId is string {
  return typeof publicId === 'string' && publicId.startsWith(`${ENV_FOLDER}/`);
}

// check the type of an uploaded image before calling cloudinary, whatever the client says it is.
// The size is not checked here: a file arrives as a stream, its size is known only after it is read,
// so the multipart size limit (MAX_UPLOAD_SIZE_BYTES, answer 413) cuts a file that is too big
export function assertImageFile(meta: ImageFileMeta, opts: AssertImageFileOpts = {}): void {
  const allowed = opts.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME;

  const mimetype = (meta.mimetype ?? '').trim().toLowerCase();
  if (!mimetype || !allowed.includes(mimetype)) {
    throw new BadRequestError('IMAGE_TYPE_NOT_ALLOWED');
  }
}

// fast guard for url builders and dto mapping
// avoid throwing when urlBase is empty or not cloudinary
export function isCloudinaryUrl(value: unknown): value is string {
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
      if (!result) return reject(new InternalError({ reason: 'CLOUDINARY_UPLOAD_EMPTY_RESULT' }));
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
export async function uploadImage(args: UploadImageArgs): Promise<UploadImageResult> {
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

    throw new InternalError({ reason: 'CLOUDINARY_UPLOAD_UNEXPECTED' }, err);
  }
}

// puts an uploaded image at its place: a file already there is replaced and its cached copies are
// dropped. The answer has the url of the image at the new place
export async function moveImage(
  fromPublicId: string,
  toPublicId: string,
): Promise<UploadImageResult> {
  if (!fromPublicId.trim() || !toPublicId.trim()) throw new BadRequestError('PUBLIC_ID_REQUIRED');

  try {
    const res = await cloudinary.uploader.rename(fromPublicId, toPublicId, {
      resource_type: 'image',
      overwrite: true,
      invalidate: true,
    });

    return { publicId: res.public_id, urlBase: res.secure_url };
  } catch (err) {
    throw new InternalError({ reason: 'CLOUDINARY_MOVE_UNEXPECTED' }, err);
  }
}

// remove an image by public_id, for example the avatar of a deleted account;
// an image that is already gone is not an error, cloudinary answers "not found" for it
export async function deleteImage(publicId: string): Promise<void> {
  if (!publicId.trim()) throw new BadRequestError('PUBLIC_ID_REQUIRED');

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
  } catch (err) {
    throw new InternalError({ reason: 'CLOUDINARY_DELETE_UNEXPECTED' }, err);
  }
}

// deletes the waiting uploads of a request that was refused, once each has finished; it never
// throws, a file it cannot delete goes to the log. An upload that was moved to its place is gone
// from the waiting id already, cloudinary answers "not found" for it
export async function discardUploads(
  uploads: ReadonlyArray<Promise<{ publicId: string }>>,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<void> {
  const results = await Promise.allSettled(uploads);

  await Promise.all(
    results.map(async (result) => {
      if (result.status !== 'fulfilled') return;

      try {
        await deleteImage(result.value.publicId);
      } catch (err) {
        log.warn(
          { err, publicId: result.value.publicId },
          'upload of a refused request was not deleted',
        );
      }
    }),
  );
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

export function buildImageUrls(urlBase: string, kind: 'avatar'): AvatarUrls;
export function buildImageUrls(urlBase: string, kind: 'product'): ProductImagesUrls;
export function buildImageUrls(urlBase: string, preset: ImagePresetName) {
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
