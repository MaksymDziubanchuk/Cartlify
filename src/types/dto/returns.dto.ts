import type {
  ReturnBasis,
  ReturnCloseCode,
  ReturnGoods,
  ReturnMoney,
  ReturnNotAcceptedReason,
  ReturnOutsideMethod,
  ReturnReason,
  ReturnRefundFailure,
  ReturnSource,
  ReturnStatus,
} from '@prisma/client';

import type { FastifyBaseLogger } from 'fastify';

import type { UserId } from '../ids.js';
import type { Role } from '../user.js';

// RETURNS: the statements of withdrawal and of return an admin makes and settles

// a person the card names: the account of a buyer or of an admin
export interface ReturnPersonDto {
  id: number;
  name: string | null;
  email: string;
}

// a row of a statement: a part of an item of the order with its own units, the state of its goods
// and of its money
export interface ReturnItemDto {
  id: number;
  orderItemId: number;
  productId: number;
  variantId: number;
  // the name the item went by when the order was confirmed
  name: string;
  quantity: number;
  goods: ReturnGoods;
  notAcceptedReason: ReturnNotAcceptedReason | null;
  money: ReturnMoney;
  // what the units cost the buyer, lowered by root when the note says why
  amount: number;
  amountNote: string | null;
  // the part of the delivery that goes back with this row, 0 for all but the row that makes the
  // order whole
  deliveryShare: number;
  // the cost of the way back the buyer owes, taken off the transfer of this row
  shippingDeduction: number;
  goodsSetAt: string | null;
  goodsSetBy: ReturnPersonDto | null;
  // the transfer: the id the provider gave and the day the money went back
  refundId: string | null;
  refundedAt: string | null;
  // why the last transfer failed, in our code and in the words of the provider; until it is tried again
  refundFailure: { code: ReturnRefundFailure; text: string | null } | null;
  // money root sent outside the app
  outside: { method: ReturnOutsideMethod; note: string; by: ReturnPersonDto | null } | null;
  // why root closed the row without a refund
  refusedCode: ReturnCloseCode | null;
}

export interface ReturnDto {
  id: number;
  // the code the buyer sees in the mails: W42-2 or R42-2
  code: string;
  orderId: number;
  // the statement this one extends
  extendsId: number | null;
  // the moment the statement states (the law counts its period from it)
  statedAt: string;
  source: ReturnSource;
  basis: ReturnBasis;
  reason: ReturnReason | null;
  description: string | null;
  // where the answers go
  contact: { name: string; email: string };
  // the account that made it, none for a form
  createdBy: ReturnPersonDto | null;
  ip: string | null;
  userAgent: string | null;
  proof: {
    providedAt: string | null;
    // what the buyer wrote of the parcel, none until they did
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    confirmedAt: string | null;
    confirmedBy: ReturnPersonDto | null;
  };
  // a statement of the form without the code: when an admin accepted it as the buyer's, and who;
  // until then its goods and its money wait
  acceptedAt: string | null;
  acceptedBy: ReturnPersonDto | null;
  closedAt: string | null;
  closedBy: ReturnPersonDto | null;
  // the code and the note of the last time root closed rows without a refund
  closeCode: ReturnCloseCode | null;
  closeNote: string | null;
  // the cost of the way back root paid back to the buyer outside the app, none until then
  shippingReimbursement: {
    amount: number;
    at: string;
    method: ReturnOutsideMethod;
    note: string;
    by: ReturnPersonDto | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  order: {
    id: number;
    status: string;
    returnStatus: ReturnStatus;
    // the account of the order: a deleted one has no email
    buyer: { id: number; name: string | null; email: string | null; deleted: boolean } | null;
    // to whom and where the order went, as the buyer wrote it at the confirmation
    recipient: {
      method: string;
      firstName: string;
      lastName: string;
      phone: string;
      country: string | null;
      postalCode: string | null;
      city: string | null;
      street: string | null;
      house: string | null;
      apartment: string | null;
      note: string | null;
    } | null;
  };
  // what was done with the statement, the lines of the journal of the admins that name it, oldest
  // first
  history: Array<{
    id: number;
    createdAt: string;
    event: string;
    actorRole: string | null;
    actor: ReturnPersonDto | null;
    changes: unknown[];
  }>;
  items: ReturnItemDto[];
  // the parcels the shop paid to carry the goods back, in the order they were recorded
  shipments: ReturnShipmentDto[];
  // the most the next transfer may still take off for the way back, 0 when it may take none: a
  // withdrawal whose contract says the buyer pays, with rows that wait for their money, the cost of
  // its parcels less what the transfers sent took for them. A hint, the admin decides
  deductible: number;
  // what the admin should see before acting on the statement
  warnings: ReturnWarning[];
}

// shop_paid_parcel: the shop paid a parcel of the statement back, a reimbursement of the way back to
// the buyer would pay for it twice (still allowed: the buyer may have sent two parcels)
export type ReturnWarning = 'shop_paid_parcel';

// a parcel the shop paid to carry goods back from the buyer (an expense of the period it was sent in)
export interface ReturnShipmentDto {
  id: number;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  // what the shop paid, none until an admin writes it
  cost: number | null;
  // when the parcel was sent back, or refused (the time the admin gave)
  shippedAt: string;
  recordedBy: ReturnPersonDto | null;
  createdAt: string;
}

// a statement as the list of an order names it, for an admin
export interface ReturnSummaryDto {
  id: number;
  code: string;
  statedAt: string;
  source: ReturnSource;
  basis: ReturnBasis;
  reason: ReturnReason | null;
  extendsId: number | null;
  closedAt: string | null;
}

// for an admin, what the statements of an order did to one of its items: the units bought, the units
// whose money went back, was refused or is not settled yet, the units the shop has back (on the
// shelf, written off or lost on the way back: they are not to be sent) and the units left to send
export interface ReturnItemUnitsDto {
  orderItemId: number;
  quantity: number;
  refunded: number;
  refused: number;
  waiting: number;
  withShop: number;
  toShip: number;
}

// for an admin, the statements of an order in sum: each item they touched, the money that went back
// (the delivery too) and what the order is worth after it
export interface OrderReturnUnitsDto {
  items: ReturnItemUnitsDto[];
  refundedTotal: number;
  netTotal: number;
}

// where a statement stands for the buyer: received, the proof of the parcel given, the proof
// confirmed, closed
export type BuyerReturnStep = 'received' | 'proof_provided' | 'proof_confirmed' | 'closed';

// a statement as the buyer sees it in their order: the path of it and the money of each row, never
// what became of the goods, who handled it, or the words of the shop
export interface BuyerReturnDto {
  id: number;
  // the code of the statement in the mails: W42-2 or R42-2
  code: string;
  statedAt: string;
  source: ReturnSource;
  basis: ReturnBasis;
  reason: ReturnReason | null;
  step: BuyerReturnStep;
  closedAt: string | null;
  // what the buyer wrote of the parcel they sent back, none until they did
  proof: {
    carrier: string;
    trackingNumber: string;
    trackingUrl: string | null;
    providedAt: string;
    confirmed: boolean;
  } | null;
  // what the shop paid back for sending the goods back, outside the app
  shippingReimbursement: { amount: number; at: string; method: ReturnOutsideMethod } | null;
  items: Array<{
    orderItemId: number;
    quantity: number;
    // what the units cost, the part of the delivery that goes back with them and the cost of the
    // way back taken off
    amount: number;
    deliveryAmount: number;
    shippingDeduction: number;
    money: ReturnMoney;
    refundedAt: string | null;
    // why the money of the units was refused: the shop did not accept the goods (the reason) or
    // they never came
    refusal: ReturnNotAcceptedReason | 'not_arrived' | null;
  }>;
}

// the units of an item that can still be stated
export interface WithdrawableDto {
  orderItemId: number;
  quantity: number;
}

// POST /api/returns
export interface CreateReturnBodyDto {
  orderId: number;
  items: Array<{ orderItemId: number; quantity: number }>;
  basis: ReturnBasis;
  // required for a statement outside the withdrawal, given by an admin
  reason?: ReturnReason;
  description?: string;
  // a moment of the past: when a parcel was refused at the door
  statedAt?: string;
  extendsId?: number;
}

export interface CreateReturnDto extends CreateReturnBodyDto {
  actorId: UserId;
  actorRole: Role;
  log: FastifyBaseLogger;
}

export interface ReturnParamsDto {
  returnId: number | string;
}

export interface GetReturnDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
}

// POST /api/returns/:returnId/receive
export interface ReceiveReturnItemsBodyDto {
  results: Array<{
    itemId: number;
    quantity: number;
    goods: Exclude<ReturnGoods, 'expected'>;
    notAcceptedReason?: ReturnNotAcceptedReason;
  }>;
}

export interface ReceiveReturnItemsDto extends ReceiveReturnItemsBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
  log: FastifyBaseLogger;
}

export interface ConfirmReturnProofDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
}

// POST /api/returns/:returnId/accept
export interface AcceptReturnDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
}

// POST /api/returns/:returnId/refund
export interface RefundReturnBodyDto {
  // the rows to refund, all that can be when none are named
  itemIds?: number[];
  // root lowers what a row refunds
  reductions?: Array<{ itemId: number; amount: number; note?: string }>;
  // the cost of the way back the buyer owes, taken off this transfer
  returnShippingDeduction?: number;
}

export interface RefundReturnDto extends RefundReturnBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
  log: FastifyBaseLogger;
}

// POST /api/returns/:returnId/refund/outside
export interface RefundReturnOutsideBodyDto {
  itemIds?: number[];
  method: ReturnOutsideMethod;
  note: string;
  // the day the money really went, never before the order was paid or of the future
  at: string;
}

export interface RefundReturnOutsideDto extends RefundReturnOutsideBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
  log: FastifyBaseLogger;
}

// POST /api/returns/:returnId/dispute: the end of a dispute of the payment at the bank
export interface SettleReturnDisputeBodyDto {
  outcome: 'won' | 'lost';
  note: string;
  // with lost: the day the dispute closed
  at?: string;
}

export interface SettleReturnDisputeDto extends SettleReturnDisputeBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
}

// POST /api/returns/:returnId/reimbursement: the shop paid the buyer back the cost of the way back
export interface RecordReturnReimbursementBodyDto {
  amount: number;
  method: ReturnOutsideMethod;
  note: string;
  // the day the money really went, never before the statement or of the future
  at: string;
}

export interface RecordReturnReimbursementDto extends RecordReturnReimbursementBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
  log: FastifyBaseLogger;
}

// POST /api/returns/:returnId/close
export interface CloseReturnBodyDto {
  itemIds?: number[];
  code: ReturnCloseCode;
  note: string;
}

export interface CloseReturnDto extends CloseReturnBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
  log: FastifyBaseLogger;
}

// POST /api/returns/:returnId/shipments
export interface RecordReturnShipmentBodyDto {
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  cost?: number;
  // when the parcel was sent back, or the moment it was refused: never of the future, never before
  // the order was paid
  shippedAt: string;
}

export interface RecordReturnShipmentDto extends RecordReturnShipmentBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
}

// PATCH /api/returns/:returnId/shipments/:shipmentId
export interface ReturnShipmentParamsDto {
  returnId: number | string;
  shipmentId: number | string;
}

export interface SetReturnShipmentCostBodyDto {
  cost: number;
}

export interface SetReturnShipmentCostDto extends SetReturnShipmentCostBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
  shipmentId: number;
}

// GET /api/returns
export type ReturnsSortBy = 'statedAt' | 'closedAt' | 'updatedAt' | 'amount' | 'moneyDeadline';
export type ReturnsSortDir = 'asc' | 'desc';

export interface GetReturnsQueryDto {
  state?: 'open' | 'closed';
  goods?: 'waiting' | 'waiting_no_proof' | 'proof_provided' | 'received';
  money?: 'not_refunded' | 'pending' | 'failed' | 'refunded' | 'refused';
  source?: ReturnSource;
  basis?: ReturnBasis;
  reason?: ReturnReason;
  orderId?: number;
  userId?: number;
  productId?: number;
  variantId?: number;
  q?: string;
  statedFrom?: string;
  statedTo?: string;
  closedFrom?: string;
  closedTo?: string;
  refundedFrom?: string;
  refundedTo?: string;
  olderThanDays?: number;
  moneyDueForDays?: number;
  paidAheadForDays?: number;
  proofOlderThanDays?: number;
  accepted?: boolean;
  moneyOverdue?: boolean;
  moneyDueWithinDays?: number;
  extended?: boolean;
  sortBy?: ReturnsSortBy;
  sortDir?: ReturnsSortDir;
  limit?: number;
  cursor?: string;
  format?: 'json' | 'csv';
}

// a statement as a line of the list of an admin
export interface ReturnListItemDto {
  id: number;
  code: string;
  orderId: number;
  order: { status: string; returnStatus: ReturnStatus };
  // the buyer of the order: whether their account still lives
  buyer: { id: number; alive: boolean };
  contact: { name: string; email: string };
  statedAt: string;
  // whole days since the statement
  daysSince: number;
  source: ReturnSource;
  basis: ReturnBasis;
  reason: ReturnReason | null;
  extendsId: number | null;
  closedAt: string | null;
  updatedAt: string;
  proof: { providedAt: string | null; confirmedAt: string | null };
  // a statement of the form without the code: when an admin accepted it
  acceptedAt: string | null;
  // the units of all the rows, and the money of them
  units: number;
  amount: number;
  refundedAmount: number;
  // the units by what became of the goods
  goods: { expected: number; received: number; declined: number };
  // the units by the state of the money; failed: a row's last transfer failed
  money: {
    notRefunded: number;
    pending: number;
    refunded: number;
    refused: number;
    failed: boolean;
  };
}

export interface GetReturnsResponseDto {
  items: ReturnListItemDto[];
  // of the filter, not only of the page
  total: number;
  limit: number;
  nextCursor: string | null;
}
