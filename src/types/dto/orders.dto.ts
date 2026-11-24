import type { FastifyBaseLogger } from 'fastify';
import type { DeliveryMethodName } from '@config/deliveryMethods.js';
import type { DeliveryQuote } from '@helpers/deliveryPrice.js';
import type {
  MoneyPart,
  MoneyPurpose,
  MoneyState,
  ParcelState,
  ReturnStatus,
} from '@prisma/client';
import type { OrderHold } from '@helpers/orderHolds.js';
import type { ParcelCase } from '@routes/api/orders/services/helpers/parcelCases.helper.js';
import type { WithdrawalRight, WithdrawalRuleName } from '@helpers/withdrawal.js';
import type {
  BuyerReturnDto,
  OrderReturnUnitsDto,
  ReturnSummaryDto,
  WithdrawableDto,
} from './returns.dto.js';
import type { UserId, ProductId, OrderId, CategoryId, IdParam } from 'types/ids.js';
import type { Role } from 'types/user.js';
import type { VariantOfItemDto } from './variants.dto.js';

// types
export type OrderStatus =
  'pending' | 'unconfirmed' | 'waiting' | 'paid' | 'shipped' | 'delivered' | 'cancelled';
export type ConfirmedStatus = true | false;

// shared response shapes

// the product of a position: what the page needs to link to it
// the state of a fiscal receipt the list of the orders of the admins filters by
export type OrdersReceiptsFilter = 'pending' | 'refused';

export interface OrderItemProductDto {
  id: ProductId;
  name: string;
  categoryId: CategoryId;
}

// a position of a cart or an order: the variant that is bought (the name, the price, the free units
// and the main picture of THAT variant, and whether it is still for sale) and its product. The
// name and the price of a confirmed order are the ones of the confirmation, the copies it keeps
export interface OrderItemDto {
  // order item id, used as itemId in PATCH/DELETE /current/items/:itemId
  id: number;
  product: OrderItemProductDto;
  variant: VariantOfItemDto;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  // the rule of withdrawal of the product and the kind it makes: the rule of now while the order is
  // a cart, the rule of the confirmation once it is confirmed
  withdrawal: { rule: WithdrawalRuleName; right: WithdrawalRight };
  // the tax the line holds, as the confirmation fixed it (docs/taxes.md); left out while the order is
  // a cart and for a shop that takes no tax
  tax?: { rate: number | null; amount: number };
}

// the tax of a confirmed order: the rule and the country it is taxed in, the sums by rate (the
// items and the delivery), whether the buyer may pay the tax and the duty on receipt, and whether
// the buyer asked for an invoice
export interface OrderTaxDto {
  rule: string;
  country: string;
  totals: { rate: number | null; net: number; tax: number; gross: number }[];
  payOnReceipt: boolean;
  invoiceRequested: boolean;
}

// the address of a manual delivery
export interface OrderDeliveryAddressDto {
  country: string;
  postalCode: string | null;
  city: string;
  street: string;
  house: string;
  apartment: string | null;
}

// a parcel on its way, as the buyer sees it: who carries it, how to follow it, where it stands
export interface OrderShipmentPublicDto {
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  state: ParcelState;
}

// a box of a parcel as the admin sees it: its weight and sizes (none for a manual send without
// them), the number and the label of the carrier for it, and what is in it
export interface ShipmentBoxDto {
  number: number;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  trackingNumber: string | null;
  labelUrl: string | null;
  items: { orderItemId: number; quantity: number }[];
}

// a send as the admin sees it, with what the shop pays the carrier
export interface OrderShipmentAdminDto extends OrderShipmentPublicDto {
  id: number;
  // what the shop pays the carrier, empty until it is written
  cost: number | null;
  // false when the shop owes the carrier nothing for it
  expense: boolean;
  // empty while the carrier has not taken a parcel of the delivery provider
  shippedAt: Date | null;
  // when the status went back from shipped; the send stays as history
  rolledBackAt: Date | null;
  // a parcel of the delivery provider: the label to print; none for a manual send
  labelUrl: string | null;
  // a parcel with the tax number of the shop on its commercial invoice: sent to the carrier with
  // the parcel (electronic) or to print with the label (print); none for any other parcel
  customsInvoice: 'electronic' | 'print' | null;
  boxes: ShipmentBoxDto[];
}

// a movement of the money of an order as the card of an admin shows it, short: a line of the money
// journal (what made it, what it is about, which part of the movement, the sum with its sign: above
// 0 to the shop, below 0 from it, where a refund stands, when it was written)
export interface OrderMoneyLineDto {
  id: number;
  event: string;
  purpose: MoneyPurpose;
  part: MoneyPart;
  amount: number;
  state: MoneyState | null;
  createdAt: string;
}

// where and to whom the order goes
export interface OrderDeliveryDto {
  method: DeliveryMethodName;
  // what the buyer pays for it: fixed when the order is confirmed, the price of now before that
  price: number;
  recipient: { firstName: string; lastName: string; phone: string };
  address: OrderDeliveryAddressDto | null;
  note: string | null;
  // where and when to collect the order, the pickup only
  pickup: { address: string; hours: string } | null;
  // the parcels on their way, once the order is shipped (a carrier took them); none before
  shipments: OrderShipmentPublicDto[];
}

// a delivery of an earlier order of the buyer, offered for the cart to start from
export interface OrderDeliverySuggestionDto {
  method: DeliveryMethodName;
  recipient: { firstName: string; lastName: string; phone: string };
  address: OrderDeliveryAddressDto | null;
}

export interface OrderResponseDto {
  id: OrderId;
  userId: UserId;
  status: OrderStatus;
  confirmed: ConfirmedStatus;
  items: OrderItemDto[];
  // what the items cost
  itemsTotal: number;
  // what the buyer pays: the items and the delivery
  total: number;
  // empty while the order has none: a cart of a buyer who has not chosen yet
  delivery: OrderDeliveryDto | null;
  // the tax the confirmation fixed; left out while the order is a cart and with no tax
  tax?: OrderTaxDto;

  createdAt: Date;
  updatedAt: Date;

  // left out while the order does not have them
  reservationExpiresAt?: Date;
  // when the payment was recorded and when an admin cancelled the paid order
  paidAt?: Date;
  cancelledAt?: Date;
  // when the order was delivered, and when the buyer may no longer withdraw from it: the days the
  // order kept from the contract (14 when none was published) and the days of grace of the shop
  // after the delivery, to the end of the last day in the time zone of the shop; both left out
  // until the order is delivered
  deliveredAt?: Date;
  withdrawalEndsAt?: Date;
  // whether the buyer may withdraw now: a paid or shipped order always, a delivered one until
  // withdrawalEndsAt, every other order never
  withdrawalOpen: boolean;
  // where the order stands as to its statements of withdrawal and return (none, open, open_partial,
  // partial, full, declined), set by the database
  returnStatus: ReturnStatus;
  // an order that is not confirmed: what each enabled method would cost now
  deliveryQuotes?: DeliveryQuote[];
  // a cart: the delivery of the last order of the buyer
  deliverySuggestion?: OrderDeliverySuggestionDto;
  // admin and root: every send of the order, the latest first
  shipments?: OrderShipmentAdminDto[];
  // admin and root: the statements of withdrawal and of return of the order, the oldest first
  returns?: ReturnSummaryDto[];
  // admin and root, an order with statements: what they did to each item, and the money in sum
  returnUnits?: OrderReturnUnitsDto;
  // the buyer: their statements of the order with the path of each, the oldest first, and the units
  // they can still state
  withdrawals?: BuyerReturnDto[];
  withdrawable?: WithdrawableDto[];
  // the buyer: the payment is checked before the order is sent (a warning or a review holds it)
  paymentCheck?: boolean;
  // admin and root: what the order weighs (the weights of its variants times the units); not complete when a variant of it has no weight
  weight?: { grams: number; complete: boolean };
  // admin and root: what keeps the order from its sending, the oldest first
  holds?: OrderHold[];
  // admin and root: when the provider warned that the payment of the order, already sent, may be
  // fraud; left out while it did not
  fraudWarnedAt?: Date;
  // admin and root: the money of the order from the money journal, the oldest first
  money?: OrderMoneyLineDto[];
}

// GET /current
export interface GetCurrentOrderDto {
  actorId: UserId;
  actorRole: Role;
}

// POST /current/items
export interface CurrentAddItemBodyDto {
  // the variant to buy; the same variant again adds units to its position
  variantId: number;
  quantity: number;
}

export interface CurrentAddItemDto extends CurrentAddItemBodyDto {
  actorId: UserId;
  actorRole: Role;
  // an own unconfirmed order instead of the cart (POST /:orderId/items)
  orderId?: OrderId;
}

// PATCH /current/items/:itemId
export interface CurrentItemIdParamsDto {
  itemId: IdParam;
}

export interface CurrentUpdateItemBodyDto {
  quantity: number;
}

export interface CurrentUpdateItemDto extends CurrentUpdateItemBodyDto {
  itemId: number;
  actorId: UserId;
  actorRole: Role;
  // an own unconfirmed order instead of the cart (PATCH /:orderId/items/:itemId)
  orderId?: OrderId;
}

// DELETE /current/items/:itemId
export interface CurrentDeleteItemDto {
  itemId: number;
  actorId: UserId;
  actorRole: Role;
  // an own unconfirmed order instead of the cart (DELETE /:orderId/items/:itemId)
  orderId?: OrderId;
}

// /:orderId/items/:itemId
export interface OrderItemParamsDto {
  orderId: IdParam;
  itemId: IdParam;
}

// POST /:orderId/cancel-payment
export interface CancelOrderDto {
  actorId: UserId;
  actorRole: Role;
  orderId: OrderId;
}

// POST /:orderId/withdrawal: the buyer withdraws from the contract, all that is left or the units named
export interface WithdrawBodyDto {
  items?: Array<{ orderItemId: number; quantity: number }>;
  // their own words
  description?: string;
}

export interface WithdrawDto extends WithdrawBodyDto {
  actorId: UserId;
  actorRole: Role;
  orderId: OrderId;
  log: FastifyBaseLogger;
}

// POST /:orderId/returns/:returnId/proof: how the buyer sent the goods back
export interface ReturnProofBodyDto {
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string;
  // what the buyer paid the carrier, a hint for the shop
  buyerPaid?: number;
  // the rows of the statement and the units the parcel carries; the rest goes into a statement of
  // its own. None: the parcel carries them all
  items?: Array<{ itemId: number; quantity: number }>;
}

export interface ReturnProofParamsDto {
  orderId: IdParam;
  returnId: IdParam;
}

export interface ProvideReturnProofDto extends ReturnProofBodyDto {
  actorId: UserId;
  actorRole: Role;
  orderId: OrderId;
  returnId: number;
  log: FastifyBaseLogger;
}

// POST /current/confirm
export interface ConfirmDeliveryBodyDto {
  method: DeliveryMethodName;
  recipientFirstName: string;
  recipientLastName: string;
  recipientPhone: string;
  // the manual method needs it, a pickup has none
  address?: {
    country: string;
    postalCode: string;
    city: string;
    street: string;
    house: string;
    apartment?: string;
  };
  // optional; an empty one removes the note
  note?: string;
  // the method carrier: the line of the prices the buyer picked (POST
  // /api/orders/current/delivery-options), none for the other methods
  carrier?: DeliveryCarrierDto;
}

// a carrier of the delivery provider as a line of its prices names it
export interface DeliveryCarrierDto {
  name: string;
  service: string;
  connection: string;
}

// POST /current/delivery-options: the address the cart would go to
export interface DeliveryOptionsBodyDto {
  address: NonNullable<ConfirmDeliveryBodyDto['address']>;
}

// a way the cart goes to the address and its price for the items of the cart; a carrier with its
// name for the buyer and how long it takes
// the tax of the cart sent one way (docs/taxes.md): the items at the prices the rule leaves, the
// tax by rate, the total; whether the buyer may pay the tax and the duty on receipt, and why the
// order cannot go (null when it can)
export interface DeliveryOptionTaxDto {
  items: {
    itemId: number;
    unitPrice: number;
    totalPrice: number;
    rate: number | null;
    tax: number;
  }[];
  totals: { rate: number | null; net: number; tax: number; gross: number }[];
  total: number;
  payOnReceipt: boolean;
  refusal:
    | { code: 'TAX_SALES_STOPPED' }
    | { code: 'TAX_PARCEL_LIMIT'; limit: number; withDelivery: boolean; withVat: boolean }
    | { code: 'ORDER_TOTAL_ABOVE_MAXIMUM'; maximum: number }
    | null;
}

export interface DeliveryOptionDto {
  method: DeliveryMethodName;
  price: number;
  carrier: DeliveryCarrierDto | null;
  label: string | null;
  days: string | null;
  tax: DeliveryOptionTaxDto;
}

export interface DeliveryOptionsResponseDto {
  currency: string;
  // the zone of the country: its name and the sum of the items from which every delivery is free
  zone: { name: string; freeFrom: number | null };
  // what the cart lacks of that sum, 0 once the delivery is free; null for a zone without one
  remainingToFree: number | null;
  options: DeliveryOptionDto[];
  // why no carrier is in the list; null when the carriers are there
  carriersUnavailable:
    'not_enabled' | 'shipping_data_missing' | 'provider_down' | 'no_carrier_for_parcel' | null;
}

export interface ConfirmCurrentOrderBodyDto {
  orderId: OrderId;
  // required for an order that has no delivery yet; an order that lost its reservation keeps the
  // one it had. Whole when sent: it replaces the delivery of the order
  delivery?: ConfirmDeliveryBodyDto;
  // the price of the delivery the page showed the buyer; another price now refuses the confirmation
  expectedDeliveryPrice: number;
  // the buyer asks for an invoice (a shop that makes them on request, invoiceMode on_request)
  invoice?: boolean;
}

export interface ConfirmCurrentOrderDto extends ConfirmCurrentOrderBodyDto {
  actorId: UserId;
  actorRole: Role;
  log: FastifyBaseLogger;
}

// GET /
// destination: the country, then the city; the orders that go to no address (a pickup) are left out.
// shippingCostMissingSince: the oldest send the shop owes the carrier for and has written no cost
// of, with the filter shippingCostMissing only (the sort it has by default)
export type OrdersSortBy =
  | 'createdAt'
  | 'updatedAt'
  | 'total'
  | 'paidAt'
  | 'deliveryMethod'
  | 'destination'
  | 'deliveryPrice'
  | 'returnStatus'
  | 'shippingCostMissingSince';
export type OrdersSortDir = 'asc' | 'desc';

export interface GetOrdersQueryDto {
  limit?: number;
  cursor?: string;

  status?: OrderStatus;
  // a few statuses, separated by commas
  statuses?: string;
  // a few statuses of the statements of return, separated by commas
  returnStatuses?: string;
  confirmed?: ConfirmedStatus;
  // the orders paid from paidFrom and before paidTo, iso date-times
  paidFrom?: string;
  paidTo?: string;
  // the orders changed last from updatedFrom and before updatedTo, iso date-times
  updatedFrom?: string;
  updatedTo?: string;
  // the orders that hold a variant of the product, or the variant itself
  productId?: number;
  variantId?: number;

  // the desk of an admin: the orders of a buyer, a text of a buyer or a recipient, a csv
  userId?: number;
  q?: string;
  format?: 'json' | 'csv';

  // the delivery filters of the desk: the methods and the countries through commas, a part of the
  // name of the carrier of the send on its way, the orders shipped without a number, with a
  // delivery the buyer pays for or not, with a variant that has no weight, whose send has no cost
  deliveryMethod?: string;
  country?: string;
  carrier?: string;
  shippedWithoutNumber?: boolean;
  deliveryCharged?: boolean;
  withoutWeight?: boolean;
  shippingCostMissing?: boolean;
  // the orders with a send sent before this time, an iso date-time
  shippedTo?: string;
  // what holds the orders from their sending: reasons through commas, any, or none; and the orders
  // the provider warned of after they were sent, from this time (an iso date-time)
  holds?: string;
  fraudWarnedFrom?: string;
  // the orders with a fiscal receipt in the state, the receipts made before this time (an iso
  // date-time)
  receipts?: OrdersReceiptsFilter;
  receiptsMadeTo?: string;
  // the orders whose parcels of the delivery provider wait for an admin (parcelCases.helper.ts), and
  // the parcels made before this time (an iso date-time)
  parcels?: ParcelCase;
  parcelsMadeTo?: string;

  sortBy?: OrdersSortBy;
  sortDir?: OrdersSortDir;
}

export interface FindOrdersDto {
  actorId: UserId;
  actorRole: Role;
  limit: number;
  cursor?: string;

  status?: OrderStatus;
  statuses?: string;
  returnStatuses?: string;
  confirmed?: ConfirmedStatus;
  paidFrom?: Date;
  paidTo?: Date;
  updatedFrom?: Date;
  updatedTo?: Date;
  productId?: number;
  variantId?: number;
  userId?: number;
  q?: string;
  format?: 'json' | 'csv';
  deliveryMethod?: string;
  country?: string;
  carrier?: string;
  shippedWithoutNumber?: boolean;
  deliveryCharged?: boolean;
  withoutWeight?: boolean;
  shippingCostMissing?: boolean;
  shippedTo?: Date;
  holds?: string;
  fraudWarnedFrom?: Date;
  receipts?: OrdersReceiptsFilter;
  receiptsMadeTo?: Date;
  parcels?: ParcelCase;
  parcelsMadeTo?: Date;

  // without them the list takes the sort of its filters (normalizeFindOrdersInput)
  sortBy?: OrdersSortBy;
  sortDir?: OrdersSortDir;
}

// the buyer of an order in the list of an admin; a deleted account has no email
export interface OrderBuyerDto {
  id: UserId;
  name: string | null;
  email: string | null;
  deleted: boolean;
}

export interface GetOrdersResponseDto {
  items: Array<OrderResponseDto & { buyer?: OrderBuyerDto }>;
  limit: number;
  nextCursor: string | null;
  total: number;
}

// GET /:orderId
export interface GetOrderByIdParamsDto {
  orderId: IdParam;
}

export interface FindOrderByIdDto {
  actorId: UserId;
  actorRole: Role;
  orderId: OrderId;
}

export type GetOrderByIdResponseDto = OrderResponseDto;

// PATCH /:orderId/status
export interface UpdateOrderStatusParamsDto {
  orderId: IdParam;
}

// the send of a shipped step, each part only if known
export interface ShipmentInputDto {
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  // what the shop pays the carrier; none until the admin writes it
  cost?: number | null;
  // the boxes and what is in each; none for the one parcel of an order: one box with every unit
  boxes?: ShipmentBoxInputDto[];
}

// the parcels of an order of a carrier as the admin lays them out (POST /:orderId/parcels): each
// with its boxes; none sent: one parcel of one box of every unit (the draft)
export interface ParcelsBodyDto {
  parcels?: { boxes: ShipmentBoxInputDto[] }[];
}

// what the app puts in the parcels when the admin says nothing, and the carrier of the order
// GET /:orderId/carriers: the carriers of the delivery provider for the order now, the cheapest
// first; the price is what the provider counts, the cost of the shop (the buyer paid theirs)
export interface OrderCarriersDto {
  carriers: {
    carrier: DeliveryCarrierDto;
    label: string | null;
    days: string | null;
    price: number;
  }[];
}

export interface ParcelsDraftDto {
  carrier: DeliveryCarrierDto;
  parcels: {
    boxes: {
      weightGrams: number | null;
      lengthMm: number | null;
      widthMm: number | null;
      heightMm: number | null;
      items: { orderItemId: number; quantity: number }[];
    }[];
  }[];
}

// the parcels made: the order as the admin sees it, the ids of the parcels made now, and the parcel
// that was not made (its place in the request, the code, the reason of the carrier) when one was not
export interface ParcelsResultDto {
  order: OrderResponseDto;
  made: number[];
  failed: { parcel: number; errorCode: string; message: string | null } | null;
}

export interface ParcelsBulkResultDto {
  results: {
    orderId: number;
    ok: boolean;
    made: number[];
    errorCode?: string;
    message?: string | null;
  }[];
}

// a box of a parcel as the admin lays it out
export interface ShipmentBoxInputDto {
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  items: { orderItemId: number; quantity: number }[];
}

export interface UpdateOrderStatusBodyDto {
  status: OrderStatus;
  // with shipped, of a manual order: the parcels it goes in (none: one parcel, nothing known of it)
  shipments?: ShipmentInputDto[];
  // with the step back to paid, of a manual order shipped: the cost of the send stays owed or not
  keepShippingCost?: boolean;
  // with the step to delivered: the moment the carrier delivered it, now when none is given
  deliveredAt?: string;
}

// PATCH /:orderId/shipments/:shipmentId: what the shop pays the carrier and the details of the send
export interface UpdateShipmentParamsDto {
  orderId: IdParam;
  shipmentId: IdParam;
}

export interface UpdateShipmentBodyDto {
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  // a line of the money journal: corrected by a new cost, never taken away (none is a cost of 0)
  cost?: number | null;
}

// POST /api/orders/:orderId/shipments/:shipmentId/carrier-money: money a carrier paid the shop
export interface RecordCarrierMoneyBodyDto {
  amount: number;
  method: 'bank_transfer' | 'cash' | 'other';
  note: string;
  // the day the money really came, never before the send or of the future
  at: string;
}

export interface RecordCarrierMoneyDto extends RecordCarrierMoneyBodyDto {
  actorId: UserId;
  actorRole: Role;
  orderId: number;
  shipmentId: number;
}

export interface UpdateShipmentDto {
  actorId: UserId;
  actorRole: Role;
  orderId: number;
  shipmentId: number;
  changes: UpdateShipmentBodyDto;
}

// POST /:orderId/holds/:reason/decision: root decides on what holds a paid order and is root's
export interface DecideOrderHoldParamsDto {
  orderId: number | string;
  reason: 'hand_refund' | 'fraud_warning';
}

export interface DecideOrderHoldBodyDto {
  decision: 'ship' | 'cancel';
  note: string;
}

export interface DecideOrderHoldDto extends DecideOrderHoldBodyDto {
  actorId: UserId;
  actorRole: Role;
  orderId: number;
  reason: DecideOrderHoldParamsDto['reason'];
}

// PATCH /:orderId/delivery: an admin corrects where a paid order goes and to whom
export interface UpdateOrderDeliveryBodyDto {
  recipientFirstName?: string;
  recipientLastName?: string;
  recipientPhone?: string;
  address?: NonNullable<ConfirmDeliveryBodyDto['address']>;
  note?: string;
  // an order of a carrier: another carrier of the prices of the delivery provider, or sent by hand
  // (manual) outside the provider; the price of the buyer stays
  carrier?: DeliveryCarrierDto;
  method?: 'manual';
}

export interface UpdateOrderDeliveryDto {
  actorId: UserId;
  actorRole: Role;
  orderId: number;
  changes: UpdateOrderDeliveryBodyDto;
  log: FastifyBaseLogger;
}

export interface UpdateOrderStatusDto {
  actorId: UserId;
  actorRole: Role;
  orderId: OrderId;
  status: OrderStatus;
  shipments?: ShipmentInputDto[];
  keepShippingCost?: boolean;
  deliveredAt?: string;
  // the step comes from the route of many orders (the admin log tells it)
  bulk?: boolean;
}

export type UpdateOrderStatusResponseDto = OrderResponseDto;

// one step of shipping for many orders, each in a transaction of its own with its own answer
export interface UpdateOrdersStatusBodyDto {
  status: 'paid' | 'shipped' | 'delivered';
  // each order with its own send, and its own choice for a step back
  orders: {
    orderId: OrderId;
    shipments?: ShipmentInputDto[];
    keepShippingCost?: boolean;
    deliveredAt?: string;
  }[];
}

export interface UpdateOrdersStatusDto extends UpdateOrdersStatusBodyDto {
  actorId: UserId;
  actorRole: Role;
}

export type UpdateOrdersStatusResultDto =
  | { orderId: OrderId; ok: true; status: OrderStatus; returnStatus: ReturnStatus }
  | { orderId: OrderId; ok: false; errorCode: string; details?: Record<string, unknown> };

export interface UpdateOrdersStatusResponseDto {
  results: UpdateOrdersStatusResultDto[];
}

// a tax document of an order (docs/taxes.md): an invoice or a credit note of ours (its number in
// its series, the PDF at GET /api/orders/:orderId/documents/:documentId/pdf), or a fiscal receipt
// of a provider (its state there, its number and link); a credit note and a return receipt name what
// they correct, a receipt the document it registers
export interface OrderTaxDocumentDto {
  id: number;
  kind: 'invoice' | 'credit_note' | 'receipt' | 'return_receipt';
  number: string | null;
  correctsId: number | null;
  documentId: number | null;
  net: number;
  tax: number;
  gross: number;
  currency: string;
  createdAt: string;
  receipt: {
    // null for a receipt not sent yet
    provider: string | null;
    state: 'pending' | 'registered' | 'refused' | 'manual';
    number: string | null;
    url: string | null;
    text: string | null;
    // the last answer of the provider that was not a receipt, for an admin; null for the buyer
    error: string | null;
  } | null;
}

export interface PostReceiptConfirmationBodyDto {
  number: string;
  url?: string | null;
}

export interface OrderTaxDocumentsResponseDto {
  items: OrderTaxDocumentDto[];
}
