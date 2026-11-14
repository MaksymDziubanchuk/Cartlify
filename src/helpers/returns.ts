import {
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

// the values of the statements of withdrawal and of return, the ones of the database (the enums of
// prisma): the lists the schemas of the routes take their enums from, so the two never part

export const RETURN_SOURCES = Object.values(ReturnSource);
export const RETURN_BASES = Object.values(ReturnBasis);
export const RETURN_REASONS = Object.values(ReturnReason);
export const RETURN_GOODS = Object.values(ReturnGoods);
export const RETURN_MONEY = Object.values(ReturnMoney);
export const RETURN_NOT_ACCEPTED_REASONS = Object.values(ReturnNotAcceptedReason);
export const RETURN_STATUSES = Object.values(ReturnStatus);
export const RETURN_CLOSE_CODES = Object.values(ReturnCloseCode);
// the money: why a refund failed, how root sends money outside the app by hand, what a line of the
// money journal is about and which part of a movement it is
export const REFUND_FAILURES = Object.values(RefundFailure);
export const OUTSIDE_METHODS = Object.values(OutsideMethod);
export const MONEY_PURPOSES = Object.values(MoneyPurpose);
export const MONEY_PARTS = Object.values(MoneyPart);
// the codes root closes rows with by hand: stated_again is the one of the database, when the buyer
// states the units of a form without the code themselves
export const RETURN_ROOT_CLOSE_CODES = RETURN_CLOSE_CODES.filter((code) => code !== 'stated_again');

// the results an admin may set for the goods of a row: all but expected, which is where a row starts
export const RETURN_GOODS_RESULTS = RETURN_GOODS.filter((goods) => goods !== 'expected');

// the longest words of a buyer or an admin a statement keeps
export const RETURN_DESCRIPTION_MAX = 2000;

// the longest note root writes when it lowers a sum, sends money outside the app or closes rows
export const RETURN_NOTE_MAX = 500;

// the days the law gives the shop to return the money of a withdrawal, from the statement (art. 13
// of the directive); the shop may hold it until the goods are back or the parcel is proven
export const REFUND_DAYS = 14;

// the code of a statement the buyer and the admins see: W for a withdrawal, R for a return outside
// it, the order and the number of the statement in it (W42-2); the database sets the number once
export const returnCodeOf = (basis: string, orderId: number, number: number): string =>
  `${basis === 'withdrawal' ? 'W' : 'R'}${orderId}-${number}`;

// the order and the number of a code a person types (w42-2 too), none for anything else
export function parseReturnCode(text: string): { orderId: number; number: number } | null {
  const match = /^[WR]([1-9][0-9]{0,9})-([1-9][0-9]{0,4})$/i.exec(text.trim());
  if (!match) return null;
  const orderId = Number(match[1]);
  if (orderId > 2_147_483_647) return null;
  return { orderId, number: Number(match[2]) };
}
