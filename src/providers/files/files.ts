import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { ENVIRONMENT_NAME } from '@config/environment.js';
import { BadRequestError } from '@utils/errors.js';

// What the files of the shop are, whoever keeps them (src/providers/files): the types of image the
// shop takes and how a file is told by its own first bytes, whatever the client says, before
// anything goes to the file storage; and the ids the files are kept under, the folder of the
// environment first

const DEFAULT_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

// the start of a file that tells its type: webp needs the most, 12 bytes
const IMAGE_HEAD_BYTES = 12;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// a file that does not send its start in this time holds the request no longer
const IMAGE_HEAD_TIMEOUT_MS = 8000;

export type MakePublicIdOpts =
  | { kind: 'avatar'; userId: string | number }
  | { kind: 'product'; productId: string | number; imageKey: string | number }
  | { kind: 'category'; categoryId: string | number; imageKey: string | number }
  | { kind: 'shop'; imageKey: string | number };

export type ImageFileMeta = {
  mimetype?: string | null;
  filename?: string | null;
};

export type AssertImageFileOpts = {
  allowedMimeTypes?: readonly string[];
};

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

// a pdf starts with %PDF-: the first bytes of the file itself, the type a form names is only the
// word of the client
export function isPdf(head: Buffer): boolean {
  return head.length >= 5 && head.toString('latin1', 0, 5) === '%PDF-';
}

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
// webp by its own bytes are refused before anything goes to the file storage; a refused file is
// drained, so the parser goes on to the rest of the form (and to the size limit of the file)
export async function requireImageStream(
  stream: NodeJS.ReadableStream,
  opts: ImageStreamOpts,
): Promise<NodeJS.ReadableStream> {
  return requireFileStream(stream, opts, {
    notAllowedCode: 'IMAGE_TYPE_NOT_ALLOWED',
    typeAllowed: (mimetype) => {
      try {
        assertImageFile({ mimetype });
        return true;
      } catch {
        return false;
      }
    },
    bytesAllowed: (head) => detectImageType(head) !== null,
  });
}

// the same for the PDF file of a document: the type the form names is application/pdf and the file
// starts as a pdf does
export async function requirePdfStream(
  stream: NodeJS.ReadableStream,
  opts: ImageStreamOpts,
): Promise<NodeJS.ReadableStream> {
  return requireFileStream(stream, opts, {
    notAllowedCode: 'DOCUMENT_TYPE_NOT_ALLOWED',
    typeAllowed: (mimetype) => mimetype.trim().toLowerCase() === 'application/pdf',
    bytesAllowed: isPdf,
  });
}

type FileStreamRule = {
  // the code of a file that is not of the kind
  notAllowedCode: string;
  // the type the form names, and the first bytes of the file itself
  typeAllowed: (mimetype: string) => boolean;
  bytesAllowed: (head: Buffer) => boolean;
};

async function requireFileStream(
  stream: NodeJS.ReadableStream,
  opts: ImageStreamOpts,
  rule: FileStreamRule,
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
        if (!rule.typeAllowed(opts.mimetype)) return refuse(rule.notAllowedCode, ended);
        if (!rule.bytesAllowed(head)) return refuse(rule.notAllowedCode, ended);

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

// every file lies in the folder of its environment (ENVIRONMENT_NAME). Files uploaded before the
// folder existed keep their paths, the rows store them
const ENV_FOLDER = ENVIRONMENT_NAME;

// build deterministic public_id for overwrite and cleanup flows
export function makePublicId(opts: MakePublicIdOpts): string {
  if (opts.kind === 'avatar') {
    const userId = cleanSegment(opts.userId);
    if (!userId) throw new BadRequestError('PUBLIC_ID_USER_REQUIRED');

    // one avatar per user
    return `${ENV_FOLDER}/users/${userId}/avatar`;
  }

  if (opts.kind === 'category') {
    const categoryId = cleanSegment(opts.categoryId);
    const key = cleanSegment(opts.imageKey);
    if (!categoryId) throw new BadRequestError('PUBLIC_ID_CATEGORY_REQUIRED');
    if (!key) throw new BadRequestError('PUBLIC_ID_IMAGEKEY_REQUIRED');

    // a new path for each upload, so a move never replaces the picture the category shows
    return `${ENV_FOLDER}/categories/${categoryId}/${key}`;
  }

  if (opts.kind === 'shop') {
    const key = cleanSegment(opts.imageKey);
    if (!key) throw new BadRequestError('PUBLIC_ID_IMAGEKEY_REQUIRED');

    // one logo for the whole shop, not per id; a new path for each upload, as for a category
    return `${ENV_FOLDER}/shop/logo/${key}`;
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

// check the type of an uploaded image before it goes to the file storage, whatever the client says it is.
// The size is not checked here: a file arrives as a stream, its size is known only after it is read,
// so the multipart size limit (MAX_UPLOAD_SIZE_BYTES, answer 413) cuts a file that is too big
export function assertImageFile(meta: ImageFileMeta, opts: AssertImageFileOpts = {}): void {
  const allowed = opts.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME;

  const mimetype = (meta.mimetype ?? '').trim().toLowerCase();
  if (!mimetype || !allowed.includes(mimetype)) {
    throw new BadRequestError('IMAGE_TYPE_NOT_ALLOWED');
  }
}

// the public id of a document file; the id is new for every upload, so a file a page shows is never
// replaced
export function makeDocumentPublicId(): string {
  return `${ENV_FOLDER}/documents/${randomUUID()}`;
}
