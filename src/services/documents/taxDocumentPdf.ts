import path from 'node:path';

import PDFDocument from 'pdfkit';

import { t } from '@config/i18n.js';
import { taxDocumentNumberOf } from '@helpers/taxDocumentNumber.js';

// The PDF of an invoice or a credit note, drawn on request from the row the database keeps
// (docs/taxes.md): the document is its data, the PDF only its look, nothing is stored. In the
// language of the shop (an official document), the font of the repository (Noto Sans, OFL-1.1:
// Latin, Greek and Cyrillic), no logo, no stamp and no signature. A fiscal receipt the provider
// registered for the document puts its code at the top and its text under it.

const FONTS = path.join(process.cwd(), 'src', 'assets', 'fonts');

export type TaxDocumentLine = {
  kind: 'item' | 'delivery';
  name: string | null;
  quantity: number | null;
  unitNet: number | null;
  rate: number | null;
  net: number;
  tax: number;
  gross: number;
};

export type TaxDocumentForPdf = {
  kind: 'invoice' | 'credit_note';
  series: string;
  number: number;
  createdAt: Date;
  locale: string;
  currency: string;
  seller: Record<string, string | null>;
  buyer: Record<string, string | null>;
  lines: TaxDocumentLine[];
  totals: { rate: number | null; net: number; tax: number; gross: number }[];
  details: Record<string, unknown>;
  net: number;
  tax: number;
  gross: number;
  taxCountry: string | null;
  // the receipt the provider registered for the document, when there is one
  receipt: { code: string | null; text: string | null; url: string | null } | null;
};

const money = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`;
const rateOf = (rate: number | null, locale: string) =>
  rate === null ? t('taxDocument.noTax', locale) : `${rate}%`;

// the lines of an address, the parts that are there
const addressOf = (party: Record<string, string | null>) =>
  [
    party.address,
    [party.street, party.house].filter(Boolean).join(' '),
    party.apartment,
    [party.postalCode, party.city].filter(Boolean).join(' '),
    party.country,
  ]
    .filter((part) => part && String(part).trim())
    .join(', ');

export function renderTaxDocumentPdf(doc: TaxDocumentForPdf): Promise<Buffer> {
  const locale = doc.locale;
  const w = (key: string) => t(`taxDocument.${key}`, locale);
  const pdf = new PDFDocument({ size: 'A4', margin: 48 });
  pdf.registerFont('regular', path.join(FONTS, 'NotoSans-Regular.ttf'));
  pdf.registerFont('bold', path.join(FONTS, 'NotoSans-Bold.ttf'));

  const chunks: Buffer[] = [];
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });

  // the code of the fiscal receipt at the top, its text under it; a code that is no image the PDF
  // can draw is left out (the receipt keeps its number and its link)
  if (doc.receipt?.code) {
    try {
      pdf.image(Buffer.from(doc.receipt.code, 'base64'), pdf.page.width - 48 - 100, 40, {
        width: 100,
      });
    } catch {
      // the text and the link stay
    }
  }
  if (doc.receipt?.text) {
    pdf
      .font('regular')
      .fontSize(8)
      .text(doc.receipt.text, pdf.page.width - 48 - 140, 145, {
        width: 140,
        align: 'center',
      });
  }

  pdf.font('bold').fontSize(18).text(w(doc.kind), 48, 48);
  pdf.font('regular').fontSize(10);
  pdf.text(`${w('number')}: ${taxDocumentNumberOf(doc.series, doc.number)}`);
  pdf.text(`${w('issuedAt')}: ${doc.createdAt.toISOString().slice(0, 10)}`);
  if (typeof doc.details.soldAt === 'string') {
    pdf.text(`${w('soldAt')}: ${doc.details.soldAt.slice(0, 10)}`);
  }
  pdf.text(`${w('order')}: ${String(doc.details.orderId ?? '')}`);
  // the document it corrects: the invoice of a credit note, the credit note a reversing invoice
  // turns round
  const corrects =
    typeof doc.details.corrects === 'string'
      ? doc.details.corrects
      : doc.kind === 'credit_note' && typeof doc.details.invoice === 'string'
        ? doc.details.invoice
        : null;
  if (corrects) pdf.text(`${w('corrects')}: ${corrects}`);
  if (doc.taxCountry) pdf.text(`${w('taxedIn')}: ${doc.taxCountry}`);
  pdf.moveDown();

  // the seller and the buyer
  const top = pdf.y;
  pdf.font('bold').text(w('seller'), 48, top);
  pdf.font('regular').text(doc.seller.name ?? '', { width: 240 });
  pdf.text(addressOf(doc.seller), { width: 240 });
  if (doc.seller.taxNumber) {
    pdf.text(`${doc.seller.taxNumberLabel ?? ''} ${doc.seller.taxNumber}`.trim(), { width: 240 });
  }
  const sellerEnd = pdf.y;
  pdf.font('bold').text(w('buyer'), 310, top);
  pdf.font('regular').text(doc.buyer.name ?? '', 310, pdf.y, { width: 240 });
  pdf.text(addressOf(doc.buyer), 310, pdf.y, { width: 240 });
  pdf.y = Math.max(sellerEnd, pdf.y) + 16;

  // the lines
  const columns = [
    { key: 'item', x: 48, width: 170 },
    { key: 'quantity', x: 220, width: 40 },
    { key: 'unitNet', x: 262, width: 70 },
    { key: 'rate', x: 334, width: 50 },
    { key: 'net', x: 386, width: 60 },
    { key: 'tax', x: 448, width: 50 },
    { key: 'gross', x: 500, width: 50 },
  ];
  // a row that does not fit on the page goes on a new one, after the head of the table again
  const pageBottom = () => pdf.page.height - pdf.page.margins.bottom;
  const head = () =>
    row(
      columns.map((c) => w(c.key)),
      true,
    );
  const row = (cells: string[], bold = false): void => {
    pdf.font(bold ? 'bold' : 'regular').fontSize(8);
    const height = Math.max(
      ...cells.map((cell, i) => pdf.heightOfString(cell, { width: columns[i]!.width })),
    );
    if (!bold && pdf.y + height > pageBottom()) {
      pdf.addPage();
      pdf.y = pdf.page.margins.top;
      head();
      pdf.font('regular').fontSize(8);
    }
    const y = pdf.y;
    let bottom = y;
    cells.forEach((cell, i) => {
      pdf.text(cell, columns[i]!.x, y, { width: columns[i]!.width });
      bottom = Math.max(bottom, pdf.y);
    });
    pdf.y = bottom + 4;
  };
  head();
  for (const line of doc.lines) {
    row([
      line.kind === 'delivery' ? w('delivery') : (line.name ?? ''),
      line.quantity === null ? '' : String(line.quantity),
      line.unitNet === null ? '' : money(line.unitNet, doc.currency),
      rateOf(line.rate, locale),
      money(line.net, doc.currency),
      money(line.tax, doc.currency),
      money(line.gross, doc.currency),
    ]);
  }

  // the sums by rate and the totals
  pdf.moveDown();
  pdf.font('bold').fontSize(10).text(w('totals'), 48);
  for (const total of doc.totals) {
    pdf
      .font('regular')
      .fontSize(9)
      .text(
        `${rateOf(total.rate, locale)}: ${w('net')} ${money(total.net, doc.currency)}, ${w('tax')} ${money(total.tax, doc.currency)}, ${w('gross')} ${money(total.gross, doc.currency)}`,
      );
  }
  pdf.moveDown(0.5);
  pdf
    .font('regular')
    .fontSize(10)
    .text(`${w('totalNet')}: ${money(doc.net, doc.currency)}`);
  pdf.text(`${w('totalTax')}: ${money(doc.tax, doc.currency)}`);
  pdf.font('bold').text(`${w('totalGross')}: ${money(doc.gross, doc.currency)}`);

  // the reason of a sale without tax, and the text of the shop at the foot
  if (typeof doc.details.exemptionText === 'string') {
    pdf.moveDown().font('regular').fontSize(9).text(doc.details.exemptionText);
  }
  if (typeof doc.details.footer === 'string') {
    pdf.moveDown().font('regular').fontSize(8).text(doc.details.footer);
  }

  pdf.end();
  return done;
}
