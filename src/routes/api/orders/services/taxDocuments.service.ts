import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  renderTaxDocumentPdf,
  type TaxDocumentForPdf,
  type TaxDocumentLine,
} from '../../../../services/documents/taxDocumentPdf.js';
import { taxDocumentFileNameOf, taxDocumentNumberOf } from '@helpers/taxDocumentNumber.js';
import { NotFoundError } from '@utils/errors.js';

import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';
import type { OrderTaxDocumentDto, OrderTaxDocumentsResponseDto } from 'types/dto/orders.dto.js';

// The tax documents of an order (docs/taxes.md): the invoices and credit notes the database made,
// and the fiscal receipts registered for them, for the buyer of the order (the policy shows a buyer
// the documents of their own orders only) and for an admin; the PDF of a document is drawn on
// request from the row.

const documentSelect = {
  id: true,
  kind: true,
  series: true,
  number: true,
  correctsId: true,
  documentId: true,
  locale: true,
  currency: true,
  seller: true,
  buyer: true,
  lines: true,
  totals: true,
  details: true,
  net: true,
  tax: true,
  gross: true,
  taxCountry: true,
  taxRule: true,
  provider: true,
  receiptState: true,
  receiptNumber: true,
  receiptUrl: true,
  receiptCode: true,
  receiptText: true,
  receiptError: true,
  createdAt: true,
} satisfies Prisma.TaxDocumentSelect;

type DocumentRow = Prisma.TaxDocumentGetPayload<{ select: typeof documentSelect }>;

// the last error of the provider is the shop's: an admin reads it, the buyer does not
const dtoOf = (row: DocumentRow, staff: boolean): OrderTaxDocumentDto => ({
  id: row.id,
  kind: row.kind,
  number: taxDocumentNumberOf(row.series, row.number),
  correctsId: row.correctsId,
  documentId: row.documentId,
  net: Number(row.net),
  tax: Number(row.tax),
  gross: Number(row.gross),
  currency: row.currency,
  createdAt: row.createdAt.toISOString(),
  receipt:
    row.kind === 'receipt' || row.kind === 'return_receipt'
      ? {
          provider: row.provider,
          state: row.receiptState!,
          number: row.receiptNumber,
          url: row.receiptUrl,
          text: row.receiptText,
          error: staff ? row.receiptError : null,
        }
      : null,
});

async function rowsOf(actorId: UserId, actorRole: Role, orderId: number): Promise<DocumentRow[]> {
  return tx(async (db) => {
    await setUserContext(db, { userId: actorId, role: actorRole });
    const order = await db.order.findUnique({ where: { id: orderId }, select: { id: true } });
    if (!order) throw new NotFoundError('ORDER_NOT_FOUND');
    return db.taxDocument.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: documentSelect,
    });
  });
}

export async function getOrderTaxDocuments(args: {
  actorId: UserId;
  actorRole: Role;
  orderId: number;
}): Promise<OrderTaxDocumentsResponseDto> {
  const rows = await rowsOf(args.actorId, args.actorRole, args.orderId);
  const staff = args.actorRole === 'ADMIN' || args.actorRole === 'ROOT';
  return { items: rows.map((row) => dtoOf(row, staff)) };
}

// the PDF of an invoice or a credit note of the order; a receipt has none of ours (its provider
// keeps it, at its link)
export async function getOrderTaxDocumentPdf(args: {
  actorId: UserId;
  actorRole: Role;
  orderId: number;
  documentId: number;
}): Promise<{ pdf: Buffer; fileName: string }> {
  const rows = await rowsOf(args.actorId, args.actorRole, args.orderId);
  const row = rows.find((r) => r.id === args.documentId);
  if (!row || (row.kind !== 'invoice' && row.kind !== 'credit_note')) {
    throw new NotFoundError('TAX_DOCUMENT_NOT_FOUND');
  }

  const receipt = rows.find(
    (r) =>
      r.documentId === row.id &&
      r.receiptState &&
      ['registered', 'manual'].includes(r.receiptState),
  );

  const doc: TaxDocumentForPdf = {
    kind: row.kind,
    series: row.series!,
    number: row.number!,
    createdAt: row.createdAt,
    locale: row.locale,
    currency: row.currency,
    seller: row.seller as Record<string, string | null>,
    buyer: row.buyer as Record<string, string | null>,
    lines: row.lines as unknown as TaxDocumentLine[],
    totals: row.totals as unknown as TaxDocumentForPdf['totals'],
    details: row.details as Record<string, unknown>,
    net: Number(row.net),
    tax: Number(row.tax),
    gross: Number(row.gross),
    taxCountry: row.taxCountry,
    receipt: receipt
      ? { code: receipt.receiptCode, text: receipt.receiptText, url: receipt.receiptUrl }
      : null,
  };

  return {
    pdf: await renderTaxDocumentPdf(doc),
    fileName: taxDocumentFileNameOf(row.series, row.number),
  };
}
