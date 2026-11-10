// The events of the five journals: admin_audit_log, product_price_change_logs, login_logs,
// legal_acceptances and stock_log. An event says what made the line, finer than an action or a
// role: the route that wrote it, or the condition it was written under. Two lines of the same
// action from two routes have two events. The database keeps the shape (domain.name, lower case,
// db/06); this file is the list the app writes from and the journals can be filtered by. A line
// from before the events has legacy.unknown (the stock log has none: it began with its events).

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
  // the gallery of a product: pictures added, a picture taken out (the variants that showed it lose it)
  'product.gallery_add',
  'product.gallery_remove',
  // a variant of a product: made, changed (by its own route, or by a route of many), taken out of
  // sale, put back
  'variant.create',
  'variant.update',
  'variant.update_batch',
  'variant.delete',
  'variant.restore',
  // the stock: one line for a whole delivery or write-off (the line of each variant is in the stock log)
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
  // the characteristics a category asks for, written whole
  'category.attributes_set',
  // the directory of the manufacturers and of the persons responsible in the EU
  'party.create',
  'party.update',
  'party.delete',
  // the directory of the documents (PDF files of instructions and certificates)
  'document.create',
  'document.update',
  'document.delete',
  // the directory of characteristics: groups, characteristics, the values of a choice; a reorder is
  // a line for each row that moved
  'attribute_group.create',
  'attribute_group.update',
  'attribute_group.delete',
  'attribute_group.reorder',
  'attribute.create',
  'attribute.update',
  'attribute.delete',
  'attribute.reorder',
  'attribute_option.create',
  'attribute_option.update',
  'attribute_option.delete',
  'attribute_option.reorder',
  // one value put in the place of another in every variant that has it (one line with how many changed)
  'attribute_option.replace',
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
  // a payment given back late, a change of a send (the details mailed to the buyer, or the cost the
  // shop pays the carrier), of the delivery data
  'order.refund_late',
  // a statement of withdrawal or of return: made, its goods taken in, the proof of the buyer
  // confirmed, its money returned or failed to return, money sent outside the app, rows closed
  // without a refund
  'return.create',
  'return.receive',
  'return.proof_confirm',
  'return.accept',
  // the buyer wrote how they sent the goods back
  'return.proof_provide',
  'return.refund',
  'return.refund_failed',
  'return.refund_outside',
  // root lowered what rows of a statement give back, with the reason
  'return.amount_lower',
  // root paid the buyer back the cost of the way back, outside the app
  'return.shipping_reimburse',
  // a dispute of the payment at the bank ended (root, or the webhook of the provider)
  'return.dispute_settle',
  'return.close',
  // the shop paid to carry the goods back: a parcel recorded, its cost written
  'return.shipment_record',
  'return.shipment_cost',
  'order.shipment_tracking_change',
  'order.shipment_cost_change',
  'order.delivery_change',
  // accounts
  'user.avatar_remove',
  'user.delete',
  'user.export',
  'user.role_grant',
  'user.role_revoke',
  // the newsletters: root gave an admin the right to run them or took it away (the line is about the
  // account of the admin); a newsletter (a campaign) made, changed, deleted, copied, planned,
  // cancelled before it started, stopped while it went, and a test mail of it sent to an admin; a
  // subscriber deleted by an admin with the data of the subscription; an address blocked for the
  // public form of the newsletters, or taken off the list
  'newsletter.manager_granted',
  'newsletter.manager_revoked',
  'newsletter.campaign_created',
  'newsletter.campaign_updated',
  'newsletter.campaign_deleted',
  'newsletter.campaign_copied',
  'newsletter.campaign_scheduled',
  'newsletter.campaign_cancelled',
  'newsletter.campaign_stopped',
  'newsletter.campaign_test_sent',
  'newsletter.subscriber_erased',
  'newsletter.block_added',
  'newsletter.block_removed',
  LEGACY_EVENT,
] as const;

export const PRICE_LOG_EVENTS = [
  // a new price of one variant, of many in one request, of a selection (the bulk change)
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

export const STOCK_LOG_EVENTS = [
  // goods taken in, with a delivery id
  'stock.delivery',
  // units written off, with a write-off id
  'stock.write_off',
  // the units a paid order took at its payment, with the order (the work of the system, no actor)
  'stock.sale',
  // the units that came back with a statement of return, with the order and the row of the statement
  'stock.return',
  // the units that came back with a statement and went out of the stock at once (written off or
  // lost), the line after the one of their return
  'stock.return_write_off',
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];
export type PriceLogEvent = (typeof PRICE_LOG_EVENTS)[number];
export type LoginEvent = (typeof LOGIN_EVENTS)[number];
export type ConsentEvent = (typeof CONSENT_EVENTS)[number];
export type StockLogEvent = (typeof STOCK_LOG_EVENTS)[number];

// the events a line is written with: all but the one of the lines from before the events
export type WrittenEvent<T extends string> = Exclude<T, typeof LEGACY_EVENT>;

// the events of the sale lines of the admin log by where the sale was set or taken off
export type SaleSource = 'route' | 'bulk' | 'with_price';
