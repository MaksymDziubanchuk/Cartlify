import { describe, expect, it } from '@jest/globals';

import { buildTwoFactorNoticeTemplate } from '@services/email/templates/auth/twoFactorNotice.template.js';

const base = {
  loginUrl: 'https://shop.test/web/login',
  at: new Date('2026-11-25T09:05:00.000Z'),
};

describe('buildTwoFactorNoticeTemplate', () => {
  it('tells an admin that root reset the second step and what the next login does', () => {
    const { subject, text, html } = buildTwoFactorNoticeTemplate({ ...base, kind: 'reset' });

    expect(subject).toBe('Cartlify — The second step of your login was reset');
    for (const body of [text, html]) {
      expect(body).toContain('2026-11-25 09:05 UTC');
      expect(body).toContain('At your next login you set up the app again');
    }
  });

  it('tells of a login with a recovery code and how many codes are left', () => {
    const { subject, text, html } = buildTwoFactorNoticeTemplate({
      ...base,
      kind: 'recovery',
      recoveryCodesLeft: 7,
    });

    expect(subject).toBe('Cartlify — A recovery code was used to log in');
    for (const body of [text, html]) {
      expect(body).toContain('2026-11-25 09:05 UTC');
      expect(body).toContain('Recovery codes left: 7');
    }
  });

  // the person it was not: the way is root and a new password, from the login page
  it('tells a person it was not to tell root, with the link to the login page', () => {
    const { text, html } = buildTwoFactorNoticeTemplate({ ...base, kind: 'recovery' });

    expect(text).toContain('If this was not you, tell root at once');
    expect(text).toContain(base.loginUrl);
    expect(html).toContain(`href="${base.loginUrl}"`);
  });

  it('keeps the plain text version free of html', () => {
    const { text } = buildTwoFactorNoticeTemplate({ ...base, kind: 'reset', userName: 'Anna' });

    expect(text).not.toMatch(/<[a-z!/]/i);
  });

  it('refuses to build a mail without the link to the login page', () => {
    expect(() => buildTwoFactorNoticeTemplate({ ...base, kind: 'reset', loginUrl: ' ' })).toThrow(
      'LOGIN_URL_REQUIRED',
    );
  });

  it('writes in the language given, English by default', () => {
    const uk = buildTwoFactorNoticeTemplate({ ...base, kind: 'reset', locale: 'uk' });
    const es = buildTwoFactorNoticeTemplate({ ...base, kind: 'recovery', locale: 'es' });

    expect(uk.subject).toBe('Cartlify — Другий крок вашого входу скинуто');
    expect(es.subject).toBe('Cartlify — Se usó un código de recuperación para iniciar sesión');
  });
});
