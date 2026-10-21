import cloudinary from '@config/cloudinary.js';
import {
  ENV_FOLDER,
  buildImageUrls,
  isCloudinaryUrl,
  uploadImage,
} from '@utils/cloudinary.util.js';

import type { FastifyBaseLogger } from 'fastify';
import type { AvatarUrls } from 'types/dto/users.dto.js';

// the avatar of an account in every answer: its own picture, or, without one, one letter on a
// color the way a Google account shows it. Cloudinary draws the letter at the url on a plain
// picture of the folder of the environment, nothing is stored for an account: a new name is a
// new url. The letter is the first letter of the name, without a name the first one of the email;
// a deleted account (Guest) is G on grey

// the plain white picture the letters go on; the server puts it there when it starts
export const AVATAR_BASE_PUBLIC_ID = `${ENV_FOLDER}/common/avatar-base`;

// an 8x8 white png
const AVATAR_BASE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAD0lEQVR4nGP4jwMwDC0JALoev0Ewkwr8AAAAAElFTkSuQmCC',
  'base64',
);

// colors white letters read well on, one per account by its id; grey is left for deleted accounts
export const AVATAR_COLORS = [
  'E53935',
  'D81B60',
  '8E24AA',
  '5E35B1',
  '3949AB',
  '1E88E5',
  '00838F',
  '00897B',
  '2E7D32',
  'EF6C00',
  'F4511E',
  '6D4C41',
] as const;

export const DELETED_AVATAR_COLOR = '757575';

export type AvatarOwner = {
  id: number;
  name: string | null | undefined;
  email: string | null | undefined;
  avatarUrl: string | null | undefined;
  deleted?: boolean;
};

export type Avatar = { avatarUrls: AvatarUrls; avatarIsDefault: boolean };

// the first letter or digit of a text, in upper case; a letter whose upper case is two letters
// (the german ß) stays as it is, the picture has room for one
function firstSign(text: string | null | undefined): string | null {
  const sign = text?.normalize('NFC').match(/[\p{L}\p{N}]\p{M}*/u)?.[0];
  if (!sign) return null;

  const upper = sign.toUpperCase().normalize('NFC');
  return [...upper].length === [...sign].length ? upper : sign;
}

const letterOf = (owner: AvatarOwner) =>
  firstSign(owner.name) ?? firstSign(owner.email?.split('@')[0]) ?? '?';

const colorOf = (owner: AvatarOwner) =>
  owner.deleted ? DELETED_AVATAR_COLOR : AVATAR_COLORS[owner.id % AVATAR_COLORS.length]!;

// the letter takes half of the side
const drawnUrl = (letter: string, color: string, size: number) =>
  `https://res.cloudinary.com/${cloudinary.config().cloud_name}/image/upload/` +
  `c_scale,w_${size},h_${size}/e_colorize:100,co_rgb:${color}` +
  `/l_text:Roboto_${size / 2}_bold:${encodeURIComponent(letter)},co_white/fl_layer_apply,g_center` +
  `/f_auto,q_auto/v1/${AVATAR_BASE_PUBLIC_ID}.png`;

export function avatarOf(owner: AvatarOwner): Avatar {
  // an address a provider gave before the copies is no picture of ours: it has no sizes
  if (!owner.deleted && isCloudinaryUrl(owner.avatarUrl)) {
    return { avatarUrls: buildImageUrls(owner.avatarUrl, 'avatar'), avatarIsDefault: false };
  }

  const letter = letterOf(owner);
  const color = colorOf(owner);

  return {
    avatarUrls: {
      url32: drawnUrl(letter, color, 32),
      url64: drawnUrl(letter, color, 64),
      url128: drawnUrl(letter, color, 128),
      url256: drawnUrl(letter, color, 256),
    },
    avatarIsDefault: true,
  };
}

const httpCodeOf = (err: unknown) => {
  const e = err as { http_code?: unknown; error?: { http_code?: unknown } } | null;
  return e?.error?.http_code ?? e?.http_code;
};

// puts the plain picture into the folder of the environment when it is not there, so a new
// Cloudinary account draws avatars without a step by hand. It never throws: until the picture is
// there the drawn avatars do not show, the failure goes to the log
export async function ensureAvatarBase(log: Pick<FastifyBaseLogger, 'info' | 'warn'>) {
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
    await uploadImage({
      file: AVATAR_BASE_PNG,
      mimetype: 'image/png',
      publicId: AVATAR_BASE_PUBLIC_ID,
    });
    log.info('avatar base uploaded');
  } catch (err) {
    log.warn({ err }, 'avatar base was not uploaded');
  }
}
