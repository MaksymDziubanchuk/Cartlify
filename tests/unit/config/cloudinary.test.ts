import { inspect } from 'node:util';
import { describe, expect, it } from '@jest/globals';

import { rejectedBy } from '../../helpers/errors.js';
import { importWithEnv } from '../../helpers/freshImport.js';

type CloudinaryConfig = typeof import('@config/cloudinary.js');

// synthetic values; the module configures the sdk at import and refuses to load without them
const NONE = {
  CLOUDINARY_URL: '',
  CLOUDINARY_CLOUD_NAME: '',
  CLOUDINARY_API_KEY: '',
  CLOUDINARY_API_SECRET: '',
};
const SEPARATE = {
  CLOUDINARY_CLOUD_NAME: 'shop-cloud',
  CLOUDINARY_API_KEY: 'shop-key',
  CLOUDINARY_API_SECRET: 'shop-secret-value',
};

const load = (values: Record<string, string>) =>
  importWithEnv<CloudinaryConfig>('@config/cloudinary.js', { ...NONE, ...values });

// what node prints when the error stops the app at start, causes included
const printed = (err: unknown) => inspect(err, { depth: 10 });

describe('cloudinary config', () => {
  it('configures the sdk from the three separate settings, over https', async () => {
    const { cloudinary } = await load(SEPARATE);

    expect(cloudinary.config()).toMatchObject({
      cloud_name: 'shop-cloud',
      api_key: 'shop-key',
      api_secret: 'shop-secret-value',
      secure: true,
    });
  });

  it('ignores spaces around the settings', async () => {
    const { cloudinary } = await load({ ...SEPARATE, CLOUDINARY_CLOUD_NAME: '  shop-cloud  ' });

    expect(cloudinary.config().cloud_name).toBe('shop-cloud');
  });

  it('takes the credentials from CLOUDINARY_URL when it is set, over the separate ones', async () => {
    const { cloudinary } = await load({
      ...SEPARATE,
      CLOUDINARY_URL: 'cloudinary://url-key:url-secret-value@url-cloud',
    });

    expect(cloudinary.config()).toMatchObject({
      cloud_name: 'url-cloud',
      api_key: 'url-key',
      api_secret: 'url-secret-value',
      secure: true,
    });
  });

  it('decodes escaped characters in the url credentials', async () => {
    const { cloudinary } = await load({
      CLOUDINARY_URL: 'cloudinary://url-key:a%2Fb%40c@url-cloud',
    });

    expect(cloudinary.config().api_secret).toBe('a/b@c');
  });

  it.each([
    ['the cloud name', 'CLOUDINARY_CLOUD_NAME'],
    ['the api key', 'CLOUDINARY_API_KEY'],
    ['the api secret', 'CLOUDINARY_API_SECRET'],
  ])('refuses to start when %s is missing or blank', async (_case, key) => {
    for (const value of ['', '   ']) {
      const err = await rejectedBy(() => load({ ...SEPARATE, [key]: value }));

      expect(err).toMatchObject({ statusCode: 500, errorCode: 'CONFIG_INCOMPLETE' });
    }
  });

  it.each([
    ['has no api key', 'cloudinary://:url-secret-value@url-cloud'],
    ['has no api secret', 'cloudinary://url-key@url-cloud'],
    ['has no cloud name', 'cloudinary://url-key:url-secret-value@'],
    ['is not a cloudinary url', 'https://url-key:url-secret-value@url-cloud'],
  ])('refuses to start when CLOUDINARY_URL %s', async (_case, url) => {
    await expect(load({ CLOUDINARY_URL: url })).rejects.toBeDefined();
  });

  // the start error lands in the hosting logs, the secret must not go with it
  it.each([
    ['has no cloud name', 'cloudinary://url-key:url-secret-value@'],
    ['is not a cloudinary url', 'https://url-key:url-secret-value@url-cloud'],
    ['is not a url at all', 'cloudinary//url-key:url-secret-value@url-cloud'],
  ])('never prints the api secret when CLOUDINARY_URL %s', async (_case, url) => {
    const err = await rejectedBy(() => load({ CLOUDINARY_URL: url }));

    expect(printed(err)).not.toContain('url-secret-value');
  });

  // the shape tells which part is missing, the values stay out of the log
  it('keeps only the shape of a broken CLOUDINARY_URL in the error', async () => {
    const err = await rejectedBy(() =>
      load({ CLOUDINARY_URL: 'cloudinary://url-key:url-secret-value@' }),
    );

    expect(err).toMatchObject({ statusCode: 500, errorCode: 'CONFIG_INVALID' });
    expect((err as { cause?: { input?: unknown } }).cause?.input).toBe(
      'cloudinary://[hidden]:[hidden]@',
    );
    expect(printed(err)).not.toMatch(/url-key|url-secret-value/);
  });

  it('never prints the api secret when a separate setting is missing', async () => {
    const err = await rejectedBy(() => load({ ...SEPARATE, CLOUDINARY_CLOUD_NAME: '' }));

    expect(printed(err)).not.toContain('shop-secret-value');
  });
});
