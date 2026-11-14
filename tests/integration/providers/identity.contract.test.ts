import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { identityProviders } from '@providers/identity/index.js';

import { thrownBy } from '../../helpers/errors.js';
import { identityHarness } from '../../helpers/providers.js';

// The contract of a provider of accounts: what the login of the shop counts on, whoever vouches for
// the person (src/providers/identity/types.ts). Every provider of the registry goes through these
// tests, made to answer by its entry in tests/helpers/providers.ts; a new provider passes them
// without tests of its own.

afterEach(() => {
  jest.restoreAllMocks();
});

const stateOf = (url: string) => new URL(url).searchParams.get('state') ?? '';

describe.each(identityProviders.map((provider) => [provider.name, provider] as const))(
  'the provider of accounts %s',
  (name, provider) => {
    const harness = identityHarness[name];

    it('sends the browser to the provider with a state of this guest, and reads it back', () => {
      const url = provider.startUrl('guest-1', [3, 4], true);

      expect(url).toMatch(/^https:\/\//);
      expect(provider.readState(stateOf(url), 'guest-1')).toMatchObject({
        guestId: 'guest-1',
        accepted: [3, 4],
        newsletter: true,
      });
    });

    it('refuses the state of a login another guest started', () => {
      const url = provider.startUrl('guest-1', [], false);

      expect(thrownBy(() => provider.readState(stateOf(url), 'guest-2'))).toMatchObject({
        errorCode: 'OAUTH_STATE_GUEST_MISMATCH',
      });
    });

    it('refuses a state it did not sign', () => {
      const url = provider.startUrl('guest-1', [], false);
      const [payload] = stateOf(url).split('.');

      expect(thrownBy(() => provider.readState(`${payload}.forged`, 'guest-1'))).toMatchObject({
        errorCode: 'INVALID_PAYLOAD',
      });
    });

    it('tells the person the code of a login names, in our words', async () => {
      harness.answerWith({
        sub: '4242',
        email: 'Person@Example.com',
        verified: true,
        name: 'A Person',
        picture: harness.ownPicture,
      });
      const state = stateOf(provider.startUrl('guest-1', [], false));

      const person = await provider.readPerson('the-code', state);

      expect(person).toMatchObject({
        sub: '4242',
        email: expect.stringMatching(/^person@example\.com$/i),
        emailVerified: true,
        name: 'A Person',
        avatarUrl: harness.ownPicture,
      });
    });

    it('says when it has not proven the address', async () => {
      harness.answerWith({
        sub: '4243',
        email: 'unproven@example.com',
        verified: false,
        name: 'Somebody',
        picture: harness.ownPicture,
      });
      const state = stateOf(provider.startUrl('guest-1', [], false));

      expect((await provider.readPerson('the-code', state)).emailVerified).toBe(false);
    });

    it('opens a picture on a host of its own only, over https', () => {
      expect(provider.pictureUrl(harness.ownPicture, 256)?.protocol).toBe('https:');
      expect(provider.pictureUrl('https://example.com/photo.png', 256)).toBeNull();
      expect(provider.pictureUrl(harness.ownPicture.replace('https:', 'http:'), 256)).toBeNull();
      expect(provider.pictureUrl('not an address', 256)).toBeNull();
    });
  },
);
