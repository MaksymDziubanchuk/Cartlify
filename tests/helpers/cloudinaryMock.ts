import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { crc32, inflateSync } from 'node:zlib';

import cloudinary from '@config/cloudinary.js';

import type { UploadApiOptions, UploadApiResponse } from 'cloudinary';

// the mock of Cloudinary (tests/helpers/cloudinary.ts puts it in place unless the run takes the
// real service): the calls the app makes, upload_stream, rename and destroy, the read of a file
// the tests make (api.resource), and the delivery of a file at its url. The files of a test file
// live in memory, the way the account keeps them. Every answer and error is the one Cloudinary
// gives (checked against the account 21.10.2026); an option the app does not use stops the test,
// the mock would only guess what Cloudinary does with it

type StoredFile = {
  publicId: string;
  version: number;
  format: string;
  width: number;
  height: number;
  tags: string[];
  data: Buffer;
  createdAt: string;
  displayName: string;
};

const files = new Map<string, StoredFile>();

// the version of a file counts seconds at Cloudinary; here it also grows within one second, so
// two uploads of a test never share one
let lastVersion = 0;
const nextVersion = () => (lastVersion = Math.max(Math.floor(Date.now() / 1000), lastVersion + 1));

const hex = (bytes: number) =>
  randomUUID()
    .replaceAll('-', '')
    .slice(0, bytes * 2);

// an error of the upload api the way the sdk gives it
const uploadError = (httpCode: number, message: string) =>
  Object.assign(new Error(message), { http_code: httpCode });

function unsupported(what: string): never {
  throw new Error(`the Cloudinary mock does not know ${what}; run with service:cloudinary`);
}

type Size = { width: number; height: number };

// a png Cloudinary can read: the chunks whole with their checksums, the header first, the image
// data that inflates, the end chunk
function readPng(data: Buffer): Size | null {
  let at = 8;
  let size: Size | null = null;
  let ended = false;
  const idat: Buffer[] = [];

  while (at + 12 <= data.length) {
    const length = data.readUInt32BE(at);
    const type = data.toString('latin1', at + 4, at + 8);
    const end = at + 12 + length;
    if (end > data.length) return null;
    if (crc32(data.subarray(at + 4, at + 8 + length)) !== data.readUInt32BE(at + 8 + length)) {
      return null;
    }

    if (at === 8) {
      if (type !== 'IHDR' || length !== 13) return null;
      size = { width: data.readUInt32BE(at + 8), height: data.readUInt32BE(at + 12) };
    }
    if (type === 'IDAT') idat.push(data.subarray(at + 8, at + 8 + length));

    at = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }

  if (!size?.width || !size.height || !ended || !idat.length) return null;
  try {
    inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  return size;
}

// a jpeg by its segments up to the image data and its end marker; the image data itself is not
// decoded. One known difference: Cloudinary takes a jpeg that lacks only its end marker, the mock
// refuses it, since without a decoder it cannot tell such a file from one cut in its image data,
// which Cloudinary refuses (checked 21.10.2026)
function readJpeg(data: Buffer): Size | null {
  let at = 2;
  let size: Size | null = null;

  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1]!;
    const length = data.readUInt16BE(at + 2);
    if (at + 2 + length > data.length) return null;

    // a start of frame names the size; c4, c8 and cc are other segments of the same range
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      size = { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
    }
    // the start of scan: the image data follows
    if (marker === 0xda) break;
    at += 2 + length;
  }

  const ends = data.at(-2) === 0xff && data.at(-1) === 0xd9;
  return size?.width && size.height && ends ? size : null;
}

// a webp by its riff length and the header of its image; the image data itself is not decoded
function readWebp(data: Buffer): Size | null {
  if (data.length < 30 || data.readUInt32LE(4) + 8 !== data.length) return null;

  const chunk = data.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null;
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (data[20] !== 0x2f) return null;
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  }
  return null;
}

// the format Cloudinary sees in the bytes, the way it names it
function formatOf(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (/^GIF8[79]a/.test(data.toString('latin1', 0, 6))) return 'gif';
  return null;
}

const READERS: Record<string, (data: Buffer) => Size | null> = {
  png: readPng,
  jpg: readJpeg,
  webp: readWebp,
};

// what Cloudinary answers for the file of an upload, in the order it checks
function takeFile(data: Buffer, options: UploadApiOptions): Size & { format: string } {
  if (!options.allowed_formats) unsupported('an upload without allowed_formats');
  if (!data.length) throw uploadError(400, 'Empty file');

  const format = formatOf(data);
  if (!format) throw uploadError(400, 'An unknown file format not allowed');
  if (!(options.allowed_formats as string[]).includes(format)) {
    throw uploadError(400, `Image file format ${format} not allowed`);
  }

  const size = READERS[format]?.(data);
  // a webp that cannot be read has an answer of its own
  if (!size) throw uploadError(400, format === 'webp' ? 'Invalid webp file' : 'Invalid image file');
  return { ...size, format };
}

const deliveryBase = (scheme: 'http' | 'https') =>
  `${scheme}://res.cloudinary.com/${cloudinary.config().cloud_name}/image/upload/`;

const urlOf = (file: StoredFile, scheme: 'http' | 'https') =>
  `${deliveryBase(scheme)}v${file.version}/${file.publicId}.${file.format}`;

// the fields Cloudinary gives for a file, in an upload answer, a move and a read alike
const describeFile = (file: StoredFile) => ({
  asset_id: hex(16),
  public_id: file.publicId,
  version: file.version,
  version_id: hex(16),
  signature: hex(20),
  width: file.width,
  height: file.height,
  format: file.format,
  resource_type: 'image',
  created_at: file.createdAt,
  tags: [...file.tags],
  bytes: file.data.length,
  type: 'upload',
  etag: createHash('md5').update(file.data).digest('hex'),
  placeholder: false,
  url: urlOf(file, 'http'),
  secure_url: urlOf(file, 'https'),
  asset_folder: '',
  display_name: file.displayName,
});

function uploadStream(...args: unknown[]): Writable {
  const options = (args.find((arg) => typeof arg === 'object' && arg !== null) ??
    {}) as UploadApiOptions;
  const callback = args.find((arg) => typeof arg === 'function') as
    ((err?: unknown, res?: UploadApiResponse) => void) | undefined;
  if (options.resource_type !== 'image') unsupported('an upload that is not an image');
  if (typeof options.public_id !== 'string') unsupported('an upload without a public id');
  const publicId = options.public_id;

  const chunks: Buffer[] = [];
  return new Writable({
    write(chunk: Buffer, _encoding, next) {
      chunks.push(Buffer.from(chunk));
      next();
    },
    final(done) {
      done();
      // the answer comes after the stream ends, as it comes over the network
      setImmediate(() => {
        let taken: Size & { format: string };
        try {
          taken = takeFile(Buffer.concat(chunks), options);
        } catch (err) {
          callback?.(err);
          return;
        }

        const overwritten = files.has(publicId);
        const file: StoredFile = {
          publicId,
          ...taken,
          version: nextVersion(),
          tags: [...((options.tags as string[] | undefined) ?? [])],
          data: Buffer.concat(chunks),
          createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          displayName: publicId.split('/').at(-1)!,
        };
        files.set(publicId, file);

        callback?.(undefined, {
          ...describeFile(file),
          ...(overwritten ? { overwritten: true } : {}),
          original_filename: 'file',
          api_key: cloudinary.config().api_key,
        } as unknown as UploadApiResponse);
      });
    },
  });
}

// a move keeps the version and the date of the file, its display name too
async function rename(from: string, to: string, options: { overwrite?: boolean } = {}) {
  if (options.overwrite !== true) unsupported('a move without overwrite');

  const file = files.get(from);
  if (!file) throw uploadError(404, `Resource not found - ${from}`);

  files.delete(from);
  const moved = { ...file, publicId: to };
  files.set(to, moved);
  return describeFile(moved);
}

async function destroy(publicId: string) {
  return { result: files.delete(publicId) ? 'ok' : 'not found' };
}

// the admin api gives its error under error, with the request beside it
async function resource(publicId: string) {
  const file = files.get(publicId);
  if (!file) {
    throw {
      request_options: {},
      query_params: {},
      error: { message: `Resource not found - ${publicId}`, http_code: 404 },
    };
  }
  return describeFile(file);
}

// the file at an image url the app gives: the transforms are not applied, the file comes as it
// is kept; the version in the url only breaks caches, the newest file comes for any version
function deliver(url: string): Response {
  const path = url.slice(deliveryBase('https').length).split(/[?#]/)[0]!.split('/');
  const versionAt = path.findIndex((segment) => /^v\d+$/.test(segment));
  const file =
    versionAt === -1
      ? undefined
      : files.get(
          path
            .slice(versionAt + 1)
            .join('/')
            .replace(/\.[^./]+$/, ''),
        );

  return file
    ? new Response(new Uint8Array(file.data), {
        status: 200,
        headers: { 'content-type': `image/${file.format === 'jpg' ? 'jpeg' : file.format}` },
      })
    : new Response(null, { status: 404 });
}

// in place for the whole test file, by assignment and not jest.spyOn: restoreAllMocks of a test
// must not take it away
export function installCloudinaryMock(): void {
  const uploader = cloudinary.uploader as unknown as Record<string, unknown>;
  uploader.upload_stream = uploadStream;
  uploader.rename = rename;
  uploader.destroy = destroy;
  (cloudinary.api as unknown as Record<string, unknown>).resource = resource;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith(deliveryBase('https')) ? deliver(url) : realFetch(input, init);
  }) as typeof fetch;
}
