import { t } from '@config/i18n.js';

// the mails of an event of an order that show no items: what each says to the buyer. A step of the
// status taken back and a correction of the data say nothing of the reason: the admin explains it
// to the buyer himself in the chat

export type OrderNoticeKind =
  | 'pickup_ready'
  | 'shipment_changed'
  | 'details_changed'
  | 'delivery_corrected'
  | 'delivery_data_changed';

// the name of a mail in the log: "order <label> mail was not sent"
export const ORDER_NOTICE_LABELS: Record<OrderNoticeKind, string> = {
  pickup_ready: 'pickup ready',
  shipment_changed: 'shipment changed',
  details_changed: 'details changed',
  delivery_corrected: 'delivery corrected',
  delivery_data_changed: 'delivery data changed',
};

// what the text of a mail may name
export type OrderNoticeData = {
  appName: string;
  orderId: number;
  // where and when to collect the order, a pickup only
  pickup: string;
  // the send on its way, as the buyer sees it
  carrier: string;
  trackingNumber: string;
  trackingUrl: string;
  // where and to whom the order goes now
  recipient: string;
  shippingAddress: string;
  // the language of the mail (mailLocaleOf), "en" unless given
  locale?: string;
};

export type OrderNotice = {
  subject: string;
  heading: string;
  paragraphs: string[];
  details: { label: string; value: string }[];
};

export function orderNoticeOf(kind: OrderNoticeKind, data: OrderNoticeData): OrderNotice {
  const { appName, orderId } = data;
  const locale = data.locale || 'en';
  const vars = { appName, orderId };

  switch (kind) {
    case 'pickup_ready':
      return {
        subject: t('orderNotice.pickupReadySubject', locale, vars),
        heading: t('orderNotice.pickupReadyHeading', locale),
        paragraphs: [t('orderNotice.pickupReadyBody', locale, vars)],
        details: [{ label: t('orderNotice.pickupAtLabel', locale), value: data.pickup }],
      };

    case 'shipment_changed':
      return {
        subject: t('orderNotice.shipmentChangedSubject', locale, vars),
        heading: t('orderNotice.shipmentChangedHeading', locale),
        paragraphs: [t('orderNotice.shipmentChangedBody', locale, vars)],
        details: [
          { label: t('orderNotice.carrierLabel', locale), value: data.carrier },
          { label: t('orderNotice.trackingNumberLabel', locale), value: data.trackingNumber },
          { label: t('orderNotice.followParcelLabel', locale), value: data.trackingUrl },
        ],
      };

    case 'details_changed':
      return {
        subject: t('orderNotice.detailsChangedSubject', locale, vars),
        heading: t('orderNotice.detailsChangedHeading', locale),
        paragraphs: [
          t('orderNotice.detailsChangedBody', locale, vars),
          t('orderNotice.askInChat', locale),
        ],
        details: [],
      };

    case 'delivery_corrected':
      return {
        subject: t('orderNotice.deliveryCorrectedSubject', locale, vars),
        heading: t('orderNotice.deliveryCorrectedHeading', locale),
        paragraphs: [
          t('orderNotice.deliveryCorrectedBody', locale, vars),
          data.pickup
            ? t('orderNotice.waitingForPickup', locale)
            : t('orderNotice.deliveryAsPlanned', locale),
        ],
        details: [{ label: t('orderNotice.pickupAtLabel', locale), value: data.pickup }],
      };

    case 'delivery_data_changed':
      return {
        subject: t('orderNotice.deliveryDataChangedSubject', locale, vars),
        heading: t('orderNotice.deliveryDataChangedHeading', locale),
        paragraphs: [t('orderNotice.deliveryDataChangedBody', locale, vars)],
        details: [
          { label: t('orderNotice.shippingToLabel', locale), value: data.shippingAddress },
          { label: t('common.recipientLabel', locale), value: data.recipient },
        ],
      };
  }
}
