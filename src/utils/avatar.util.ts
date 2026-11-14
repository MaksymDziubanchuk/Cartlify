import { fileStorage } from '@providers/files/index.js';

import type { AvatarUrls } from 'types/dto/users.dto.js';

// the avatar of an account in every answer: its own picture, or, without one, one letter on a
// color, the way many accounts show one. The file storage draws it (letterAvatarUrls), nothing
// is stored for an account: a new name is a new url. The letter is the first letter of the name, without a name the first one of the email;
// a deleted account (Guest) is G on grey

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

// whether the picture draws its letter from the name: a name of signs only gives none, the email does
export const nameGivesLetter = (name: string | null | undefined): boolean => firstSign(name) !== null;

const colorOf = (owner: AvatarOwner) =>
  owner.deleted ? DELETED_AVATAR_COLOR : AVATAR_COLORS[owner.id % AVATAR_COLORS.length]!;

export function avatarOf(owner: AvatarOwner): Avatar {
  // an address a provider gave before the copies is no picture of ours: it has no sizes
  if (!owner.deleted && fileStorage.isOwnUrl(owner.avatarUrl)) {
    return { avatarUrls: fileStorage.imageUrls(owner.avatarUrl, 'avatar'), avatarIsDefault: false };
  }

  const letter = letterOf(owner);
  const color = colorOf(owner);

  return { avatarUrls: fileStorage.letterAvatarUrls(letter, color), avatarIsDefault: true };
}
