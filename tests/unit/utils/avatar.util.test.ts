import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import cloudinary from '@config/cloudinary.js';
import {
  AVATAR_BASE_PUBLIC_ID,
  AVATAR_COLORS,
  DELETED_AVATAR_COLOR,
  avatarOf,
  ensureAvatarBase,
} from '@utils/avatar.util.js';

import { drawnAvatar as drawn } from '../../helpers/avatar.js';

// the avatar every answer gives: the own picture of the account, or one letter on a color that
// Cloudinary draws at the url (nothing is stored for it). The letter is the first letter of the
// name, without a name the first one of the email; a deleted account (Guest) is G on grey. The
// tests run with NODE_ENV=test and the made-up cloud of the unit setup

// a text of the given code points
const text = (...codes: number[]) => String.fromCodePoint(...codes);

const OWN = 'https://res.cloudinary.com/demo/image/upload/v1712345678/test/users/7/avatar.jpg';
const CLOUD = 'https://res.cloudinary.com/test-cloud/image/upload/';

const account = (overrides: Partial<Parameters<typeof avatarOf>[0]> = {}) => ({
  id: 7,
  name: 'anna',
  email: 'anna@example.com',
  avatarUrl: null,
  deleted: false,
  ...overrides,
});

describe('AVATAR_BASE_PUBLIC_ID', () => {
  it('keeps the plain picture the letters go on in the folder of the environment', () => {
    expect(AVATAR_BASE_PUBLIC_ID).toBe('test/common/avatar-base');
  });
});

describe('avatarOf', () => {
  it('gives the own picture of the account in four sizes', () => {
    const avatar = avatarOf(account({ avatarUrl: OWN }));

    expect(avatar.avatarIsDefault).toBe(false);
    expect(avatar.avatarUrls.url64).toBe(
      OWN.replace('/upload/', '/upload/c_fill,g_face,w_64,h_64,f_auto,q_auto/'),
    );
  });

  it('draws the letter on the color of the account in four sizes when it has no picture', () => {
    const avatar = avatarOf(account());
    const color = AVATAR_COLORS[7 % AVATAR_COLORS.length];

    expect(avatar.avatarIsDefault).toBe(true);
    expect(avatar.avatarUrls).toEqual(
      Object.fromEntries(
        [32, 64, 128, 256].map((size) => [
          `url${size}`,
          `${CLOUD}c_scale,w_${size},h_${size}/e_colorize:100,co_rgb:${color}` +
            `/l_text:Roboto_${size / 2}_bold:A,co_white/fl_layer_apply,g_center` +
            `/f_auto,q_auto/v1/${AVATAR_BASE_PUBLIC_ID}.png`,
        ]),
      ),
    );
  });

  // the cyrillic letters are made from their code points, the code of the repository is in english
  it.each([
    ['a cyrillic name', text(0x457, 0x436, 0x430, 0x43a), text(0x407)],
    ['a name written with a combining mark', text(0x406, 0x308, 0x433, 0x43e, 0x440), text(0x407)],
    ['a name after spaces and an emoji', '  😀 bohdan', 'B'],
    ['a name of two words', 'maria shevchenko', 'M'],
    ['a name of digits', '007 agent', '0'],
  ])('takes the first letter of %s, in upper case', (_case, name, letter) => {
    expect(drawn(avatarOf(account({ name })).avatarUrls.url32)?.letter).toBe(letter);
  });

  it.each([
    ['no name', null, 'kate@example.com', 'K'],
    ['an empty name', '', 'kate@example.com', 'K'],
    ['a name without a letter or a digit', '!!!', 'kate@example.com', 'K'],
    ['no name and an email that starts with a sign', null, '_kate@example.com', 'K'],
    ['no name and an email of digits', null, '42@example.com', '4'],
  ])('takes the first letter of the email for %s', (_case, name, email, letter) => {
    expect(drawn(avatarOf(account({ name, email })).avatarUrls.url32)?.letter).toBe(letter);
  });

  it('draws a question mark when neither the name nor the email has a letter or a digit', () => {
    const avatar = avatarOf(account({ name: null, email: '__@example.com' }));

    expect(drawn(avatar.avatarUrls.url32)?.letter).toBe('?');
  });

  it('draws G on grey for a deleted account', () => {
    const avatar = avatarOf(account({ name: 'Guest', deleted: true }));

    expect(avatar.avatarIsDefault).toBe(true);
    expect(drawn(avatar.avatarUrls.url256)).toEqual({ color: DELETED_AVATAR_COLOR, letter: 'G' });
    expect(AVATAR_COLORS).not.toContain(DELETED_AVATAR_COLOR);
  });

  // the address of a provider picture was kept before the copies; it gives no sizes
  it('draws the letter for a picture that is not at Cloudinary', () => {
    const avatar = avatarOf(
      account({ avatarUrl: 'https://lh3.googleusercontent.com/a/photo=s96-c' }),
    );

    expect(avatar.avatarIsDefault).toBe(true);
    expect(drawn(avatar.avatarUrls.url64)?.letter).toBe('A');
  });

  it('keeps the color of an account and gives the next account another one', () => {
    const colorOf = (id: number) => drawn(avatarOf(account({ id })).avatarUrls.url32)?.color;

    expect(colorOf(8)).toBe(colorOf(8));
    expect(colorOf(8)).not.toBe(colorOf(9));
    expect(new Set(AVATAR_COLORS.map((_c, id) => colorOf(id))).size).toBe(AVATAR_COLORS.length);
  });
});

describe('ensureAvatarBase', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const logger = () => ({ info: jest.fn(), warn: jest.fn() });

  // what Cloudinary says about the plain picture: it is there, or an error of the admin api
  const resourceAnswers = (err?: unknown) =>
    jest.spyOn(cloudinary.api, 'resource').mockImplementation((async () => {
      if (err) throw err;
      return { public_id: AVATAR_BASE_PUBLIC_ID };
    }) as never);

  // the upload stream of the sdk, answering when the file has been written into it
  const uploadAnswers = (err: unknown, result?: unknown) =>
    jest.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((
      _options: unknown,
      callback: (err: unknown, result?: unknown) => void,
    ) => {
      const sink = new Writable({
        write(_chunk, _encoding, next) {
          next();
        },
      });
      sink.on('finish', () => callback(err, result));
      return sink;
    }) as never);

  it('uploads nothing when the plain picture is there', async () => {
    resourceAnswers();
    const upload = uploadAnswers(undefined, {});
    const log = logger();

    await ensureAvatarBase(log);

    expect(upload).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('uploads the plain png at its id when Cloudinary has none', async () => {
    resourceAnswers({ error: { http_code: 404, message: 'Resource not found' } });
    const upload = uploadAnswers(undefined, {
      public_id: AVATAR_BASE_PUBLIC_ID,
      secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${AVATAR_BASE_PUBLIC_ID}.png`,
    });
    const log = logger();

    await ensureAvatarBase(log);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0]).toMatchObject({
      public_id: AVATAR_BASE_PUBLIC_ID,
      resource_type: 'image',
    });
    expect(log.info).toHaveBeenCalledWith('avatar base uploaded');
  });

  it('goes to the log and uploads nothing when the check fails', async () => {
    resourceAnswers({ error: { http_code: 500, message: 'General Error' } });
    const upload = uploadAnswers(undefined, {});
    const log = logger();

    await ensureAvatarBase(log);

    expect(upload).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith({ httpCode: 500 }, 'avatar base was not checked');
  });

  it('goes to the log when the upload fails, and does not throw', async () => {
    resourceAnswers({ error: { http_code: 404, message: 'Resource not found' } });
    uploadAnswers({ http_code: 500, message: 'General Error' });
    const log = logger();

    await expect(ensureAvatarBase(log)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(expect.any(Object), 'avatar base was not uploaded');
  });
});
