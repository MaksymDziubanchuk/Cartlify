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
  // root sent the money of a refund that failed (of a payment the order could not take, or made by
  // hand in the dashboard of the provider) another way; the line names the lines of the money
  // journal (the work of the system on the money is in the money journal only)
  'payment.refund_outside',
  // root gave an admin the right to handle the money the way root does, or took it away (the line is
  // about the account of the admin)
  'payment.manager_granted',
  'payment.manager_revoked',
  // root said what money given back by hand in the dashboard of the provider, or taken by a bank for
  // a lost dispute, was for: the items and the delivery of the order, the rest a compensation or a
  // loss (with the reason and the rows of statements it paid at once); the line names the line of
  // the money journal
  'payment.money_decision',
  // root gave the buyer a compensation by the button of the app, with the reason; the line names the
  // line of the money journal
  'payment.compensation',
  // root recorded money the buyer gave back outside the app for rows of a statement, or money a
  // carrier paid the shop for a send; the line names the line of the money journal
  'return.money_received',
  'order.carrier_money',
  // money already with the buyer gave the goods of an order more than its statements took: root
  // recorded what the buyer gave back of it, gave it up (with the reason), or kept goods not
  // accepted that were still in the shop (with the reason and the rows paid at once)
  'return.overpaid_received',
  'return.overpaid_lost',
  'return.goods_kept',
  // root decided on what holds a paid order from its sending and is root's to let go (a refund made
  // by hand of part of it, an early warning of fraud): send it, or cancel it (the statement of the
  // cancel with it), with the reason
  'order.hold_decide',
  // a statement of withdrawal or of return: made, its goods taken in, the proof of the buyer
  // confirmed, a transfer of its money started by an admin or root (with the lines of the money
  // journal), money sent outside the app, rows closed without a refund
  'return.create',
  'return.receive',
  'return.proof_confirm',
  'return.accept',
  // the buyer wrote how they sent the goods back
  'return.proof_provide',
  // units of a statement went into a new statement of their own, sent in a parcel of their own
  'return.split',
  'return.refund',
  'return.refund_outside',
  // root lowered what rows of a statement give back, with the reason
  'return.amount_lower',
  'return.close',
  // a parcel of a statement recorded (back to the shop, or goods not accepted sent back to the
  // buyer), its cost written
  'return.shipment_record',
  'return.shipment_cost',
  'return.buyer_paid',
  // a change of a send (the details mailed to the buyer, or the cost the shop pays the carrier), of
  // the delivery data
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

// the money journal (db/05, money_log): what moved the money. A line is written by a function of the
// database in the same transaction that changed the state next to it; the sum is signed, above 0
// comes to the shop and below 0 goes from it
export const MONEY_LOG_EVENTS = [
  // the payment of an order, in two lines of one payment (the goods, the delivery); a payment the
  // order could not take and the shop sends back
  'money.payment',
  'money.late_payment',
  // a refund asked of the provider (in transit, then sent) of a statement, a late payment or made by
  // hand in the dashboard of the provider; its failure is a new line with the opposite sum
  'money.refund',
  'money.refund_failed',
  // money sent to the buyer outside the app, and the way back root paid the buyer outside the app
  'money.outside',
  // what the shop paid a carrier: the parcel back of a statement, the send of an order
  'money.return_parcel_cost',
  'money.shipping_cost',
  // what the bank took for a dispute and gave back
  'money.dispute_withdrawn',
  'money.dispute_reinstated',
  // the correction of a sum a person wrote: a new line with the difference
  'money.correction',
  // money the shop got back outside the app: from the buyer for rows of a statement or of what is
  // overpaid, from a carrier for a send of an order
  'money.received',
  // root gave up what a share of money already with the buyer had left: a compensation, a loss (it
  // moves no money, the sum is in the meta)
  'money.share_moved',
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
