import { renderTemplate } from '@services/email/renderTemplate.js';

export type AvatarRemovedTemplateArgs = {
  // which removal by a moderator this is, this one counted
  removals: number;
  // the removals the rules allow (AVATAR_REMOVALS_LIMIT)
  limit: number;
  userName?: string | null;
  appName?: string;
  logoCid?: string;
};

// the mail itself is avatarRemoved.html and avatarRemoved.txt next to this file. Before the limit
// it counts the removal, at the limit it warns it was the last one, past it it says the account
// can be deleted now
export function buildAvatarRemovedTemplate(args: AvatarRemovedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';

  const values = {
    appName,
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
    removals: String(args.removals),
    limit: String(args.limit),
    beforeLimit: args.removals < args.limit ? 'yes' : '',
    atLimit: args.removals === args.limit ? 'yes' : '',
    pastLimit: args.removals > args.limit ? 'yes' : '',
  };

  return {
    subject: `${appName} — Your profile picture was removed`,
    text: renderTemplate('users/avatarRemoved.txt', values),
    html: renderTemplate('users/avatarRemoved.html', values),
  };
}
