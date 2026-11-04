import type { FastifyBaseLogger } from 'fastify';
import type { DeliveryMethodName } from '@config/deliveryMethods.js';
import type { DeliveryQuote } from '@helpers/deliveryPrice.js';
import type { ReturnStatus } from '@prisma/client';
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

// the send on its way, as the buyer sees it: who carries it and how to follow it
export interface OrderShipmentPublicDto {
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
}

// a send as the admin sees it, with what the shop pays the carrier
export interface OrderShipmentAdminDto extends OrderShipmentPublicDto {
  id: number;
  // what the shop pays the carrier, empty until it is written
  cost: number | null;
  // false when the shop owes the carrier nothing for it
  expense: boolean;
  shippedAt: Date;
  // when the status went back from shipped; the send stays as history
  rolledBackAt: Date | null;
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
  // the send on its way, once the order is shipped
  shipment: OrderShipmentPublicDto | null;
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
  // admin and root: what the order weighs (the weights of its variants times the units); not complete when a variant of it has no weight
  weight?: { grams: number; complete: boolean };
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
}

export interface ConfirmCurrentOrderBodyDto {
  orderId: OrderId;
  // required for an order that has no delivery yet; an order that lost its reservation keeps the
  // one it had. Whole when sent: it replaces the delivery of the order
  delivery?: ConfirmDeliveryBodyDto;
  // the price of the delivery the page showed the buyer; another price now refuses the confirmation
  expectedDeliveryPrice: number;
}

export interface ConfirmCurrentOrderDto extends ConfirmCurrentOrderBodyDto {
  actorId: UserId;
  actorRole: Role;
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
}

export interface UpdateOrderStatusBodyDto {
  status: OrderStatus;
  // with shipped, of a manual order
  shipment?: ShipmentInputDto;
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
  cost?: number | null;
}

export interface UpdateShipmentDto {
  actorId: UserId;
  actorRole: Role;
  orderId: number;
  shipmentId: number;
  changes: UpdateShipmentBodyDto;
}

// PATCH /:orderId/delivery: an admin corrects where a paid order goes and to whom
export interface UpdateOrderDeliveryBodyDto {
  recipientFirstName?: string;
  recipientLastName?: string;
  recipientPhone?: string;
  address?: NonNullable<ConfirmDeliveryBodyDto['address']>;
  note?: string;
}

export interface UpdateOrderDeliveryDto {
  actorId: UserId;
  actorRole: Role;
  orderId: number;
  changes: UpdateOrderDeliveryBodyDto;
}

export interface UpdateOrderStatusDto {
  actorId: UserId;
  actorRole: Role;
  orderId: OrderId;
  status: OrderStatus;
  shipment?: ShipmentInputDto;
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
    shipment?: ShipmentInputDto;
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
