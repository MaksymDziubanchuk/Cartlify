import { ENVIRONMENT_NAME } from '@config/environment.js';

import cloudinary from './cloudinaryClient.js';

import type { FastifyBaseLogger } from 'fastify';
import type { UploadImageArgs, UploadImageResult } from '../types.js';

import type { AvatarUrls } from 'types/dto/users.dto.js';

// The avatar of an account without a picture of its own, drawn by Cloudinary: a letter at the url
// on a plain picture of the folder of the environment, nothing is stored for an account (a new name
// is a new url)

// the plain white picture the letters go on; the server puts it there when it starts
export const AVATAR_BASE_PUBLIC_ID = `${ENVIRONMENT_NAME}/common/avatar-base`;

// an 8x8 white png
const AVATAR_BASE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAD0lEQVR4nGP4jwMwDC0JALoev0Ewkwr8AAAAAElFTkSuQmCC',
  'base64',
);

// the letter takes half of the side
const drawnUrl = (letter: string, color: string, size: number) =>
  `https://res.cloudinary.com/${cloudinary.config().cloud_name}/image/upload/` +
  `c_scale,w_${size},h_${size}/e_colorize:100,co_rgb:${color}` +
  `/l_text:Roboto_${size / 2}_bold:${encodeURIComponent(letter)},co_white/fl_layer_apply,g_center` +
  `/f_auto,q_auto/v1/${AVATAR_BASE_PUBLIC_ID}.png`;

export const letterAvatarUrls = (letter: string, color: string): AvatarUrls => ({
  url32: drawnUrl(letter, color, 32),
  url64: drawnUrl(letter, color, 64),
  url128: drawnUrl(letter, color, 128),
  url256: drawnUrl(letter, color, 256),
});

const httpCodeOf = (err: unknown) => {
  const e = err as { http_code?: unknown; error?: { http_code?: unknown } } | null;
  return e?.error?.http_code ?? e?.http_code;
};

// puts the plain picture into the folder of the environment when it is not there, so a new
// Cloudinary account draws avatars without a step by hand. It never throws: until the picture is
// there the drawn avatars do not show, the failure goes to the log
export async function prepareLetterAvatars(
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  upload: (args: UploadImageArgs) => Promise<UploadImageResult>,
): Promise<void> {
  try {
    await cloudinary.api.resource(AVATAR_BASE_PUBLIC_ID, {
      resource_type: 'image',
      type: 'upload',
    });
    return;
  } catch (err) {
    if (httpCodeOf(err) !== 404) {
      log.warn({ httpCode: httpCodeOf(err) }, 'avatar base was not checked');
      return;
    }
  }

  try {
    await upload({ file: AVATAR_BASE_PNG, mimetype: 'image/png', publicId: AVATAR_BASE_PUBLIC_ID });
    log.info('avatar base uploaded');
  } catch (err) {
    log.warn({ err }, 'avatar base was not uploaded');
  }
}
