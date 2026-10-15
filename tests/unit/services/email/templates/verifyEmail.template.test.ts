import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { buildVerifyEmailTemplate } from '@services/email/templates/verifyEmail.template.js';

const verifyUrl = 'https://shop.test/login?verify=abc123';

afterEach(() => {
  jest.useRealTimers();
});

describe('buildVerifyEmailTemplate', () => {
  it('names the shop and the purpose in the subject', () => {
    const { subject } = buildVerifyEmailTemplate({ verifyUrl });

    expect(subject).toContain('Cartlify');
    expect(subject.toLowerCase()).toContain('verify your email');
  });

  it('uses the given app name instead of the default one', () => {
    const { subject, html } = buildVerifyEmailTemplate({ verifyUrl, appName: 'Other Shop' });

    expect(subject).toContain('Other Shop');
    expect(html).toContain('Other Shop');
  });

  it('puts the verification link into the text and the html versions', () => {
    const { text, html } = buildVerifyEmailTemplate({ verifyUrl });

    expect(text).toContain(verifyUrl);
    expect(html).toContain(`href="${verifyUrl}"`);
  });

  it('keeps the plain text version free of html', () => {
    const { text } = buildVerifyEmailTemplate({ verifyUrl, userName: 'Anna', logoCid: 'logo' });

    expect(text).not.toMatch(/<[a-z!/]/i);
  });

  it('says how long the link is valid when told, and nothing when not', () => {
    const withTtl = buildVerifyEmailTemplate({ verifyUrl, expiresInText: '24 hours' });
    const withoutTtl = buildVerifyEmailTemplate({ verifyUrl });

    expect(withTtl.text).toContain('24 hours');
    expect(withTtl.html).toContain('24 hours');
    expect(withoutTtl.text).not.toMatch(/valid for/i);
    expect(withoutTtl.html).not.toMatch(/valid for/i);
  });

  it('greets the user by name, or without one when the name is blank', () => {
    expect(buildVerifyEmailTemplate({ verifyUrl, userName: 'Anna' }).html).toContain('Hi Anna,');
    expect(buildVerifyEmailTemplate({ verifyUrl, userName: '   ' }).html).toContain('Hi,');
  });

  it('escapes the user name, it comes from the user and must not inject html', () => {
    const { html } = buildVerifyEmailTemplate({
      verifyUrl,
      userName: '<a href="https://evil.test">claim prize</a>',
    });

    expect(html).not.toContain('<a href="https://evil.test"');
    expect(html).toContain('&lt;a href=');
  });

  it('escapes the link so it cannot break out of the href', () => {
    const { html } = buildVerifyEmailTemplate({
      verifyUrl: 'https://shop.test/login?verify=a&b="><script>alert(1)</script>',
    });

    expect(html).not.toContain('"><script>');
    expect(html).toContain('verify=a&amp;b=');
  });

  it('shows the attached logo when a content id is given, the shop name otherwise', () => {
    expect(buildVerifyEmailTemplate({ verifyUrl, logoCid: 'cartlify-logo' }).html).toContain(
      'src="cid:cartlify-logo"',
    );
    expect(buildVerifyEmailTemplate({ verifyUrl }).html).not.toContain('cid:');
  });

  it('puts the current year into the footer', () => {
    jest.useFakeTimers({ now: new Date('2031-05-01T12:00:00Z') });

    expect(buildVerifyEmailTemplate({ verifyUrl }).html).toContain('© 2031 Cartlify');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('refuses to build the email when the link is %s', (_case, url) => {
    expect(() => buildVerifyEmailTemplate({ verifyUrl: url })).toThrow();
  });
});
