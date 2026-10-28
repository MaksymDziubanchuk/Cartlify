import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import cloudinary from '@config/cloudinary.js';

import { CLOUDINARY_PLACEHOLDERS } from '../setup/isolateEnv.js';
import { installCloudinaryMock } from './cloudinaryMock.js';
import { hideSecrets } from './hideSecrets.js';
import { isRealService } from './services.js';
import type { FormPart } from './multipart.js';

// Cloudinary in the integration tests (tests/setup/integration.cloudinary.ts puts it in place):
// - a mock by default (tests/helpers/cloudinaryMock.ts), its files live in memory for the test file;
// - the real account when the run names it (npm test -- service:cloudinary): Cloudinary has no
//   test mode, the uploads go into the test/ folder of the account.
// In both a call outside test/ is stopped, the public id of every file the app made is kept, and
// removeUploads deletes them after the file. The app uploads to a waiting id (test/uploads/<uuid>)
// and moves the file to its place only for a request it takes: after every request no waiting
// upload is left (waitingUploadsSince). The test database numbers users and products from 1 on
// every run, so at the real account a file of an earlier run can sit at the same path: a test
// compares the file before and after a request, by its version and its size (the version counts
// seconds)

export const TEST_FOLDER = 'test/';

export const realCloudinary = isRealService('cloudinary');

// public ids the app uploaded during this test file, in their order
export const uploadedPublicIds = new Set<string>();

// public ids the app moved an upload to during this test file
export const movedToPublicIds = new Set<string>();

// every move the app asked for during this test file, with what it asked Cloudinary
export type MoveCall = { from: string; to: string; options: Record<string, unknown> };
export const moveCalls: MoveCall[] = [];

// the move of the sdk itself, taken before the mock and the guard below take its place
const sdkRename = cloudinary.uploader.rename as (...args: unknown[]) => unknown;

// the move of the service, the mock or the account; withSilentCloudinaryMoves puts another in its
// place for a while
let serviceRename: (...args: unknown[]) => unknown = sdkRename;

// a Cloudinary failure without the keys in it, an error of the sdk can name them
function cloudinaryFailure(err: unknown, what: string): Error {
  const e = err as {
    http_code?: number;
    message?: string;
    error?: { http_code?: number; message?: string };
  };
  const code = e?.error?.http_code ?? e?.http_code;
  const message = e?.error?.message ?? e?.message ?? String(err);

  return new Error(hideSecrets(`Cloudinary could not ${what}: ${code ?? ''} ${message}`));
}

const httpCodeOf = (err: unknown) => {
  const e = err as { http_code?: number; error?: { http_code?: number } };
  return e?.error?.http_code ?? e?.http_code;
};

function assertTestFolder(publicId: unknown, call: string): asserts publicId is string {
  if (typeof publicId !== 'string' || !publicId.startsWith(TEST_FOLDER)) {
    throw new Error(`a Cloudinary ${call} outside ${TEST_FOLDER} was stopped: ${String(publicId)}`);
  }
}

// the calls of the app that change files pass through as they are, only the folder is checked;
// assigned, not spied: jest.restoreAllMocks in a test file must not take the guard away
function holdCloudinaryInTestFolder(): void {
  const uploader = cloudinary.uploader;
  const uploadStream = uploader.upload_stream;
  const rename = uploader.rename;
  const destroy = uploader.destroy;

  uploader.upload_stream = function (this: unknown, ...args: unknown[]) {
    const options = (args.find((arg) => typeof arg === 'object' && arg !== null) ?? {}) as {
      public_id?: unknown;
    };
    assertTestFolder(options.public_id, 'upload');
    uploadedPublicIds.add(options.public_id);

    return (uploadStream as (...a: unknown[]) => ReturnType<typeof uploadStream>).apply(this, args);
  } as typeof uploadStream;

  serviceRename = rename as (...args: unknown[]) => unknown;
  uploader.rename = function (this: unknown, ...args: unknown[]) {
    assertTestFolder(args[0], 'move');
    assertTestFolder(args[1], 'move');
    movedToPublicIds.add(args[1]);
    moveCalls.push({
      from: args[0],
      to: args[1],
      options: { ...((args[2] as Record<string, unknown> | undefined) ?? {}) },
    });

    return serviceRename.apply(this, args) as ReturnType<typeof rename>;
  } as typeof rename;

  uploader.destroy = function (this: unknown, ...args: unknown[]) {
    assertTestFolder(args[0], 'delete');

    return (destroy as (...a: unknown[]) => ReturnType<typeof destroy>).apply(this, args);
  } as typeof destroy;
}

// the mock or the real account, held in the test folder either way
export function installCloudinary(): void {
  if (!realCloudinary) installCloudinaryMock();
  holdCloudinaryInTestFolder();
}

export type StoredImage = {
  version: number;
  width: number;
  height: number;
  format: string;
  tags: string[];
};

// the file at the public id as Cloudinary keeps it, null when there is none
export async function storedImage(publicId: string): Promise<StoredImage | null> {
  try {
    const res = await cloudinary.api.resource(publicId, { resource_type: 'image', type: 'upload' });

    return {
      version: res.version,
      width: res.width,
      height: res.height,
      format: res.format,
      tags: res.tags ?? [],
    };
  } catch (err) {
    if (httpCodeOf(err) === 404) return null;
    throw cloudinaryFailure(err, `read ${publicId}`);
  }
}

export type UploadMark = { uploads: number; moves: number; calls: number };

// how many uploads and moves the app made so far, to tell the ones of a request apart
export const uploadMark = (): UploadMark => ({
  uploads: uploadedPublicIds.size,
  moves: movedToPublicIds.size,
  calls: moveCalls.length,
});

// the moves the app asked for since the mark, with what each asked of Cloudinary
export const moveCallsSince = (mark: UploadMark) => moveCalls.slice(mark.calls);

// Cloudinary that takes the connection of a move and never answers, the way a Cloudinary that
// hangs does: the moves go to a server of the test that keeps the connection and says nothing, and
// the sdk itself gives up after the time the app gives a move. Only the moves: the uploads and the
// deletes go to the mock or the account as before
export async function withSilentCloudinaryMoves<T>(fn: () => Promise<T>): Promise<T> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  const service = serviceRename;
  serviceRename = function (this: unknown, from: unknown, to: unknown, options: unknown) {
    return sdkRename.call(this, from, to, {
      ...((options as Record<string, unknown> | undefined) ?? {}),
      upload_prefix: `https://127.0.0.1:${port}`,
    });
  };

  try {
    return await fn();
  } finally {
    serviceRename = service;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// the uploads the app made since the mark
export const uploadsSince = (mark: UploadMark) => [...uploadedPublicIds].slice(mark.uploads);

// the places the app moved an upload to since the mark: a refused request moves nothing, so no
// file of an avatar or a product changed
export const movesSince = (mark: UploadMark) => [...movedToPublicIds].slice(mark.moves);

// the uploads the app made since the mark that still wait at their waiting id: a request leaves
// none, it moves each upload to its place or deletes it
export async function waitingUploadsSince(mark: UploadMark): Promise<string[]> {
  const ids = uploadsSince(mark);
  const left = await Promise.all(ids.map(async (id) => ((await storedImage(id)) ? id : null)));

  return left.filter((id): id is string => id !== null);
}

// deletes what the app uploaded and moved during the file; a file already gone is fine
export async function removeUploads(): Promise<void> {
  const ids = [...new Set([...uploadedPublicIds, ...movedToPublicIds])];
  const results = await Promise.allSettled(
    ids.map(async (publicId) => {
      try {
        await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
      } catch (err) {
        throw cloudinaryFailure(err, `delete ${publicId}`);
      }
    }),
  );
  uploadedPublicIds.clear();
  movedToPublicIds.clear();

  const failures = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
  if (failures.length) throw new Error(failures.join('\n'));
}

// the body of an answer with the cloud name in its image urls hidden, for checks whose failure
// prints the body
export const bodyOf = (res: { body: string }) => JSON.parse(hideSecrets(res.body));

// the start of an image url the app gives, as bodyOf shows it: the real cloud name is hidden, the
// made-up one of the mock is not a secret
export const deliveryUrl = (transforms: string) =>
  `https://res.cloudinary.com/${realCloudinary ? '[hidden]' : CLOUDINARY_PLACEHOLDERS.CLOUDINARY_CLOUD_NAME}` +
  `/image/upload/${transforms ? `${transforms}/` : ''}`;

const pngChunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
};

// a real png of one color; its size tells the files of the tests apart
export function pngImage(width: number, height: number, rgb = [200, 60, 40]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // 8 bits per channel, rgb, no interlace
  header.set([8, 2, 0, 0, 0], 8);

  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// real jpeg and webp files Cloudinary made from a png of the tests (21.10.2026), one for every form
// of header: a baseline and a progressive jpeg, a lossy (VP8), a lossless (VP8L) and an extended
// (VP8X) webp; the format and the size are the ones Cloudinary read in them
export const IMAGE_FIXTURES = [
  { file: 'jpeg-baseline.jpg', contentType: 'image/jpeg', format: 'jpg', width: 24, height: 16 },
  { file: 'jpeg-progressive.jpg', contentType: 'image/jpeg', format: 'jpg', width: 24, height: 16 },
  { file: 'webp-lossy.webp', contentType: 'image/webp', format: 'webp', width: 24, height: 16 },
  { file: 'webp-lossless.webp', contentType: 'image/webp', format: 'webp', width: 24, height: 16 },
  { file: 'webp-extended.webp', contentType: 'image/webp', format: 'webp', width: 20, height: 12 },
] as const;

export type ImageFixture = (typeof IMAGE_FIXTURES)[number];

export const fixtureImage = (file: ImageFixture['file']) =>
  readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'images', file));

// the start of a png and then no image: the app takes it by its first bytes, Cloudinary cannot
// read it
export const brokenPng = () =>
  Buffer.concat([pngImage(4, 4).subarray(0, 8), Buffer.from('the rest is not a png at all')]);

// a real 1x1 gif and a real svg: images, but not of the jpeg, png or webp the app takes
export const gifImage = () =>
  Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

export const svgImage = () =>
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12">' +
      '<rect width="12" height="12" fill="#c83c28"/></svg>',
  );

// a file field of a form; a png by default
export const imageField = (
  name: string,
  data: Buffer,
  opts: { contentType?: string; filename?: string } = {},
): FormPart => ({
  name,
  filename: opts.filename ?? 'image.png',
  contentType: opts.contentType ?? 'image/png',
  data,
});
