import { Readable, PassThrough } from 'node:stream';

import cloudinary from '@config/cloudinary.js';
import { AppError, BadRequestError, isAppError } from '@utils/errors.js';

import type { UploadApiOptions, UploadApiResponse } from 'cloudinary';

import type { AvatarUrls } from 'types/dto/users.dto.js';
import type { ProductImagesUrls } from 'types/dto/products.dto.js';

const DEFAULT_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export type MakePublicIdOpts =
  | { kind: 'avatar'; userId: string | number }
  | { kind: 'product'; productId: string | number; imageKey: string | number };

export type ImageFileMeta = {
  mimetype?: string | null;
  filename?: string | null;
  size?: number | null;
  bytes?: number | null;
};

export type AssertImageFileOpts = {
  maxBytes?: number;
  allowedMimeTypes?: readonly string[];
};

export type UploadImageArgs = {
  file: Buffer | NodeJS.ReadableStream;
  mimetype: string;
  bytes?: number;
  filename?: string;
  folder?: string;
  publicId?: string;
  tags?: string[];
  invalidate?: boolean;
};

export type OverwriteImageArgs = Omit<UploadImageArgs, 'publicId'> & {
  publicId: string;
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

export async function requireNonEmptyStream(
  stream: NodeJS.ReadableStream,
  code: string,
): Promise<NodeJS.ReadableStream> {
  // fastify-multipart gives a one-shot readable stream for file parts
  // this helper ensures the stream is not empty and returns a new readable that
  // starts with the first chunk we "peeked" and then continues streaming the rest
  const s: any = stream;

  // reject immediately if input is not a readable stream instance
  if (!stream || typeof (stream as any).on !== 'function') {
    throw new BadRequestError(code);
  }

  // reject immediately if the stream is already finished or destroyed
  // in this case there is no way to read bytes and we must not call external upload
  if (s.destroyed || s.readableEnded) {
    throw new BadRequestError(code);
  }

  return new Promise((resolve, reject) => {
    // tracks whether we observed at least one data chunk
    // "empty file" means: end/close happens before the first data chunk
    let seen = false;

    // ensures we resolve/reject the promise only once
    let settled = false;

    // PassThrough becomes the new stream we return to callers
    // we write the first chunk into it and then pipe the original stream into it
    const out = new PassThrough();

    // finalize helper: cleanup listeners and settle exactly once
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    // propagate stream errors
    const onErr = (e: unknown) => {
      done(() => reject(e));
    };

    // if the stream ends before any data chunk was received -> treat as empty file
    // if we already saw data -> just finish the passthrough and resolve it
    const onEnd = () => {
      done(() => {
        out.end();
        if (!seen) reject(new BadRequestError(code));
        else resolve(out);
      });
    };

    // some implementations emit 'close' instead of (or before) 'end'
    // we handle it the same way to avoid hanging requests
    const onClose = () => {
      done(() => {
        out.end();
        if (!seen) reject(new BadRequestError(code));
        else resolve(out);
      });
    };

    // first data chunk is the "proof" that the file is not empty
    // we immediately:
    // 1) pause source stream to avoid race while wiring pipes
    // 2) write the first chunk into out
    // 3) pipe the rest of source stream into out
    // 4) resume reading
    // 5) resolve with out so caller can pass it to cloudinary as a live stream
    const onData = (chunk: any) => {
      seen = true;

      // optional introspection, not used but kept for debugging
      const _len =
        typeof chunk === 'string'
          ? Buffer.byteLength(chunk)
          : Buffer.isBuffer(chunk)
            ? chunk.length
            : chunk?.length;

      // prevent extra reads while connecting the pipe
      (stream as any).pause?.();

      // preserve the first bytes we already pulled from the source stream
      out.write(chunk);

      // forward the remaining bytes
      stream.pipe(out);

      // resume streaming
      (stream as any).resume?.();

      // resolve immediately: at this point the returned stream will continue producing bytes
      done(() => resolve(out));
    };

    // remove listeners and cancel timeout
    const cleanup = () => {
      clearTimeout(t);
      stream.off('error', onErr);
      stream.off('end', onEnd);
      stream.off('close', onClose);
      stream.off('data', onData);
    };

    // guard against "no events ever happen" situations (broken clients, aborted uploads)
    // this prevents the request from hanging indefinitely
    const t = setTimeout(() => {
      done(() => reject(new BadRequestError(code)));
    }, 8000);

    // listen once because we only care about the first chunk and terminal events
    stream.once('error', onErr);
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('data', onData);

    // kick off reading in case the stream is in paused mode
    (stream as any).resume?.();
  });
}

// build deterministic public_id for overwrite and cleanup flows
export function makePublicId(opts: MakePublicIdOpts): string {
  if (opts.kind === 'avatar') {
    const userId = cleanSegment(opts.userId);
    if (!userId) throw new BadRequestError('PUBLIC_ID_USER_REQUIRED');

    // one avatar per user
    return `users/${userId}/avatar`;
  }

  const productId = cleanSegment(opts.productId);
  const imageKey = cleanSegment(opts.imageKey);

  if (!productId) throw new BadRequestError('PUBLIC_ID_PRODUCT_REQUIRED');
  if (!imageKey) throw new BadRequestError('PUBLIC_ID_IMAGEKEY_REQUIRED');

  // multiple images per product
  return `products/${productId}/${imageKey}`;
}

// validate uploaded image metadata before calling cloudinary
// enforce server-side limits even if client lies
export function assertImageFile(meta: ImageFileMeta, opts: AssertImageFileOpts = {}): void {
  const allowed = opts.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const mimetype = (meta.mimetype ?? '').trim().toLowerCase();
  if (!mimetype || !allowed.includes(mimetype)) {
    throw new BadRequestError('IMAGE_TYPE_NOT_ALLOWED');
  }

  const bytes = meta.bytes ?? meta.size ?? null;
  if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > maxBytes) {
    throw new BadRequestError('IMAGE_TOO_LARGE');
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

// keep folder formatting consistent
function normalizeFolder(input: string | undefined): string | undefined {
  if (!input) return undefined;

  const v = input.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return v.length > 0 ? v : undefined;
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
      if (!result) return reject(new Error('cloudinary upload returned empty result'));
      return resolve(result);
    });

    fileStream.pipe(uploadStream);
  });
}

// upload a new image and return stable identifiers for db storage
export async function uploadImage(args: UploadImageArgs): Promise<UploadImageResult> {
  assertImageFile({
    mimetype: args.mimetype,
    ...(args.bytes != null ? { bytes: args.bytes } : {}),
  });

  const folder = normalizeFolder(args.folder);

  const options: UploadApiOptions = { resource_type: 'image' };

  if (folder) options.folder = folder;
  if (args.tags?.length) options.tags = args.tags;
  if (typeof args.invalidate === 'boolean') options.invalidate = args.invalidate;

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

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`cloudinary: unexpected (${msg})`, 500);
  }
}

// overwrite an existing image by public_id and return the new versioned url
export async function overwriteImage(args: OverwriteImageArgs): Promise<UploadImageResult> {
  assertImageFile({
    mimetype: args.mimetype,
    ...(args.bytes != null ? { bytes: args.bytes } : {}),
  });

  const options: UploadApiOptions = { resource_type: 'image' };

  if (!args.publicId.trim()) {
    throw new BadRequestError('PUBLIC_ID_REQUIRED');
  }

  options.public_id = args.publicId;
  options.overwrite = true;

  const folder = normalizeFolder(args.folder);

  if (folder) options.folder = folder;
  if (args.tags?.length) options.tags = args.tags;
  if (typeof args.invalidate === 'boolean') options.invalidate = args.invalidate;

  try {
    const stream = toReadable(args.file);
    const res = await uploadViaStream(stream, options);

    return {
      publicId: res.public_id,
      urlBase: res.secure_url,
    };
  } catch (err) {
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`cloudinary: unexpected (${msg})`, 500);
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
