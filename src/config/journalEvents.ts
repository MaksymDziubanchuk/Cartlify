// The events of the four journals: admin_audit_log, product_price_change_logs, login_logs and
// legal_acceptances. An event says what made the line, finer than an action or a role: the route
// that wrote it, or the condition it was written under. Two lines of the same action from two
// routes have two events. The database keeps the shape (domain.name, lower case, db/06); this file
// is the list the app writes from and the journals can be filtered by. A line from before the
// events has legacy.unknown.

export const LEGACY_EVENT = 'legacy.unknown';

export const AUDIT_EVENTS = [
  // products
  'product.create',
  'product.update',
  'product.update_batch',
  'product.category_change',
  'product.restore',
  'product.delete',
  'product.price_bulk',
  // the sale of a product: by its own route, by the route of many, together with a price, or ended
  // by the database when a price went down to the sale price
  'product.sale_set',
  'product.sale_remove',
  'product.sale_set_bulk',
  'product.sale_set_with_price',
  'product.sale_remove_with_price',
  'product.sale_end_by_price',
  // the stock
  'stock.delivery',
  'stock.write_off',
  // reviews
  'review.delete',
  // categories
  'category.create',
  'category.update',
  'category.delete',
  'category.reparent_on_delete',
  'category.image_set',
  'category.image_remove',
  // orders: a step of shipping, one at a time or in bulk, and a step back: a manual order is shipped
  // to a carrier and delivered, a pickup is ready and collected
  'order.ship',
  'order.ship_bulk',
  'order.deliver',
  'order.deliver_bulk',
  'order.ship_back',
  'order.ship_back_bulk',
  'order.deliver_back',
  'order.deliver_back_bulk',
  'order.pickup_ready',
  'order.pickup_ready_bulk',
  'order.pickup_collected',
  'order.pickup_collected_bulk',
  'order.pickup_ready_back',
  'order.pickup_ready_back_bulk',
  'order.pickup_collected_back',
  'order.pickup_collected_back_bulk',
  // the cancel with its refund: before any send, of a pickup ready to be collected, of a manual
  // order on its way with the carrier paid or not
  'order.cancel',
  'order.cancel_pickup_ready',
  'order.cancel_shipped_paid',
  'order.cancel_shipped_unpaid',
  // a payment given back late, a change of a send (the details mailed to the buyer, or the cost the
  // shop pays the carrier), of the delivery data
  'order.refund_late',
  'order.shipment_tracking_change',
  'order.shipment_cost_change',
  'order.delivery_change',
  // accounts
  'user.avatar_remove',
  'user.delete',
  'user.role_grant',
  'user.role_revoke',
  LEGACY_EVENT,
] as const;

export const PRICE_LOG_EVENTS = [
  // a new price of one product, of many in one request, of a selection (the bulk change)
  'price.set',
  'price.set_batch',
  'price.bulk',
  // the way from the price down to the sale price, and back when the sale is taken off
  'price.sale_start',
  'price.sale_end',
  LEGACY_EVENT,
] as const;

export const LOGIN_EVENTS = [
  'login.password',
  'login.google',
  'login.github',
  'login.linkedin',
  LEGACY_EVENT,
] as const;

export const CONSENT_EVENTS = [
  // the agreement of a new account made with the registration
  'consent.register',
  // the agreement a login asks for when a version came in force
  'consent.login',
  // the same through a provider: an account that this login creates, an account that was there
  'consent.oauth_signup',
  'consent.oauth_login',
  // the agreement a signed-in customer gives by itself
  'consent.accept',
  // the versions an order is confirmed with
  'consent.order',
  LEGACY_EVENT,
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];
export type PriceLogEvent = (typeof PRICE_LOG_EVENTS)[number];
export type LoginEvent = (typeof LOGIN_EVENTS)[number];
export type ConsentEvent = (typeof CONSENT_EVENTS)[number];

// the events a line is written with: all but the one of the lines from before the events
export type WrittenEvent<T extends string> = Exclude<T, typeof LEGACY_EVENT>;

// the events of the sale lines of the admin log by where the sale was set or taken off
export type SaleSource = 'route' | 'bulk' | 'with_price';
