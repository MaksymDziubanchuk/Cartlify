import { describe, expect, it } from '@jest/globals';

import {
  buildReviewRemovedTemplate,
  type ReviewRemovedTemplateArgs,
} from '@services/email/templates/users/reviewRemoved.template.js';

// the mail an author gets every time a moderator removes one of their reviews: of which product,
// which removal it is of the ones the rules allow, and what comes after them

const mail = (overrides: Partial<ReviewRemovedTemplateArgs> = {}) =>
  buildReviewRemovedTemplate({
    productName: 'Brass desk lamp',
    removals: 1,
    limit: 5,
    ...overrides,
  });

describe('buildReviewRemovedTemplate', () => {
  it('names the shop in the subject', () => {
    expect(mail().subject).toBe('Cartlify — Your review was removed');
  });

  it('greets by the name when there is one', () => {
    expect(mail({ userName: 'Anna' }).text.startsWith('Hi Anna,')).toBe(true);
    expect(mail().text.startsWith('A moderator removed your review')).toBe(true);
  });

  it('names the product, says the review broke the rules and a new one can follow them', () => {
    const { text, html } = mail();

    for (const body of [text, html]) {
      expect(body).toContain('A moderator removed your review of Brass desk lamp');
      expect(body).toContain('it does not follow the rules of Cartlify');
      expect(body).toContain('You can write a new review of the product that follows them.');
    }
  });

  it('counts a removal before the limit and tells what comes after the limit', () => {
    const { text, html } = mail({ removals: 2, limit: 5 });

    for (const body of [text, html]) {
      expect(body).toContain('This is removal 2 of the 5 the rules allow.');
      expect(body).toContain('After them your account can be deleted.');
      expect(body).not.toContain('last removal');
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

  it('escapes the name of the person and of the product in the html', () => {
    const { html } = mail({ userName: '<b>Anna</b>', productName: 'Lamp <i>XL</i>' });

    expect(html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
    expect(html).toContain('Lamp &lt;i&gt;XL&lt;/i&gt;');
  });

  // the dictionary of the recipient's own language (src/locales), English unless told
  it('writes in the language given, English by default', () => {
    const uk = mail({ removals: 2, limit: 5, locale: 'uk' });
    const es = mail({ removals: 2, limit: 5, locale: 'es' });

    expect(uk.text).toContain('дозволених правилами');
    expect(es.text).toContain('que permiten las normas');
    expect(uk.subject).toBe('Cartlify — Ваш відгук видалено');
    expect(es.subject).toBe('Cartlify — Se eliminó tu reseña');
  });
});
