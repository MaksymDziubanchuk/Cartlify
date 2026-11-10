import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';

import { buildReturnRefundedTemplate } from '@services/email/templates/returns/returnRefunded.template.js';
import { buildVerifyEmailTemplate } from '@services/email/templates/auth/verifyEmail.template.js';

import { resetShopSettings, setShopSettings } from '../../../../helpers/shopSettings.js';

// A mail names the shop it comes from. The name is the one root gives the shop (shopName of the shop
// settings): a template that is not given a name takes that one, never a name of its own, so a shop
// that is renamed is renamed in every mail at once

const TEMPLATES = path.join(process.cwd(), 'src', 'services', 'email', 'templates');

const templatesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? templatesUnder(path.join(dir, entry.name))
      : entry.name.endsWith('.template.ts')
        ? [path.join(dir, entry.name)]
        : [],
  );

const relative = (file: string) => path.relative(TEMPLATES, file).replaceAll('\\', '/');

describe('the name of the shop in the mails', () => {
  afterEach(() => resetShopSettings());

  it('is never a fixed name in a template', () => {
    const fixed = templatesUnder(TEMPLATES)
      .filter((file) => /appName\?\.trim\(\)\s*\|\|\s*['"`]/.test(readFileSync(file, 'utf8')))
      .map(relative);

    expect(fixed).toEqual([]);
  });

  it('is the one of the shop settings when a template is given none', () => {
    setShopSettings({ shopName: 'Northwind' });

    const money = buildReturnRefundedTemplate({
      orderId: 42,
      orderUrl: 'https://shop.example.com/orders/42',
      items: [{ name: 'Desk lamp', quantity: 1 }],
      amount: '10',
      currency: 'eur',
      supportEmail: 'support@shop.example.com',
    });
    const verify = buildVerifyEmailTemplate({ verifyUrl: 'https://shop.example.com/verify' });

    expect(money.subject).toBe('Northwind — Money sent for order #42');
    expect(verify.subject).toBe('Northwind — Verify your email');
  });
});
