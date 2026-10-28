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
};

export type OrderNotice = {
  subject: string;
  heading: string;
  paragraphs: string[];
  details: { label: string; value: string }[];
};

export function orderNoticeOf(kind: OrderNoticeKind, data: OrderNoticeData): OrderNotice {
  const { appName, orderId } = data;

  switch (kind) {
    case 'pickup_ready':
      return {
        subject: `${appName} — Order #${orderId} is ready for pickup`,
        heading: 'Ready for pickup',
        paragraphs: [`Your order #${orderId} is ready. You can collect it at the shop.`],
        details: [{ label: 'Pick up at', value: data.pickup }],
      };

    case 'shipment_changed':
      return {
        subject: `${appName} — The shipping details of order #${orderId} changed`,
        heading: 'Shipping details changed',
        paragraphs: [
          `The shipping details of your order #${orderId} were updated. Please use these from now on.`,
        ],
        details: [
          { label: 'Carrier', value: data.carrier },
          { label: 'Tracking number', value: data.trackingNumber },
          { label: 'Follow your parcel', value: data.trackingUrl },
        ],
      };

    case 'details_changed':
      return {
        subject: `${appName} — The details of order #${orderId} changed`,
        heading: 'Order details changed',
        paragraphs: [
          `The details of your order #${orderId} were changed.`,
          'Ask us in the chat on our site for the details.',
        ],
        details: [],
      };

    case 'delivery_corrected':
      return {
        subject: `${appName} — Order #${orderId}: please ignore our last mail`,
        heading: 'Please ignore our last mail',
        paragraphs: data.pickup
          ? [
              `Sorry, please ignore our previous mail about your order #${orderId}.`,
              'Your order is waiting to be collected.',
            ]
          : [
              `Sorry, please ignore our previous mail about your order #${orderId}.`,
              'The delivery goes on as planned.',
            ],
        details: [{ label: 'Pick up at', value: data.pickup }],
      };

    case 'delivery_data_changed':
      return {
        subject: `${appName} — The delivery details of order #${orderId} changed`,
        heading: 'Delivery details changed',
        paragraphs: [
          `The delivery details of your order #${orderId} were updated. Ask us in the chat on our site if something is wrong.`,
        ],
        details: [
          { label: 'Shipping to', value: data.shippingAddress },
          { label: 'Recipient', value: data.recipient },
        ],
      };
  }
}
