import { describe, expect, it } from '@jest/globals';

import { buildPasswordChangedTemplate } from '@services/email/templates/auth/passwordChanged.template.js';

const args = {
  loginUrl: 'https://shop.test/web/login',
  changedAt: new Date('2026-10-23T09:05:00.000Z'),
};

describe('buildPasswordChangedTemplate', () => {
  it('names the shop and what happened in the subject', () => {
    const { subject } = buildPasswordChangedTemplate(args);

    expect(subject).toBe('Cartlify — Your password was changed');
  });

  it('says when the password changed, in utc', () => {
    const { text, html } = buildPasswordChangedTemplate(args);

    expect(text).toContain('2026-10-23 09:05 UTC');
    expect(html).toContain('2026-10-23 09:05 UTC');
  });

  // the person who did not change it has no session left but this one: the way back is the reset
  it('tells a person who did not change it to reset the password from the login page', () => {
    const { text, html } = buildPasswordChangedTemplate(args);

    expect(text).toContain('If you did not change it');
    expect(text).toContain(args.loginUrl);
    expect(html).toContain(`href="${args.loginUrl}"`);
  });

  it('greets the user by name, escaped, or without one', () => {
    expect(buildPasswordChangedTemplate({ ...args, userName: 'Anna' }).html).toContain('Hi Anna,');
    expect(buildPasswordChangedTemplate({ ...args, userName: ' ' }).html).toContain('Hi,');
    expect(
      buildPasswordChangedTemplate({ ...args, userName: '<img src=x onerror=alert(1)>' }).html,
    ).not.toContain('<img src=x');
  });

  it('keeps the plain text version free of html', () => {
    const { text } = buildPasswordChangedTemplate({ ...args, userName: 'Anna', logoCid: 'logo' });

    expect(text).not.toMatch(/<[a-z!/]/i);
  });

  it('refuses to build a mail without the link to the login page', () => {
    expect(() => buildPasswordChangedTemplate({ ...args, loginUrl: ' ' })).toThrow(
      'LOGIN_URL_REQUIRED',
    );
  });
});
