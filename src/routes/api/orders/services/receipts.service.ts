import { taxDocumentNumberOf } from '@helpers/taxDocumentNumber.js';
import type { TaxDocumentLine } from '../../../../services/documents/taxDocumentPdf.js';
import type { FastifyBaseLogger } from 'fastify';

import { t } from '@config/i18n.js';
import { getPgMessage, tx } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { failureOf } from '@helpers/failureOf.js';
import {
  receiptProvider,
  RECEIPT_PROVIDER_REFUSED,
  RECEIPT_PROVIDER_UNAVAILABLE,
  type ReceiptAnswer,
  type ReceiptProvider,
  type ReceiptRequest,
  type ReceiptTaxRule,
} from '@providers/receipts/index.js';
import { AppError, ConflictError, NotFoundError } from '@utils/errors.js';

import { sendReceiptEmail } from './helpers/receiptMail.helper.js';
import { getOrderTaxDocuments } from './taxDocuments.service.js';

import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';
import type { OrderTaxDocumentsResponseDto } from 'types/dto/orders.dto.js';

// The fiscal receipts of the documents of the shop (docs/taxes.md): the database makes the row of a
// receipt with its invoice or credit note when the shop makes receipts (make_document_receipt,
// db/05); the worker of the receipts sends each one that waits to the provider of the app, the
// oldest first, a correction after the receipt it corrects was taken, and writes what the provider
// answered (record_receipt_result). A provider that does not answer leaves the receipt waiting for
// a later try, longer each time; a refusal leaves it to a person (the alert of the refused
// receipts), who registers it by hand and confirms it here. The buyer gets the mail of a receipt
// once it is registered.

type Log = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

const BATCH = 20;

// the waits after a try that failed, by the tries made: a minute, 5, 15, an hour, then 6 hours
const RETRY_MINUTES = [1, 5, 15, 60, 360];

// a receipt the provider took and registers later is asked again after a minute
const POLL_MS = 60_000;

const retryAt = (attempts: number, now: number) =>
  new Date(now + RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length - 1)]! * 60_000);

const receiptSelect = {
  id: true,
  kind: true,
  orderId: true,
  correctsId: true,
  locale: true,
  currency: true,
  lines: true,
  gross: true,
  taxRule: true,
  taxCountry: true,
  receiptNumber: true,
  receiptAttempts: true,
  document: { select: { series: true, number: true, correctsId: true, createdAt: true } },
} as const;

type WaitingReceipt = {
  id: number;
  kind: 'invoice' | 'credit_note' | 'receipt' | 'return_receipt';
  orderId: number;
  correctsId: number | null;
  locale: string;
  currency: string;
  lines: unknown;
  gross: { toString(): string };
  taxRule: ReceiptTaxRule | null;
  taxCountry: string | null;
  receiptNumber: string | null;
  receiptAttempts: number;
  document: {
    series: string | null;
    number: number | null;
    correctsId: number | null;
    createdAt: Date;
  } | null;
};

const keyOf = (document: { series: string | null; number: number | null }) =>
  taxDocumentNumberOf(document.series, document.number) ?? '';

// the key of the receipt of the sale a correction is of: up the receipts it corrects
async function saleKeyOf(correctsId: number): Promise<string | null> {
  return tx(async (db) => {
    await setAdminContext(db);
    let id: number | null = correctsId;
    for (let step = 0; id !== null && step < 4; step += 1) {
      const row: {
        correctsId: number | null;
        document: { series: string | null; number: number | null } | null;
      } | null = await db.taxDocument.findUnique({
        where: { id },
        select: { correctsId: true, document: { select: { series: true, number: true } } },
      });
      if (!row) return null;
      if (row.correctsId === null) return row.document ? keyOf(row.document) : null;
      id = row.correctsId;
    }
    return null;
  });
}

// the document of a receipt as the provider takes it
async function requestOf(receipt: WaitingReceipt): Promise<ReceiptRequest> {
  const document = receipt.document!;
  const kind =
    receipt.kind === 'return_receipt'
      ? 'return'
      : document.correctsId === null
        ? 'sale'
        : 'reversal';
  const lines = (receipt.lines as TaxDocumentLine[]).map((line) => ({
    name: line.name ?? t('taxDocument.delivery', receipt.locale),
    quantity: line.kind === 'item' && line.quantity !== null ? line.quantity : null,
    rate: line.rate === null ? null : Number(line.rate),
    net: Number(line.net),
    tax: Number(line.tax),
    gross: Number(line.gross),
  }));
  return {
    key: keyOf(document),
    kind,
    series: document.series!,
    number: document.number!,
    issuedAt: document.createdAt,
    currency: receipt.currency,
    taxRule: receipt.taxRule,
    taxCountry: receipt.taxCountry,
    lines,
    gross: Number(receipt.gross),
    correctsKey: kind === 'sale' ? null : await saleKeyOf(receipt.correctsId!),
  };
}

type Result = {
  state: 'pending' | 'registered' | 'refused';
  answer: ReceiptAnswer | null;
  error: string | null;
  nextAt: Date | null;
};

// what the provider answered, written; true when the receipt became registered with it
async function record(receiptId: number, provider: ReceiptProvider, result: Result) {
  return tx(async (db) => {
    await setAdminContext(db);
    const [row] = await db.$queryRaw<{ registered: boolean }[]>`
      select cartlify.record_receipt_result(
        ${receiptId}::int, ${provider.name}::text, ${result.state}::text,
        ${result.answer?.number ?? null}::text, ${result.answer?.url ?? null}::text,
        ${result.answer?.code ?? null}::text, ${result.answer?.text ?? null}::text,
        ${result.error}::text, ${result.nextAt}::timestamp
      ) as registered`;
    return row?.registered === true;
  });
}

const errorText = (err: AppError) =>
  JSON.stringify({ code: err.errorCode, ...(err.details ? { details: err.details } : {}) }).slice(
    0,
    500,
  );

// one receipt sent (or asked about, once the provider took it); false when the provider does not
// answer (the sweep ends, the rest waits for the next one)
async function sendOne(
  receipt: WaitingReceipt,
  provider: ReceiptProvider,
  log: Log,
): Promise<boolean> {
  const now = Date.now();
  let result: Result;
  let answered = true;
  try {
    const request = await requestOf(receipt);
    const answer = receipt.receiptNumber
      ? await provider.status(request)
      : await provider.issue(request);
    result = {
      state: answer.state,
      answer,
      error: null,
      nextAt: answer.state === 'pending' ? new Date(now + POLL_MS) : null,
    };
  } catch (err) {
    if (err instanceof AppError && err.errorCode === RECEIPT_PROVIDER_REFUSED) {
      log.warn(
        { documentId: receipt.id, orderId: receipt.orderId, details: err.details },
        'the receipt provider refused a receipt',
      );
      result = { state: 'refused', answer: null, error: errorText(err), nextAt: null };
    } else if (err instanceof AppError && err.errorCode === RECEIPT_PROVIDER_UNAVAILABLE) {
      log.warn(
        { ...failureOf(err), documentId: receipt.id },
        'the receipt provider did not answer',
      );
      answered = false;
      result = {
        state: 'pending',
        answer: null,
        error: errorText(err),
        nextAt: retryAt(receipt.receiptAttempts, now),
      };
    } else {
      log.error({ err, documentId: receipt.id }, 'a receipt was not sent');
      result = {
        state: 'pending',
        answer: null,
        error: 'ERROR',
        nextAt: retryAt(receipt.receiptAttempts, now),
      };
    }
  }

  if (await record(receipt.id, provider, result)) {
    await sendReceiptEmail(
      {
        orderId: receipt.orderId,
        kind: receipt.kind === 'return_receipt' ? 'return' : 'sale',
        number: result.answer?.number ?? null,
        url: result.answer?.url ?? null,
        text: result.answer?.text ?? null,
        gross: Number(receipt.gross),
        currency: receipt.currency,
      },
      log,
    );
  }
  return answered;
}

// the sweep of the worker: every receipt whose try is due, the oldest first, a batch after another;
// a correction waits until the receipt it corrects is registered at the tax authority (or made by
// hand): one taken by the provider may still be refused.
// A provider that does not answer ends the sweep. How many receipts it sent. A test keeps it to its
// own orders, may give the provider, and asks as of a later moment (the next try of a receipt is due)
export async function issuePendingReceipts(
  log: Log,
  opts: { orderIds?: number[]; provider?: ReceiptProvider; batch?: number; dueBy?: Date } = {},
): Promise<number> {
  const provider = opts.provider ?? receiptProvider;
  if (!provider.makesReceipts() || !provider.isConfigured()) return 0;

  const batch = opts.batch ?? BATCH;
  let sent = 0;
  let after = 0;

  for (;;) {
    const from = after;
    const due = (await tx(async (db) => {
      await setAdminContext(db);
      return db.taxDocument.findMany({
        where: {
          id: { gt: from },
          kind: { in: ['receipt', 'return_receipt'] },
          receiptState: 'pending',
          receiptNextAt: { lte: opts.dueBy ?? new Date() },
          ...(opts.orderIds === undefined ? {} : { orderId: { in: opts.orderIds } }),
          OR: [
            { correctsId: null },
            { corrects: { receiptState: { in: ['registered', 'manual'] } } },
          ],
        },
        orderBy: { id: 'asc' },
        take: batch,
        select: receiptSelect,
      });
    })) as WaitingReceipt[];

    for (const receipt of due) {
      if (!(await sendOne(receipt, provider, log))) return sent;
      sent += 1;
    }

    if (due.length < batch) return sent;
    after = due[due.length - 1]!.id;
  }
}

// POST /api/orders/:orderId/documents/:documentId/receipt-confirmation: an admin registered the
// receipt by hand at the fiscal service (the provider refused it, or did not answer for long) and
// gives the number it got there; the receipt is not sent any more
export async function confirmReceiptByHand(args: {
  actorId: UserId;
  actorRole: Role;
  orderId: number;
  documentId: number;
  number: string;
  url: string | null;
}): Promise<OrderTaxDocumentsResponseDto> {
  await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    const receipt = await db.taxDocument.findFirst({
      where: {
        id: args.documentId,
        orderId: args.orderId,
        kind: { in: ['receipt', 'return_receipt'] },
      },
      select: { receiptState: true },
    });
    if (!receipt) throw new NotFoundError('TAX_DOCUMENT_NOT_FOUND');
    try {
      await db.$queryRaw`select 1 as done from cartlify.confirm_receipt_manual(
        ${args.documentId}::int, ${receiptProvider.name}::text, ${args.number}::text,
        ${args.url}::text
      ) as r`;
    } catch (err) {
      // registered meanwhile, or another admin confirmed it
      if (getPgMessage(err) === 'RECEIPT_STATE_INVALID') {
        throw new ConflictError('RECEIPT_STATE_INVALID', { state: receipt.receiptState });
      }
      throw err;
    }
    await writeAdminAuditLog(db, {
      actorId: args.actorId,
      actorRole: args.actorRole,
      entityType: 'order',
      entityId: args.orderId,
      action: 'OTHER',
      event: 'order.receipt_confirm',
      changes: [
        { field: 'receipt', old: receipt.receiptState, new: 'manual' },
        { field: 'receiptNumber', old: null, new: args.number },
      ],
    });
  });

  return getOrderTaxDocuments({
    actorId: args.actorId,
    actorRole: args.actorRole,
    orderId: args.orderId,
  });
}
