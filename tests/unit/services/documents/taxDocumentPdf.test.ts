import { describe, expect, it } from '@jest/globals';

import {
  renderTaxDocumentPdf,
  type TaxDocumentForPdf,
} from '../../../../src/services/documents/taxDocumentPdf.js';

// The PDF of an invoice or a credit note (docs/taxes.md): a table of many lines goes on as many
// pages as it needs, each with the head of the table; a code of a receipt that is no picture is
// left out, not a failure

const doc = (lines: number, set: Partial<TaxDocumentForPdf> = {}): TaxDocumentForPdf => ({
  kind: 'invoice',
  series: 'F/2026',
  number: 7,
  createdAt: new Date('2026-11-22T10:00:00Z'),
  locale: 'en',
  currency: 'EUR',
  seller: { name: 'Cartlify S.L.', address: 'Calle Mayor 1, Madrid', taxNumber: 'B12345674' },
  buyer: { name: 'Anna Koval', country: 'ES', city: 'Madrid', street: 'Gran Via', house: '1' },
  lines: Array.from({ length: lines }, (_, i) => ({
    kind: 'item' as const,
    name: `Socks of wool, the pair number ${i + 1} of a long name that goes on two lines`,
    quantity: 2,
    unitNet: 8.33,
    rate: 20,
    net: 16.67,
    tax: 3.33,
    gross: 20,
  })),
  totals: [{ rate: 20, net: 16.67 * lines, tax: 3.33 * lines, gross: 20 * lines }],
  details: { orderId: 42 },
  net: 16.67 * lines,
  tax: 3.33 * lines,
  gross: 20 * lines,
  taxCountry: 'ES',
  receipt: null,
  ...set,
});

const pagesOf = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('renderTaxDocumentPdf', () => {
  it('draws a table of many lines on the pages it needs, not a page a cell', async () => {
    const few = await renderTaxDocumentPdf(doc(3));
    const many = await renderTaxDocumentPdf(doc(120));

    expect(pagesOf(few)).toBe(1);
    // 120 lines of two rows of text each: a handful of pages
    expect(pagesOf(many)).toBeGreaterThan(1);
    expect(pagesOf(many)).toBeLessThanOrEqual(8);
  });

  it('leaves out a code of a receipt that is no picture', async () => {
    const pdf = await renderTaxDocumentPdf(
      doc(1, { receipt: { code: 'PHN2Zz48L3N2Zz4=', text: 'QR tributario:', url: null } }),
    );

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
