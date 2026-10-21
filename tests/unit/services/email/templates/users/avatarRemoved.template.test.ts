import { describe, expect, it } from '@jest/globals';

import {
  buildAvatarRemovedTemplate,
  type AvatarRemovedTemplateArgs,
} from '@services/email/templates/users/avatarRemoved.template.js';

// the mail a person gets every time a moderator takes their profile picture away: which removal
// it is of the ones the rules allow, and what comes after them

const mail = (overrides: Partial<AvatarRemovedTemplateArgs> = {}) =>
  buildAvatarRemovedTemplate({ removals: 1, limit: 5, ...overrides });

describe('buildAvatarRemovedTemplate', () => {
  it('names the shop in the subject', () => {
    expect(mail().subject).toBe('Cartlify — Your profile picture was removed');
  });

  it('greets by the name when there is one', () => {
    expect(mail({ userName: 'Anna' }).text.startsWith('Hi Anna,')).toBe(true);
    expect(mail().text.startsWith('A moderator removed your profile picture')).toBe(true);
  });

  it('says the picture broke the rules and the letter shows instead', () => {
    const { text, html } = mail();

    for (const body of [text, html]) {
      expect(body).toContain('A moderator removed your profile picture');
      expect(body).toContain('the first letter of your name');
    }
  });

  it('counts a removal before the limit and tells what comes after the limit', () => {
    const { text, html } = mail({ removals: 2, limit: 5 });

    for (const body of [text, html]) {
      expect(body).toContain('This is removal 2 of the 5 the rules allow.');
      expect(body).toContain('After them your account can be deleted.');
      expect(body).not.toContain('last removal');
      expect(body).not.toContain('gone past');
    }
  });

  it('warns that the removal at the limit is the last one', () => {
    const { text, html } = mail({ removals: 5, limit: 5 });

    for (const body of [text, html]) {
      expect(body).toContain('This is the last removal the rules allow, 5 of 5.');
      expect(body).toContain('The next one can lead to the deletion of your account.');
      expect(body).not.toContain('removal 5 of the 5');
    }
  });

  it('says the account can be deleted once the removals are past the limit', () => {
    const { text, html } = mail({ removals: 6, limit: 5 });

    for (const body of [text, html]) {
      expect(body).toContain('This is removal 6, past the 5 the rules allow.');
      expect(body).toContain('Your account can now be deleted.');
      expect(body).not.toContain('last removal');
    }
  });

  it('escapes the name in the html', () => {
    expect(mail({ userName: '<b>Anna</b>' }).html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
  });
});
