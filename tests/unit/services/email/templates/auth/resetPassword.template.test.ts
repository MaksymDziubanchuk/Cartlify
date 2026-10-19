import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { buildResetPasswordTemplate } from '@services/email/templates/auth/resetPassword.template.js';

const resetUrl = 'https://shop.test/reset-password?token=abc123';

afterEach(() => {
  jest.useRealTimers();
});

describe('buildResetPasswordTemplate', () => {
  it('names the shop and the purpose in the subject', () => {
    const { subject } = buildResetPasswordTemplate({ resetUrl });

    expect(subject).toContain('Cartlify');
    expect(subject.toLowerCase()).toContain('reset your password');
  });

  it('uses the given app name instead of the default one', () => {
    const { subject, html } = buildResetPasswordTemplate({ resetUrl, appName: 'Other Shop' });

    expect(subject).toContain('Other Shop');
    expect(html).toContain('Other Shop');
  });

  it('puts the reset link into the text and the html versions', () => {
    const { text, html } = buildResetPasswordTemplate({ resetUrl });

    expect(text).toContain(resetUrl);
    expect(html).toContain(`href="${resetUrl}"`);
  });

  it('keeps the plain text version free of html', () => {
    const { text } = buildResetPasswordTemplate({ resetUrl, userName: 'Anna', logoCid: 'logo' });

    expect(text).not.toMatch(/<[a-z!/]/i);
  });

  it('says how long the link is valid when told, and nothing when not', () => {
    const withTtl = buildResetPasswordTemplate({ resetUrl, expiresInText: '1 hour' });
    const withoutTtl = buildResetPasswordTemplate({ resetUrl });

    expect(withTtl.text).toContain('1 hour');
    expect(withTtl.html).toContain('1 hour');
    expect(withoutTtl.text).not.toMatch(/valid for/i);
    expect(withoutTtl.html).not.toMatch(/valid for/i);
  });

  it('greets the user by name, or without one when the name is blank', () => {
    expect(buildResetPasswordTemplate({ resetUrl, userName: 'Anna' }).html).toContain('Hi Anna,');
    expect(buildResetPasswordTemplate({ resetUrl, userName: '   ' }).html).toContain('Hi,');
  });

  it('escapes the user name, it comes from the user and must not inject html', () => {
    const { html } = buildResetPasswordTemplate({
      resetUrl,
      userName: '<img src=x onerror=alert(1)>',
    });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes the link so it cannot break out of the href', () => {
    const { html } = buildResetPasswordTemplate({
      resetUrl: 'https://shop.test/reset?token=a&b="><script>alert(1)</script>',
    });

    expect(html).not.toContain('"><script>');
    expect(html).toContain('token=a&amp;b=');
  });

  it('shows the attached logo when a content id is given, the shop name otherwise', () => {
    expect(buildResetPasswordTemplate({ resetUrl, logoCid: 'cartlify-logo' }).html).toContain(
      'src="cid:cartlify-logo"',
    );
    expect(buildResetPasswordTemplate({ resetUrl }).html).not.toContain('cid:');
  });

  it('puts the current year into the footer', () => {
    jest.useFakeTimers({ now: new Date('2031-05-01T12:00:00Z') });

    expect(buildResetPasswordTemplate({ resetUrl }).html).toContain('© 2031 Cartlify');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('refuses to build the email when the link is %s', (_case, url) => {
    expect(() => buildResetPasswordTemplate({ resetUrl: url })).toThrow();
  });
});
