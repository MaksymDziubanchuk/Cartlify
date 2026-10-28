import type { DeliveryMethodName } from '@config/deliveryMethods.js';
import type { DeliveryQuote } from '@helpers/deliveryPrice.js';
import type { UserId, ProductId, OrderId, CategoryId, IdParam } from 'types/ids.js';
import type { Role } from 'types/user.js';

// types
export type OrderStatus =
  | 'pending'
  | 'unconfirmed'
  | 'waiting'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'cancelled';
export type ConfirmedStatus = true | false;

// shared response shapes
export interface OrderItemProductDto {
  id: ProductId;
  name: string;
  categoryId: CategoryId;

  // the primary image; null for a product without one
  images: {
    url200: string;
    url400: string;
    url800: string;
  } | null;

  availableStock: number;
  deletedAt?: Date | null;

  // an order that is not paid: the price of the product now and its sale while it lasts, the
  // way the catalog shows them
  price?: number;
  salePrice?: number;
  saleEndsAt?: string;
  salePriorPrice?: number;
}

export interface OrderItemDto {
  // order item id, used as itemId in PATCH/DELETE /current/items/:itemId
  id: number;
  productId: ProductId;
  // the name of the item: the one the product had when the order was confirmed, the one of now
  // for a cart
  name: string;
  product: OrderItemProductDto;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
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
  // an order that is not confirmed: what each enabled method would cost now
  deliveryQuotes?: DeliveryQuote[];
  // a cart: the delivery of the last order of the buyer
  deliverySuggestion?: OrderDeliverySuggestionDto;
  // admin and root: every send of the order, the latest first
  shipments?: OrderShipmentAdminDto[];
  // admin and root: what the order weighs; not complete when a product of it has no weight
  weight?: { grams: number; complete: boolean };
}

// GET /current
export interface GetCurrentOrderDto {
  actorId: UserId;
  actorRole: Role;
}

// POST /current/items
export interface CurrentAddItemBodyDto {
  productId: ProductId;
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

// POST /:orderId/cancel-payment and POST /:orderId/cancel
export interface CancelOrderBodyDto {
  // a manual order that was shipped: the carrier was paid already (the cost of the send stays owed)
  // or not (nothing is owed)
  shippingPaid?: boolean;
}

export interface CancelOrderDto {
  actorId: UserId;
  actorRole: Role;
  orderId: OrderId;
  shippingPaid?: boolean;
}

// the answer of an admin cancel: the order with how to reach its buyer
export interface CancelledOrderResponseDto extends OrderResponseDto {
  user: {
    id: UserId;
    deleted: boolean;
    // only while the account is not deleted
    email?: string;
  };
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
  | 'shippingCostMissingSince';
export type OrdersSortDir = 'asc' | 'desc';

export interface GetOrdersQueryDto {
  limit?: number;
  cursor?: string;

  status?: OrderStatus;
  // a few statuses, separated by commas
  statuses?: string;
  confirmed?: ConfirmedStatus;
  // the orders paid from paidFrom and before paidTo, iso date-times
  paidFrom?: string;
  paidTo?: string;
  // the orders changed last from updatedFrom and before updatedTo, iso date-times
  updatedFrom?: string;
  updatedTo?: string;
  // the orders that hold the product
  productId?: number;

  // the desk of an admin: the orders of a buyer, a text of a buyer or a recipient, a csv
  userId?: number;
  q?: string;
  format?: 'json' | 'csv';

  // the delivery filters of the desk: the methods and the countries through commas, a part of the
  // name of the carrier of the send on its way, the orders shipped without a number, with a
  // delivery the buyer pays for or not, with a product that has no weight, whose send has no cost
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
  confirmed?: ConfirmedStatus;
  paidFrom?: Date;
  paidTo?: Date;
  updatedFrom?: Date;
  updatedTo?: Date;
  productId?: number;
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
  // the step comes from the route of many orders (the admin log tells it)
  bulk?: boolean;
}

export type UpdateOrderStatusResponseDto = OrderResponseDto;

// one step of shipping for many orders, each in a transaction of its own with its own answer
export interface UpdateOrdersStatusBodyDto {
  status: 'paid' | 'shipped' | 'delivered';
  // each order with its own send, and its own choice for a step back
  orders: { orderId: OrderId; shipment?: ShipmentInputDto; keepShippingCost?: boolean }[];
}

export interface UpdateOrdersStatusDto extends UpdateOrdersStatusBodyDto {
  actorId: UserId;
  actorRole: Role;
}

export type UpdateOrdersStatusResultDto =
  | { orderId: OrderId; ok: true; status: OrderStatus }
  | { orderId: OrderId; ok: false; errorCode: string; details?: Record<string, unknown> };

export interface UpdateOrdersStatusResponseDto {
  results: UpdateOrdersStatusResultDto[];
}
