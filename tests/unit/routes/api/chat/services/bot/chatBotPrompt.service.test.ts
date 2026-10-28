import { describe, expect, it } from '@jest/globals';

import {
  buildChatBotPrompt,
  type BuildChatBotPromptDto,
  type ChatBotHistoryMessageDto,
  type ChatBotOrderContextItemDto,
  type ChatBotProductContextItemDto,
} from '@routes/api/chat/services/bot/chatBotPrompt.service.js';
import type { DeliveryMethodInfoDto } from 'types/dto/delivery.dto.js';

const said = (
  senderType: ChatBotHistoryMessageDto['senderType'],
  content: string,
): ChatBotHistoryMessageDto => ({
  senderType,
  content,
  createdAt: new Date('2026-05-01T10:00:00Z'),
});

const product = (
  patch: Partial<ChatBotProductContextItemDto> = {},
): ChatBotProductContextItemDto => ({
  id: 4,
  name: 'Mug',
  price: 9.99,
  categoryName: 'Kitchen',
  description: 'Holds 300 ml',
  popularity: 12,
  sale: null,
  stock: 5,
  ...patch,
});

const order = (patch: Partial<ChatBotOrderContextItemDto> = {}): ChatBotOrderContextItemDto => ({
  id: 12,
  status: 'shipped',
  total: 25.5,
  createdAt: '2026-10-20T10:00:00.000Z',
  paidAt: '2026-10-20T10:05:00.000Z',
  items: [{ name: 'Mug', quantity: 2 }],
  unusual: false,
  delivery: null,
  shipment: null,
  ...patch,
});

// the methods of the shop as the list of the delivery methods gives them
const BY_HAND: DeliveryMethodInfoDto = {
  method: 'manual',
  price: 5,
  freeFrom: 50,
  countries: ['UA', 'PL'],
  address: null,
  hours: null,
};

const PICKUP: DeliveryMethodInfoDto = {
  method: 'pickup',
  price: 0,
  freeFrom: null,
  countries: [],
  address: 'Lichtstrasse 4, Berlin',
  hours: 'Mon-Fri 9-18',
};

const build = (patch: Partial<BuildChatBotPromptDto> = {}) =>
  buildChatBotPrompt({
    actorRole: 'USER',
    emailConfirmed: true,
    userMessage: 'Do you have mugs?',
    history: [],
    productContext: [],
    orders: [],
    currency: 'eur',
    paymentProviders: ['Stripe'],
    delivery: [BY_HAND],
    ...patch,
  });

describe('buildChatBotPrompt', () => {
  it('tells the model a customer with a confirmed email can be transferred to an admin', () => {
    const { instructions } = build({ actorRole: 'USER', emailConfirmed: true });

    expect(instructions).toContain(
      'The current customer is logged in with a confirmed email. If admin help is needed, tell the customer that you can transfer the chat to an admin.',
    );
    expect(instructions).not.toContain('The current customer is a guest');
  });

  // only a person who proved the email talks to an admin: a mistyped address is somebody else
  it('tells the model a customer without a confirmed email has to confirm it before an admin', () => {
    const { instructions } = build({ actorRole: 'USER', emailConfirmed: false });

    expect(instructions).toContain('has not confirmed their email');
    expect(instructions).toContain('Only customers with a confirmed email can talk to an admin');
    expect(instructions).not.toContain('you can transfer the chat to an admin');
  });

  it('tells the model a guest has to log in with a confirmed email before an admin can help', () => {
    const { instructions } = build({ actorRole: 'GUEST', emailConfirmed: false });

    expect(instructions).toContain('The current customer is a guest');
    expect(instructions).toContain('Only customers with a confirmed email can talk to an admin');
    expect(instructions).not.toContain('The current customer is logged in');
  });

  // the code transfers the chat by these fields, so the model must know when to set them
  it('asks the model to decide by meaning, in any language, whether a human admin is needed', () => {
    const { instructions } = build();

    expect(instructions).toContain('reply field');
    expect(instructions).toContain('whatever the language');
    for (const reason of ['DIRECT_ADMIN_REQUEST', 'HUMAN_REQUIRED', 'BOT_CANNOT_HELP', 'NONE']) {
      expect(instructions).toContain(`- ${reason}:`);
    }
    expect(instructions).toContain('escalate is true exactly when reason is not NONE');
  });

  it('tells the model that a word only looking like a request is not one', () => {
    expect(build().instructions).toContain('badminton');
  });

  // the model guessed a currency when it had none
  it('names the shop currency with prices, in upper case', () => {
    const { instructions, messages } = build({ currency: ' eur ', productContext: [product()] });

    expect(instructions).toContain('All prices are in EUR');
    expect(messages[0]?.content).toContain('price: 9.99 EUR;');
  });

  // the model promised paypal when it was not told how the shop takes payments
  it('tells the model that payment is by card on the page of the one provider only', () => {
    const { instructions } = build();

    expect(instructions).toContain(
      'Payment is by card only, on a Stripe payment page the customer opens after confirming the order.',
    );
    expect(instructions).toContain('no PayPal');
  });

  it('names every payment provider as a choice of the customer', () => {
    const { instructions } = build({ paymentProviders: ['Stripe', 'LiqPay'] });

    expect(instructions).toContain(
      'on a payment page of Stripe or LiqPay, the one the customer picks after confirming the order.',
    );
  });

  // the model invented a carrier and a delivery time when it was told nothing of the delivery
  describe('the delivery of the shop', () => {
    it('tells the model the method by hand, its countries, its price and the sum it is free from', () => {
      const { instructions } = build({ delivery: [BY_HAND] });

      expect(instructions).toContain(
        '- by hand: the shop sends the order to an address in UA or PL; the delivery costs 5 EUR, and nothing when the items cost 50 EUR or more.',
      );
      expect(instructions).not.toContain('- pickup:');
    });

    it('tells the model a pickup with its address and hours, and that it costs nothing', () => {
      const { instructions } = build({ delivery: [PICKUP] });

      expect(instructions).toContain(
        '- pickup: the customer collects the order at Lichtstrasse 4, Berlin (Mon-Fri 9-18); it costs nothing.',
      );
      expect(instructions).not.toContain('- by hand:');
    });

    it('names both methods as a choice of the customer', () => {
      const { instructions } = build({ delivery: [BY_HAND, PICKUP] });

      expect(instructions).toContain('the customer picks one when confirming the order');
      expect(instructions).toContain('- by hand:');
      expect(instructions).toContain('- pickup:');
    });

    it('says a delivery that costs nothing costs nothing, without a sum it is free from', () => {
      const { instructions } = build({ delivery: [{ ...BY_HAND, price: 0, freeFrom: null }] });

      expect(instructions).toContain('to an address in UA or PL; the delivery costs nothing.');
    });

    it('forbids naming a method, a country, a price, a carrier or a time that is not given', () => {
      expect(build().instructions).toContain(
        'Name no other delivery method, country, price, carrier or delivery time than these.',
      );
    });
  });

  it('ends with the current message, its sender role and trimmed text', () => {
    const { messages } = build({ actorRole: 'GUEST', userMessage: '  Any mugs?  ' });

    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: 'customer_role: GUEST\ncustomer_message: Any mugs?',
    });
  });

  it('sends only the current message when there is no history and no products', () => {
    expect(build().messages).toHaveLength(1);
  });

  it('turns the bot replies into assistant messages and customer ones into user messages', () => {
    const { messages } = build({
      history: [said('guest', 'hi'), said('bot', 'Hello!'), said('user', ' mugs? ')],
    });

    expect(messages.slice(0, -1)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'mugs?' },
    ]);
  });

  it('leaves out blank history messages', () => {
    const { messages } = build({ history: [said('user', '   '), said('bot', 'Hello!')] });

    expect(messages.slice(0, -1)).toEqual([{ role: 'assistant', content: 'Hello!' }]);
  });

  it('keeps only the last 12 history messages, oldest first', () => {
    const history = Array.from({ length: 15 }, (_, n) => said('user', `message ${n}`));
    const contents = build({ history })
      .messages.slice(0, -1)
      .map((message) => message.content);

    expect(contents).toEqual(Array.from({ length: 12 }, (_, n) => `message ${n + 3}`));
  });

  describe('product context', () => {
    it('comes first, as a developer message with one line per product', () => {
      const first = build({ productContext: [product()] }).messages[0];

      expect(first?.role).toBe('developer');
      expect(first?.content).toContain(
        '- id: 4; name: Mug; price: 9.99 EUR; in stock: 5; category: Kitchen; description: Holds 300 ml; popularity: 12',
      );
    });

    it('lists at most 6 products', () => {
      const productContext = Array.from({ length: 9 }, (_, n) => product({ id: n + 1 }));
      const lines = build({ productContext }).messages[0]?.content.split('\n') ?? [];

      expect(lines.filter((line) => line.startsWith('- id:'))).toHaveLength(6);
    });

    it('says the category is unknown and leaves out an empty description', () => {
      const content = build({
        productContext: [product({ categoryName: null, description: '   ', popularity: null })],
      }).messages[0]?.content;

      expect(content).toContain(
        '- id: 4; name: Mug; price: 9.99 EUR; in stock: 5; category: unknown\n',
      );
    });

    it('keeps a popularity of zero', () => {
      expect(
        build({ productContext: [product({ popularity: 0 })] }).messages[0]?.content,
      ).toContain('popularity: 0');
    });

    it('sends no product message when there are no products', () => {
      expect(build().messages.some((message) => message.role === 'developer')).toBe(false);
    });

    // the buyer pays the sale price; the usual price stays next to it, as the catalog shows it
    it('names the sale price and its end next to the price of a product on sale', () => {
      const content = build({
        productContext: [product({ sale: { price: 7.5, endsAt: '2026-11-01T10:00:00.000Z' } })],
      }).messages[0]?.content;

      expect(content).toContain(
        '- id: 4; name: Mug; price: 9.99 EUR; sale price: 7.5 EUR until 2026-11-01T10:00:00.000Z (UTC); in stock: 5; category: Kitchen',
      );
    });

    // the price a reduction is compared with, the way the card shows it
    it('names the lowest price of the 30 days before a sale', () => {
      const content = build({
        productContext: [
          product({ sale: { price: 7.5, endsAt: '2026-11-01T10:00:00.000Z', priorPrice: 8.99 } }),
        ],
      }).messages[0]?.content;

      expect(content).toContain(
        'sale price: 7.5 EUR until 2026-11-01T10:00:00.000Z (UTC); lowest price of the 30 days before the sale: 8.99 EUR; in stock: 5',
      );
    });

    // the units free to buy now: the stock that confirmed orders do not hold
    it('names the free units of a product, none too', () => {
      expect(build({ productContext: [product({ stock: 0 })] }).messages[0]?.content).toContain(
        'in stock: 0;',
      );
    });

    it('tells the model to promise no more units than are free', () => {
      expect(build().instructions).toContain(
        'in stock is the number of units free to buy now; never promise more of a product',
      );
    });

    it('tells the model a product on sale sells at its sale price until the end of the sale', () => {
      const { instructions } = build();

      expect(instructions).toContain(
        'A product with a sale price sells at the sale price until the end of the sale',
      );
    });
  });

  // where is my order: the bot answered from nothing and invented a status
  describe('orders of the customer', () => {
    it('come after the products as a developer message, one line per order in the given order', () => {
      const { messages } = build({
        productContext: [product()],
        orders: [order(), order({ id: 9, status: 'delivered', items: [] })],
      });

      expect(messages[1]).toEqual({
        role: 'developer',
        content: [
          'Orders of the customer, newest first:',
          '- order 12: shipped (sent, on its way to the customer); total 25.5 EUR; placed 2026-10-20T10:00:00.000Z (UTC); paid 2026-10-20T10:05:00.000Z (UTC); items: Mug x 2',
          '- order 9: delivered (delivered to the customer); total 25.5 EUR; placed 2026-10-20T10:00:00.000Z (UTC); paid 2026-10-20T10:05:00.000Z (UTC); items: none',
          'Use only these orders when the customer asks about an order; never invent an order, a status or a date.',
        ].join('\n'),
      });
    });

    it.each([
      ['unconfirmed', 'not confirmed: the customer has to confirm it again before paying'],
      ['waiting', 'confirmed, waiting for the payment'],
      ['paid', 'paid, being prepared for shipping'],
      ['shipped', 'sent, on its way to the customer'],
      ['delivered', 'delivered to the customer'],
    ] as const)('say what the status %s means', (status, meaning) => {
      const line = build({ orders: [order({ status, paidAt: null })] }).messages[0]!.content;

      expect(line).toContain(`- order 12: ${status} (${meaning}); total 25.5 EUR; placed`);
      expect(line).not.toContain('; paid ');
    });

    // a pickup is not on its way: it waits for the customer
    it.each([
      ['paid', 'paid, being prepared'],
      ['shipped', 'ready, waiting for the customer to collect it'],
      ['delivered', 'collected by the customer'],
    ] as const)('say what the status %s means for a pickup', (status, meaning) => {
      const line = build({
        orders: [
          order({
            status,
            delivery: { method: 'pickup', price: 0, country: null },
          }),
        ],
      }).messages[0]!.content;

      expect(line).toContain(`- order 12: ${status} (${meaning});`);
      expect(line).toContain('delivery: pickup at the shop');
    });

    it('name the delivery by hand with its country and price, not the address', () => {
      const { messages } = build({
        orders: [order({ delivery: { method: 'manual', price: 5, country: 'PL' } })],
      });

      expect(messages[0]!.content).toContain('; delivery: by hand to PL for 5 EUR;');
      expect(messages[0]!.content).not.toMatch(/street|city|phone/i);
    });

    it('name the carrier, the number and the link of the send', () => {
      const { messages } = build({
        orders: [
          order({
            shipment: {
              carrier: 'DHL',
              trackingNumber: 'JD0146',
              trackingUrl: 'https://dhl.example.com/JD0146',
            },
          }),
        ],
      });

      expect(messages[0]!.content).toContain(
        '; send: carrier DHL, tracking number JD0146, tracking link https://dhl.example.com/JD0146;',
      );
    });

    it('name a send without the number, and a send without any detail', () => {
      const partly = build({
        orders: [order({ shipment: { carrier: 'DHL', trackingNumber: null, trackingUrl: null } })],
      }).messages[0]!.content;
      const bare = build({
        orders: [order({ shipment: { carrier: null, trackingNumber: null, trackingUrl: null } })],
      }).messages[0]!.content;

      expect(partly).toContain('; send: carrier DHL;');
      expect(bare).toContain('; send: no carrier or tracking number was given;');
    });

    // an order with a send taken back or a cancellation is for an admin: the bot says nothing of it
    it('leave an unusual order to an admin and say nothing of it', () => {
      const { messages } = build({
        orders: [
          order({
            id: 7,
            status: 'cancelled',
            unusual: true,
            delivery: { method: 'manual', price: 5, country: 'PL' },
            shipment: { carrier: 'DHL', trackingNumber: 'JD0146', trackingUrl: null },
          }),
          order({ id: 8 }),
        ],
      });

      const text = messages[0]!.content;
      expect(text).toContain('- order 7: HUMAN ONLY, an admin handles this order');
      expect(text).not.toContain('order 7: cancelled');
      expect(text).not.toContain('JD0146');
      expect(text).toContain('- order 8: shipped');
      expect(text).toContain(
        'An order marked HUMAN ONLY is for an admin: say nothing of its status, items, delivery or payment, tell the customer that an admin will look into it, and set escalate to true with the reason HUMAN_REQUIRED.',
      );
    });

    it('add the rule of the unusual orders only when there is one', () => {
      const { messages } = build({ orders: [order()] });

      expect(messages[0]!.content).not.toContain('HUMAN ONLY');
    });

    it('name several items of an order', () => {
      const { messages } = build({
        orders: [
          order({
            items: [
              { name: 'Mug', quantity: 2 },
              { name: 'Lamp', quantity: 1 },
            ],
          }),
        ],
      });

      expect(messages[0]!.content).toContain('items: Mug x 2, Lamp x 1');
    });

    it('tell the model a customer without orders has none', () => {
      const { instructions, messages } = build({ orders: [] });

      expect(instructions).toContain('The customer has no orders yet.');
      expect(messages).toHaveLength(1);
    });

    it('tell the model a guest has no orders to look up', () => {
      const { instructions } = build({ actorRole: 'GUEST', emailConfirmed: false, orders: [] });

      expect(instructions).toContain('A guest has no orders; the customer logs in to see them.');
      expect(instructions).not.toContain('The customer has no orders yet.');
    });
  });
});
