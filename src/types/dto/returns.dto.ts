import type {
  MoneyPart,
  MoneyPurpose,
  OutsideMethod,
  RefundFailure,
  ReturnBasis,
  ReturnCloseCode,
  ReturnGoods,
  ReturnMoney,
  ReturnNotAcceptedReason,
  ReturnReason,
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
  // what the buyer has had of it: the transfers sent or on their way and the money sent outside the
  // app (a row is paid in parts when the payment held only some of it: "paid X of Y")
  paid: number;
  amountNote: string | null;
  goodsSetAt: string | null;
  goodsSetBy: ReturnPersonDto | null;
  // the line of the money journal that put the money of the row where it is (one of the money of
  // the card)
  moneyLogId: number | null;
  // why the last transfer failed (money failed), in our code and in the words of the provider
  refundFailure: { code: RefundFailure; text: string | null } | null;
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
  // the statement this one was split from (its units went back in a parcel of their own), and the
  // statements split from this one
  splitFromId: number | null;
  splitIds: number[];
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
  // a statement of the form without the code: when an admin accepted it as the buyer's, and who;
  // until then its goods and its money wait
  acceptedAt: string | null;
  acceptedBy: ReturnPersonDto | null;
  closedAt: string | null;
  closedBy: ReturnPersonDto | null;
  // the code and the note of the last time root closed rows without a refund
  closeCode: ReturnCloseCode | null;
  closeNote: string | null;
  // how much went back to the buyer by the statement in all, counted by the database
  refundedTotal: number;
  // a dispute of the payment is open at the bank; a refund made by hand waits for root
  disputeOpen: boolean;
  handRefundPending: boolean;
  // what a bank took for a dispute lost on an order sent waits for root
  bankMoneyPending: boolean;
  // what the statement still owes, what money already with the buyer covers, what the provider can
  // still give back; short: a transfer would ask the provider for more, or the way back is owed alone
  // (both go outside the app)
  moneyLeft: {
    rows: number;
    delivery: number;
    wayBack: number;
    total: number;
    due: number;
    covered: number;
    paymentLeft: number;
    short: boolean;
  };
  // what money already with the buyer gave the goods of the order more than its statements took
  moneyOverpaid: number;
  // the movements of the money of the statement, the lines of the money journal, oldest first
  money: ReturnMoneyMoveDto[];
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
  // the parcels of the statement in the order they were recorded: the goods on their way back to the
  // shop (one a statement), the goods not accepted sent back to the buyer
  parcels: ReturnParcelDto[];
  // the most the next transfer may still take off for the way back, 0 when it may take none: a
  // withdrawal whose contract says the buyer pays, with rows that wait for their money, the cost of
  // its parcels less what the transfers sent took for them. A hint, the admin decides
  deductible: number;
  // what the admin should see before acting on the statement
  warnings: ReturnWarning[];
}

// a line of the money journal of a statement
export interface ReturnMoneyMoveDto {
  id: number;
  event: string;
  purpose: MoneyPurpose;
  part: MoneyPart;
  // signed: above 0 to the shop
  amount: number;
  currency: string | null;
  state: 'in_transit' | 'sent' | null;
  stateAt: string | null;
  createdAt: string;
  happenedAt: string | null;
  refundId: string | null;
  bankReference: string | null;
  byDashboard: boolean;
  failure: RefundFailure | null;
  failureText: string | null;
  method: OutsideMethod | null;
  note: string | null;
  coversId: number | null;
  // the parcel of a cost (of a statement)
  shipmentId: number | null;
  // who wrote it, none for the work of the system
  by: ReturnPersonDto | null;
}

// shop_paid_parcel: the shop paid the carrier for the parcel of the goods back to the shop: no way back
// is owed to the buyer, and a withdrawal whose contract makes the buyer pay it may have it taken off
// buyer_paid_over_total: what the buyer paid the carrier for the parcel back is more than the order
// cost (a typo to check before money goes)
export type ReturnWarning = 'shop_paid_parcel' | 'buyer_paid_over_total';

// where a parcel goes: to the shop (the goods of a statement on their way back) or to the buyer (a
// send of the order, the goods not accepted sent back)
export type ShipmentDirection = 'to_buyer' | 'to_shop';

// a parcel of a statement: the goods on their way back to the shop (one a statement: the one the
// buyer told of, or the one the shop sent for them) or the goods not accepted sent back to the buyer.
// What the shop paid the carrier is an expense of the period it was written in
export interface ReturnParcelDto {
  id: number;
  direction: ShipmentDirection;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  // when the parcel was sent: when the buyer told of it, or the time the admin gave (a parcel
  // refused at the door: the moment of the refusal)
  shippedAt: string;
  // who wrote it: an admin, or the buyer of an account; none for the buyer of the public form
  recordedBy: ReturnPersonDto | null;
  // a parcel to the shop: when an admin confirmed it and who
  confirmedAt: string | null;
  confirmedBy: ReturnPersonDto | null;
  // what the buyer paid the carrier, as they told it or as the admin set it from the receipt
  buyerPaid: number | null;
  // what the shop paid the carrier, none until an admin writes it
  cost: number | null;
  // the rows a parcel to the buyer carried back; none for a parcel to the shop
  itemIds: number[];
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

// a parcel of a statement as the buyer sees it: where it goes, the carrier and the number, when it
// was sent, whether the shop confirmed a parcel to the shop, what the buyer paid the carrier
export interface BuyerReturnParcelDto {
  direction: ShipmentDirection;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string;
  confirmed: boolean;
  buyerPaid: number | null;
}

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
  // the parcels of the statement: the one the goods went back to the shop in, the ones the shop sent
  // the goods it did not accept back in
  parcels: BuyerReturnParcelDto[];
  // what the shop paid back for sending the goods back, outside the app
  // how much went back to the buyer by this statement in all
  refundedTotal: number;
  // the money the statement sent back, a movement at a time, the oldest first
  refunds: BuyerReturnRefundDto[];
  items: Array<{
    // the row of the statement: the parcel of the buyer may name it
    id: number;
    orderItemId: number;
    quantity: number;
    // what the units cost
    amount: number;
    money: ReturnMoney;
    // when the money of the row was sent
    refundedAt: string | null;
    // why the money of the units was refused: the shop did not accept the goods (the reason) or
    // they never came
    refusal: ReturnNotAcceptedReason | 'not_arrived' | null;
  }>;
}

// a movement of the money of a statement as the buyer sees it: a transfer to the way they paid, or
// money root sent outside the app; what it was made of and where it stands
export interface BuyerReturnRefundDto {
  way: 'payment' | 'outside';
  method: OutsideMethod | null;
  state: 'in_transit' | 'sent' | 'failed';
  goods: number;
  delivery: number;
  // kept for the way back the buyer pays
  deduction: number;
  // the way back the shop pays, what the buyer paid the carrier
  wayBack: number;
  // what the buyer gets: the goods, the delivery and the way back less the deduction
  amount: number;
  // when it was sent (asked, while in transit; failed: when it failed)
  at: string;
  // the number the bank gives to follow a transfer to the way the buyer paid (ARN), once the
  // provider tells it; null for money sent another way
  bankReference: string | null;
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
  // the parcel the goods came in, confirmed in the same step when it is not confirmed yet
  parcel?: ReturnParcelConfirmDto & {
    carrier?: string;
    trackingNumber?: string;
    trackingUrl?: string;
  };
}

// who paid the carrier of the parcel to the shop, said when an admin confirms it: the shop (cost) or
// the buyer (buyerPaid, from the receipt)
export interface ReturnParcelConfirmDto {
  buyerPaid?: number;
  cost?: number;
}

export interface ReceiveReturnItemsDto extends ReceiveReturnItemsBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
  log: FastifyBaseLogger;
}

export interface ConfirmReturnProofDto extends ReturnParcelConfirmDto {
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

// POST /api/returns/:returnId/refund/outside: all the statement owes, or the rows named
export interface RefundReturnOutsideBodyDto {
  itemIds?: number[];
  method: OutsideMethod;
  note: string;
  // the day the money really went, never before the order was paid or of the future
  at: string;
  // the cost of the way back the buyer owes, taken off
  returnShippingDeduction?: number;
}

export interface RefundReturnOutsideDto extends RefundReturnOutsideBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
  log: FastifyBaseLogger;
}

// POST /api/returns/:returnId/money-received: money the buyer gave back outside the app for rows
export interface RecordMoneyReceivedBodyDto {
  items: { itemId: number; amount: number }[];
  method: OutsideMethod;
  note: string;
  // the day the money really came, never before the statement or of the future
  at: string;
}

export interface RecordMoneyReceivedDto extends RecordMoneyReceivedBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
}

// POST /api/returns/:returnId/overpaid/received: money the buyer gave back outside the app of what
// money already with the buyer gave the goods of the order more than its statements took
export interface RecordOverpaidReceivedBodyDto {
  amount: number;
  method: OutsideMethod;
  note: string;
  // the day the money really came, never before the money went or of the future
  at: string;
}

export interface RecordOverpaidReceivedDto extends RecordOverpaidReceivedBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
}

// POST /api/returns/:returnId/overpaid/lost: the shop gives what is overpaid up
export interface LoseOverpaidBodyDto {
  note: string;
}

export interface LoseOverpaidDto extends LoseOverpaidBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
}

// POST /api/returns/:returnId/keep: the shop keeps goods it did not accept that are still with it
export interface KeepReturnGoodsBodyDto {
  items: { itemId: number; goods: 'to_stock' | 'written_off' }[];
  note: string;
}

export interface KeepReturnGoodsDto extends KeepReturnGoodsBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
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
  // to_shop: the parcel the goods come back in; to_buyer: goods not accepted go back to the buyer
  direction: 'to_shop' | 'to_buyer';
  // the rows of goods not accepted a parcel to the buyer carries, and their units
  items?: { itemId: number; quantity: number }[];
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  cost?: number;
  // when the parcel was sent, or the moment it was refused: never of the future, never before the
  // order was paid
  shippedAt: string;
}

export interface RecordReturnShipmentDto extends RecordReturnShipmentBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
  log: FastifyBaseLogger;
}

// POST /api/returns/:returnId/split: the rows and the units that go into a new statement
export interface SplitReturnBodyDto {
  items: { itemId: number; quantity: number }[];
}

export interface SplitReturnDto extends SplitReturnBodyDto {
  actorId: UserId;
  actorRole: Role;
  returnId: number;
  log: FastifyBaseLogger;
}

// PATCH /api/returns/:returnId/shipments/:shipmentId
export interface ReturnShipmentParamsDto {
  returnId: number | string;
  shipmentId: number | string;
}

// one of the two: what the shop paid the carrier, or what the buyer paid it (a parcel back to the
// shop, while no money of the way back went)
export interface SetReturnShipmentCostBodyDto {
  cost?: number;
  buyerPaid?: number;
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
  moneyHeld?: boolean;
  moneyShort?: boolean;
  moneyOverpaid?: boolean;
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
  // what an open statement still has to send the buyer (the rows owed, their delivery, the way back:
  // the total of the money left of its card); null for a closed one
  moneyLeft: number | null;
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
