import { getPgMessage } from '@db/client.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type AppError,
} from '@utils/errors.js';

// what the database functions of the statements of return say (db/05) as the answers of the app: a
// code of theirs is the code of the answer, the status goes by what the refusal is about. Any
// other error is left as it is

const NOT_FOUND = new Set([
  'RETURN_NOT_FOUND',
  'RETURN_ORDER_NOT_FOUND',
  'RETURN_ITEM_NOT_FOUND',
  'RETURN_SHIPMENT_NOT_FOUND',
]);

const CONFLICT = new Set([
  'RETURN_ORDER_NOT_RETURNABLE',
  'RETURN_QUANTITY_EXCEEDED',
  'RETURN_ITEM_NOT_RETURNABLE',
  'RETURN_PERIOD_OVER',
  'RETURN_ITEM_NOT_EXPECTED',
  'RETURN_PROOF_REQUIRED',
  'RETURN_PROOF_ALREADY_CONFIRMED',
  'RETURN_ITEM_MONEY_SETTLED',
  'RETURN_ALLOCATIONS_MISSING',
  'RETURN_ITEM_NOT_REFUNDABLE',
  'RETURN_REFUND_EXCEEDS_PAID',
  'RETURN_REFUND_DISPUTED',
  'RETURN_HAND_REFUND_PENDING',
  'RETURN_BANK_MONEY_PENDING',
  'RETURN_ITEM_NOT_CLOSABLE',
  'RETURN_ALREADY_CLOSED',
  'RETURN_NOTHING_WAITING',
  'RETURN_DEDUCTION_NOT_ALLOWED',
  'RETURN_DEDUCTION_EXCEEDS_COST',
  'RETURN_MANUAL_UNDER_REVIEW',
  'RETURN_NOT_MANUAL',
  'RETURN_ALREADY_ACCEPTED',
  'RETURN_NOT_ACCEPTED',
  'RETURN_SHIPMENT_EXISTS',
  'RETURN_PARCEL_EXISTS',
  'RETURN_PARCEL_REQUIRED',
  'RETURN_NOTHING_TO_SEND_BACK',
  'RETURN_SPLIT_INVALID',
  'RETURN_NOTHING_OWED',
  'RETURN_KEEP_NOT_ALLOWED',
  'RETURN_WAY_BACK_PAID',
]);

const BAD_REQUEST = new Set([
  'RETURN_PARCEL_SUM_REQUIRED',
  'RETURN_PARCEL_SUM_INVALID',
  'RETURN_ITEMS_REQUIRED',
  'RETURN_ITEMS_INVALID',
  'RETURN_ITEMS_REPEATED',
  'RETURN_QUANTITY_INVALID',
  'RETURN_EXTENDS_INVALID',
  'RETURN_STATED_AT_INVALID',
  'RETURN_CONTACT_REQUIRED',
  'RETURN_GOODS_INVALID',
  'RETURN_NOT_ACCEPTED_REASON_REQUIRED',
  'RETURN_AMOUNT_INVALID',
  'RETURN_DEDUCTION_INVALID',
  'RETURN_OUTSIDE_METHOD_INVALID',
  'RETURN_AMOUNT_NOTE_REQUIRED',
  'RETURN_REFUND_AMOUNT_INVALID',
  'RETURN_OUTSIDE_NOTE_REQUIRED',
  'RETURN_OUTSIDE_AT_INVALID',
  'RETURN_CLOSE_NOTE_REQUIRED',
  'RETURN_REASON_INVALID',
  'RETURN_PROOF_INVALID',
  'RETURN_SHIPMENT_TIME_INVALID',
  'RETURN_KEEP_INVALID',
]);

// the answer for an error of the database functions of the statements, or the error itself
export function returnErrorOf(err: unknown): unknown {
  const code = String(getPgMessage(err) ?? '');

  if (NOT_FOUND.has(code)) return new NotFoundError(code);
  if (CONFLICT.has(code)) return new ConflictError(code);
  if (BAD_REQUEST.has(code)) return new BadRequestError(code);
  if (code === 'RETURN_FORBIDDEN') return new ForbiddenError(code);

  return err;
}

// true for an app error the helper made
export const isReturnError = (err: unknown): err is AppError =>
  err instanceof Error && 'errorCode' in err;
