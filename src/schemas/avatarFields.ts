// the avatar of an account in an answer (src/utils/avatar.util.ts): every answer that names an
// account gives both fields

export const avatarUrlsField = {
  type: 'object',
  additionalProperties: false,
  description:
    'The avatar in four sizes: the own picture of the account, or, without one, the first letter ' +
    'of the name (of the email when there is no name) on a color; a deleted account is G on grey.',
  properties: {
    url32: { type: 'string' },
    url64: { type: 'string' },
    url128: { type: 'string' },
    url256: { type: 'string' },
  },
  required: ['url32', 'url64', 'url128', 'url256'],
} as const;

export const avatarIsDefaultField = {
  type: 'boolean',
  description: 'true when the avatar is the drawn letter: the account has no picture of its own.',
} as const;
