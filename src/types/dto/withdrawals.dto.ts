import type { FastifyBaseLogger } from 'fastify';

// WITHDRAWALS: the public form of withdrawal and the proof of a parcel by the code of the mail, for
// a buyer who has no account to sign in to (the account of the order is deleted) or does not have
// the mail with the code at hand

// POST /api/withdrawals/route: where the page of the mail sends the visitor
export interface WithdrawalRouteBodyDto {
  orderId: number;
  // the code after the # of the link of the mail
  code?: string;
}

// account: the order is theirs, the button in the account withdraws from it; form: the public form;
// closed: the period of withdrawal of the order is over
export type WithdrawalRoute = 'account' | 'form' | 'closed';

export interface WithdrawalRouteResponseDto {
  where: WithdrawalRoute;
}

// what a visitor gives to show an order is theirs: with the code of the mail the name of the
// recipient; without it also the phone of the recipient, and for a delivery to an address its
// country and its postal code (when the order has one)
export interface WithdrawalFactsDto {
  orderId: number;
  // the name of the recipient of the order, as written in it
  recipientName: string;
  code?: string;
  phone?: string;
  country?: string;
  postalCode?: string;
}

// POST /api/withdrawals/items: the units the visitor may withdraw from
export type WithdrawalItemsBodyDto = WithdrawalFactsDto;

export interface WithdrawalItemsResponseDto {
  // the units free to withdraw from, by item: an item without the right and units in statements
  // already are left out
  items: Array<{ orderItemId: number; name: string; quantity: number }>;
  // the account of the order is alive: signing in withdraws at once, the form works too
  signIn: boolean;
  // without the code: a statement of the form without the code waits for the check of an admin,
  // another one is taken once it is accepted
  underReview: boolean;
}

// POST /api/withdrawals
export interface WithdrawalFormBodyDto extends WithdrawalFactsDto {
  // where the answers go
  email: string;
  items?: Array<{ orderItemId: number; quantity: number }>;
  description?: string;
}

export interface WithdrawalFormDto extends WithdrawalFormBodyDto {
  log: FastifyBaseLogger;
}

// POST /api/withdrawals/proof
export interface WithdrawalProofBodyDto {
  orderId: number;
  code: string;
  returnId: number;
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string;
  // what the buyer paid the carrier, a hint for the shop
  buyerPaid?: number;
}

export interface WithdrawalReceivedResponseDto {
  received: true;
}
