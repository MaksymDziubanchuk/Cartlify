import { describe, expect, it } from '@jest/globals';

import {
  buildChatBotPrompt,
  MAX_VARIANTS_PER_PRODUCT,
  type BuildChatBotPromptDto,
  type ChatBotHistoryMessageDto,
  type ChatBotOrderContextItemDto,
  type ChatBotProductContextItemDto,
  type ChatBotReturnContextItemDto,
  type ChatBotVariantContextItemDto,
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

const variant = (
  patch: Partial<ChatBotVariantContextItemDto> = {},
): ChatBotVariantContextItemDto => ({
  id: 7,
  name: 'Mug',
  price: 9.99,
  sale: null,
  stock: 5,
  ...patch,
});

const product = (
  patch: Partial<ChatBotProductContextItemDto> = {},
): ChatBotProductContextItemDto => ({
  id: 4,
  name: 'Mug',
  categoryName: 'Kitchen',
  description: 'Holds 300 ml',
  popularity: 12,
  variants: [variant()],
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
  returnStatus: 'none',
  withdrawal: null,
  returns: [],
  delivery: null,
  shipment: null,
  ...patch,
});

// a statement the way the buyer sees it: the units of one row, the step, the money
const statement = (
  patch: Partial<ChatBotReturnContextItemDto> = {},
): ChatBotReturnContextItemDto => ({
  id: 31,
  statedAt: '2026-10-25T08:00:00.000Z',
  step: 'received',
  items: [row()],
  ...patch,
});

const row = (
  patch: Partial<ChatBotReturnContextItemDto['items'][number]> = {},
): ChatBotReturnContextItemDto['items'][number] => ({
  quantity: 1,
  amount: 12.75,
  deliveryAmount: 0,
  money: 'not_refunded',
  refundedAt: null,
  refusal: null,
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
    const { instructions } = build({ paymentProviders: ['Stripe', 'Adyen'] });

    expect(instructions).toContain(
      'on a payment page of Stripe or Adyen, the one the customer picks after confirming the order.',
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
    it('comes first, as a developer message with a line for each product and one for each variant of it', () => {
      const first = build({ productContext: [product()] }).messages[0];

      expect(first?.role).toBe('developer');
      expect(first?.content).toContain(
        [
          '- product id: 4; name: Mug; category: Kitchen; description: Holds 300 ml; popularity: 12',
          '  variants:',
          '  - variant id: 7; name: Mug; price: 9.99 EUR; in stock: 5',
        ].join('\n'),
      );
    });

    it('names every variant of a product with its own name, price and free units', () => {
      const content = build({
        productContext: [
          product({
            variants: [
              variant({ id: 7, name: 'Mug, white', price: 9.99, stock: 5 }),
              variant({ id: 8, name: 'Mug, black', price: 11.5, stock: 2 }),
            ],
          }),
        ],
      }).messages[0]?.content;

      expect(content).toContain(
        '  - variant id: 7; name: Mug, white; price: 9.99 EUR; in stock: 5\n',
      );
      expect(content).toContain(
        '  - variant id: 8; name: Mug, black; price: 11.5 EUR; in stock: 2',
      );
    });

    it('lists at most 6 products', () => {
      const productContext = Array.from({ length: 9 }, (_, n) => product({ id: n + 1 }));
      const lines = build({ productContext }).messages[0]?.content.split('\n') ?? [];

      expect(lines.filter((line) => line.startsWith('- product id:'))).toHaveLength(6);
    });

    it('says the category is unknown and leaves out an empty description', () => {
      const content = build({
        productContext: [product({ categoryName: null, description: '   ', popularity: null })],
      }).messages[0]?.content;

      expect(content).toContain('- product id: 4; name: Mug; category: unknown\n  variants:\n');
    });

    it('keeps a popularity of zero', () => {
      expect(
        build({ productContext: [product({ popularity: 0 })] }).messages[0]?.content,
      ).toContain('popularity: 0');
    });

    // a description is a paid input of every turn, and an admin can write a long one
    it('cuts a long description', () => {
      const content = build({
        productContext: [product({ description: 'x'.repeat(2000) })],
      }).messages[0]?.content;

      expect(content).toContain(`description: ${'x'.repeat(500)}...;`);
      expect(content).not.toContain('x'.repeat(501));
    });

    it('sends no product message when there are no products', () => {
      expect(build().messages.some((message) => message.role === 'developer')).toBe(false);
    });

    // the buyer pays the sale price; the usual price stays next to it, as the catalog shows it
    it('names the sale price and its end next to the price of a variant on sale', () => {
      const content = build({
        productContext: [
          product({
            variants: [variant({ sale: { price: 7.5, endsAt: '2026-11-01T10:00:00.000Z' } })],
          }),
        ],
      }).messages[0]?.content;

      expect(content).toContain(
        '  - variant id: 7; name: Mug; price: 9.99 EUR; sale price: 7.5 EUR until 2026-11-01T10:00:00.000Z (UTC); in stock: 5',
      );
    });

    // the sale is the variant's: its neighbour sells at the price
    it('names a sale on the variant that has it, not on the others of its product', () => {
      const content = build({
        productContext: [
          product({
            variants: [
              variant({ id: 7, sale: { price: 7.5, endsAt: '2026-11-01T10:00:00.000Z' } }),
              variant({ id: 8 }),
            ],
          }),
        ],
      }).messages[0]?.content;

      expect(content).toContain('variant id: 7; name: Mug; price: 9.99 EUR; sale price: 7.5 EUR');
      expect(content).toContain('  - variant id: 8; name: Mug; price: 9.99 EUR; in stock: 5');
    });

    // the price a reduction is compared with, the way the card shows it
    it('names the lowest price of the 30 days before a sale', () => {
      const content = build({
        productContext: [
          product({
            variants: [
              variant({
                sale: { price: 7.5, endsAt: '2026-11-01T10:00:00.000Z', priorPrice: 8.99 },
              }),
            ],
          }),
        ],
      }).messages[0]?.content;

      expect(content).toContain(
        'sale price: 7.5 EUR until 2026-11-01T10:00:00.000Z (UTC); lowest price of the 30 days before the sale: 8.99 EUR; in stock: 5',
      );
    });

    // the units free to buy now: the stock that confirmed orders do not hold
    it('names the free units of a variant, none too', () => {
      expect(
        build({ productContext: [product({ variants: [variant({ stock: 0 })] })] }).messages[0]
          ?.content,
      ).toContain('in stock: 0');
    });

    it('tells the model to promise no more units than are free', () => {
      expect(build().instructions).toContain(
        'in stock is the number of units of the variant free to buy now; never promise more of a variant',
      );
    });

    it('tells the model a variant on sale sells at its sale price until the end of the sale', () => {
      const { instructions } = build();

      expect(instructions).toContain(
        'A variant with a sale price sells at the sale price until the end of the sale',
      );
    });

    // the customer buys a variant: the answer names one, one that is listed and in stock
    it('tells the model to recommend a concrete variant that is listed and in stock', () => {
      const { instructions, messages } = build({ productContext: [product()] });

      expect(instructions).toContain('the customer buys a variant');
      expect(instructions).toContain('name a concrete variant by its name and its price');
      expect(instructions).toContain('recommend only a variant that is listed and in stock');
      expect(messages[0]?.content).toContain(
        'Use only this product context when recommending specific products and variants.',
      );
    });

    describe('a product with many variants', () => {
      const many = (
        count: number,
        over: (n: number) => Partial<ChatBotVariantContextItemDto> = () => ({}),
      ) =>
        Array.from({ length: count }, (_, n) =>
          variant({ id: 100 + n, name: `Mug ${n + 1}`, price: 10 + n, ...over(n) }),
        );

      const variantLines = (lines: string) =>
        lines.split('\n').filter((line) => line.startsWith('  - variant id:'));

      it('names up to 20 of its variants one by one', () => {
        const content = build({
          productContext: [product({ variants: many(MAX_VARIANTS_PER_PRODUCT) })],
        }).messages[0]!.content;

        expect(MAX_VARIANTS_PER_PRODUCT).toBe(20);
        expect(variantLines(content)).toHaveLength(20);
        expect(content).not.toContain('more variants');
      });

      it('names the first 20 and sums up the rest: how many, how many are in stock, the prices', () => {
        const content = build({
          productContext: [product({ variants: many(25) })],
        }).messages[0]!.content;

        // 25 variants of 10 to 34 EUR: the last 5 are left out
        expect(variantLines(content).map((line) => /variant id: (\d+)/.exec(line)![1])).toEqual(
          Array.from({ length: 20 }, (_, n) => String(100 + n)),
        );
        expect(content).toContain(
          '  - 5 more variants are not listed (5 of them in stock), they sell at 30 to 34 EUR; name no detail of them',
        );
      });

      // a customer asks for what is there: the variants with free units come first
      it('names the variants with free units before the sold out ones when it has to leave some out', () => {
        const content = build({
          productContext: [product({ variants: many(25, (n) => ({ stock: n < 10 ? 0 : 3 })) })],
        }).messages[0]!.content;

        const named = variantLines(content).map((line) =>
          Number(/variant id: (\d+)/.exec(line)![1]),
        );
        // the 15 with units (ids 110 to 124) and then the first 5 sold out ones (100 to 104)
        expect(named).toEqual([
          ...Array.from({ length: 15 }, (_, n) => 110 + n),
          ...Array.from({ length: 5 }, (_, n) => 100 + n),
        ]);
        expect(content).toContain('5 more variants are not listed (0 of them in stock)');
        // none of the sold out ones that are left out is named
        expect(content).not.toContain('variant id: 105;');
      });

      it('sums up the rest at the sale price while a sale lasts', () => {
        const content = build({
          productContext: [
            product({
              variants: [
                ...many(20),
                variant({
                  id: 200,
                  price: 50,
                  sale: { price: 5, endsAt: '2026-11-01T10:00:00.000Z' },
                }),
                variant({ id: 201, price: 60 }),
              ],
            }),
          ],
        }).messages[0]!.content;

        expect(content).toContain(
          '2 more variants are not listed (2 of them in stock), they sell at 5 to 60 EUR',
        );
      });

      it('lists the variants of each product apart', () => {
        const content = build({
          productContext: [
            product({ id: 4, variants: many(22) }),
            product({ id: 5, variants: [variant({ id: 900 })] }),
          ],
        }).messages[0]!.content;

        expect(content).toContain('- product id: 5;');
        expect(content).toContain('  - variant id: 900;');
        expect(content).toContain('2 more variants are not listed');
      });
    });
  });

  // where is my order: the bot answered from nothing and invented a status
  describe('orders of the customer', () => {
    it('come after the products as a developer message, one line per order in the given order', () => {
      const { messages } = build({
        productContext: [product()],
        orders: [order(), order({ id: 9, status: 'delivered', items: [] })],
      });

      expect(messages[1]!.role).toBe('developer');
      const lines = messages[1]!.content.split('\n');
      expect(lines.slice(0, 4)).toEqual([
        'Orders of the customer, newest first:',
        '- order 12: shipped (sent, on its way to the customer); total 25.5 EUR; placed 2026-10-20T10:00:00.000Z (UTC); paid 2026-10-20T10:05:00.000Z (UTC); items: Mug x 2',
        '- order 9: delivered (delivered to the customer); total 25.5 EUR; placed 2026-10-20T10:00:00.000Z (UTC); paid 2026-10-20T10:05:00.000Z (UTC); items: none',
        'Use only these orders when the customer asks about an order; never invent an order, a status or a date.',
      ]);
      // the rules of the returns close the message: one line, nothing after it
      expect(lines).toHaveLength(5);
      expect(lines[4]).toContain('Withdraw from the contract here');
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

    // an order with a send or a step taken back, or a transfer of return money that failed or was
    // disputed, is for an admin: the bot says nothing of it
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

    // the returns of an unusual order are the admin's too: not a word of them reaches the model
    it('say nothing of the returns of an unusual order either', () => {
      const text = build({
        orders: [
          order({
            id: 7,
            unusual: true,
            returnStatus: 'open',
            withdrawal: {
              open: true,
              endsAt: null,
              free: [{ name: 'Mug', quantity: 1 }],
              noRight: [],
            },
            returns: [statement({ items: [row({ money: 'refunded' })] })],
          }),
        ],
      }).messages[0]!.content;

      // the line of the order is all it says of it
      expect(text.split('\n')[1]).toBe('- order 7: HUMAN ONLY, an admin handles this order');
      expect(text).not.toMatch(/withdrawal:|returns:|statement 31|refunded \d/);
    });

    // a cancellation is no event for an admin: the money goes back to the card, and the bot says so
    it('tell the model a cancelled order is cancelled and its money goes back to the card', () => {
      const text = build({ orders: [order({ status: 'cancelled' })] }).messages[0]!.content;

      expect(text).toContain(
        '- order 12: cancelled (cancelled, the money goes back to the card); total 25.5 EUR;',
      );
      expect(text).not.toContain('by the shop');
      expect(text).not.toContain('HUMAN ONLY');
    });

    // a cancelled pickup has no collect meaning: it is cancelled like any other order
    it('tell the model a cancelled pickup is cancelled, not waiting to be collected', () => {
      const text = build({
        orders: [
          order({ status: 'cancelled', delivery: { method: 'pickup', price: 0, country: null } }),
        ],
      }).messages[0]!.content;

      expect(text).toContain('- order 12: cancelled (cancelled, the money goes back to the card);');
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

  // can I send it back, until when, where is my money: the bot answered from nothing and promised
  describe('the returns of an order', () => {
    const linesOf = (patch: Partial<ChatBotOrderContextItemDto>) =>
      build({ orders: [order(patch)] }).messages[0]!.content.split('\n');

    // the one line of the order (the first is the heading)
    const lineOf = (patch: Partial<ChatBotOrderContextItemDto>) => linesOf(patch)[1]!;

    describe('the withdrawal', () => {
      // the period of a sent order has not started: it starts with the delivery
      it('is open before the delivery, with no end date', () => {
        const line = lineOf({
          withdrawal: {
            open: true,
            endsAt: null,
            free: [{ name: 'Mug', quantity: 2 }],
            noRight: [],
          },
        });

        expect(line).toContain(
          '; withdrawal: the customer may still withdraw from the contract for Mug x 2, the period starts with the delivery',
        );
        expect(line).not.toContain('until');
      });

      it('is open until the end date, for the free units by name', () => {
        const line = lineOf({
          status: 'delivered',
          withdrawal: {
            open: true,
            endsAt: '2026-11-04T22:59:59.999Z',
            free: [
              { name: 'Mug', quantity: 1 },
              { name: 'Lamp, white', quantity: 2 },
            ],
            noRight: [],
          },
        });

        expect(line).toContain(
          '; withdrawal: the customer may still withdraw from the contract for Mug x 1, Lamp, white x 2, until 2026-11-04T22:59:59.999Z (UTC)',
        );
        expect(line).not.toContain('the period starts with the delivery');
      });

      // past the end of the contract the shop forgives a few days: the bot tells the date that
      // passed and that a statement is still taken, not a date to come
      it('says the contract ended and a statement is still taken in the days of grace', () => {
        const line = lineOf({
          status: 'delivered',
          withdrawal: {
            open: true,
            endsAt: '2026-11-04T22:59:59.999Z',
            late: true,
            free: [{ name: 'Mug', quantity: 1 }],
            noRight: [],
          },
        });

        expect(line).toContain(
          '; withdrawal: the customer may still withdraw from the contract for Mug x 1, the period of the contract ended 2026-11-04T22:59:59.999Z (UTC), the shop still takes a statement for now',
        );
        expect(line).not.toContain('until 2026-11-04');
      });

      // the period is open but there is nothing to state: the units are in statements already
      it('says every unit is in a statement when none is left to state', () => {
        const line = lineOf({
          status: 'delivered',
          withdrawal: { open: true, endsAt: '2026-11-04T22:59:59.999Z', free: [], noRight: [] },
        });

        expect(line).toContain(
          '; withdrawal: every unit is already in a statement, nothing is left to state',
        );
        expect(line).not.toContain('may still withdraw');
      });

      // goods the law gives no right of withdrawal for are not "already stated": nothing can be
      it('says the goods have no right of withdrawal when every item lacks it', () => {
        const line = lineOf({
          status: 'paid',
          items: [{ name: 'Fresh bread', quantity: 2 }],
          withdrawal: { open: true, endsAt: null, free: [], noRight: ['Fresh bread'] },
        });

        expect(line).toContain(
          '; withdrawal: the goods of this order have no right of withdrawal (Fresh bread)',
        );
        expect(line).not.toContain('already in a statement');
        expect(line).not.toContain('may still withdraw');
      });

      it('names the items without the right next to the units that can be stated', () => {
        const line = lineOf({
          status: 'paid',
          items: [
            { name: 'Mug', quantity: 1 },
            { name: 'Fresh bread', quantity: 2 },
          ],
          withdrawal: {
            open: true,
            endsAt: null,
            free: [{ name: 'Mug', quantity: 1 }],
            noRight: ['Fresh bread'],
          },
        });

        expect(line).toContain('may still withdraw from the contract for Mug x 1');
        expect(line).toContain('; no right of withdrawal for Fresh bread');
      });

      it('says every unit that can be withdrawn from is stated, and names the items without the right', () => {
        const line = lineOf({
          status: 'delivered',
          items: [
            { name: 'Mug', quantity: 1 },
            { name: 'Fresh bread', quantity: 2 },
          ],
          withdrawal: {
            open: true,
            endsAt: '2026-11-04T22:59:59.999Z',
            free: [],
            noRight: ['Fresh bread'],
          },
        });

        expect(line).toContain(
          '; withdrawal: every unit that can be withdrawn from is already in a statement, nothing is left to state; no right of withdrawal for Fresh bread',
        );
      });

      it('says the period is over, with the day it ended', () => {
        const line = lineOf({
          status: 'delivered',
          withdrawal: { open: false, endsAt: '2026-10-20T22:59:59.999Z', free: [], noRight: [] },
        });

        expect(line).toContain(
          '; withdrawal: the period is over (it ended 2026-10-20T22:59:59.999Z UTC)',
        );
        expect(line).not.toContain('may still withdraw');
        expect(line).not.toContain('nothing is left to state');
      });

      it('says the period is over without a day when it has none', () => {
        const line = lineOf({ withdrawal: { open: false, endsAt: null, free: [], noRight: [] } });

        expect(line).toContain('; withdrawal: the period is over');
        expect(line).not.toContain('it ended');
      });

      // an order not paid, not sent or cancelled has nothing to withdraw from: not a word of it
      it('is not mentioned for an order that cannot be withdrawn from', () => {
        const text = build({
          orders: [
            order({ id: 1, status: 'waiting', paidAt: null }),
            order({ id: 2, status: 'cancelled' }),
          ],
        }).messages[0]!.content;

        expect(text).not.toContain('withdrawal:');
      });
    });

    describe('the state of the order', () => {
      it.each([
        ['open', 'a statement of withdrawal or return is open, no money went back yet'],
        ['open_partial', 'a statement is open and part of the money went back'],
        ['partial', 'all statements are closed and part of the money went back'],
        ['full', 'all statements are closed and all the money went back'],
        ['declined', 'all statements are closed and no money went back'],
      ] as const)('says what the return status %s means', (returnStatus, meaning) => {
        expect(lineOf({ returnStatus })).toContain(`; returns: ${meaning}`);
      });

      it('says nothing of the returns of an order that has none', () => {
        const line = lineOf({ returnStatus: 'none' });

        expect(line).not.toContain('returns:');
        expect(line).not.toContain('statement');
      });
    });

    describe('a statement', () => {
      it.each([
        ['received', 'registered'],
        ['proof_provided', 'the customer told of the parcel, the shop has not confirmed it yet'],
        ['proof_confirmed', 'the shop confirmed the parcel'],
        ['closed', 'closed'],
      ] as const)(
        'says what the step %s means, with its number and the day it was stated',
        (step, meaning) => {
          expect(lineOf({ returnStatus: 'open', returns: [statement({ step })] })).toContain(
            `; statement 31 (stated 2026-10-25T08:00:00.000Z UTC): ${meaning}; money: `,
          );
        },
      );

      it('names every statement of the order, oldest first as given', () => {
        const lines = linesOf({
          returnStatus: 'open',
          returns: [
            statement({ id: 31, step: 'closed' }),
            statement({ id: 35, statedAt: '2026-10-27T09:00:00.000Z', step: 'received' }),
          ],
        });

        const text = lines[1]!;
        expect(text.indexOf('statement 31')).toBeGreaterThan(-1);
        expect(text.indexOf('statement 35 (stated 2026-10-27T09:00:00.000Z UTC)')).toBeGreaterThan(
          text.indexOf('statement 31'),
        );
      });

      it('goes after the state of the order and the withdrawal', () => {
        const line = lineOf({
          returnStatus: 'open',
          withdrawal: {
            open: true,
            endsAt: null,
            free: [{ name: 'Mug', quantity: 1 }],
            noRight: [],
          },
          returns: [statement()],
        });

        expect(line.indexOf('; withdrawal:')).toBeGreaterThan(line.indexOf('items: Mug x 2'));
        expect(line.indexOf('; returns:')).toBeGreaterThan(line.indexOf('; withdrawal:'));
        expect(line.indexOf('; statement 31')).toBeGreaterThan(line.indexOf('; returns:'));
      });
    });

    describe('the money of a statement', () => {
      const moneyOf = (items: ChatBotReturnContextItemDto['items']) =>
        lineOf({ returnStatus: 'open', returns: [statement({ items })] });

      it('says the money went back, with the sum, the units and the day', () => {
        expect(
          moneyOf([
            row({
              quantity: 2,
              amount: 25.5,
              money: 'refunded',
              refundedAt: '2026-10-29T12:30:00.000Z',
            }),
          ]),
        ).toContain('money: refunded 25.5 EUR for 2 unit(s) on 2026-10-29T12:30:00.000Z (UTC)');
      });

      it('adds the share of the delivery to the sum of a row', () => {
        expect(
          moneyOf([
            row({
              amount: 20,
              deliveryAmount: 5,
              money: 'refunded',
              refundedAt: '2026-10-29T12:30:00.000Z',
            }),
          ]),
        ).toContain('refunded 25 EUR for 1 unit(s)');
      });

      it('sums the rows to the cent and names the last day when they went back on different days', () => {
        const text = moneyOf([
          row({ amount: 0.1, money: 'refunded', refundedAt: '2026-10-30T09:00:00.000Z' }),
          row({ amount: 0.2, money: 'refunded', refundedAt: '2026-10-29T09:00:00.000Z' }),
        ]);

        expect(text).toContain('refunded 0.3 EUR for 2 unit(s) on 2026-10-30T09:00:00.000Z (UTC)');
      });

      it('says the money is on its way to the card when the provider has not answered', () => {
        const text = moneyOf([row({ amount: 12.75, money: 'pending' })]);

        expect(text).toContain('money: 12.75 EUR for 1 unit(s) is on its way to the card');
        expect(text).not.toContain('refunded');
      });

      it('says the money is not refunded yet', () => {
        expect(moneyOf([row({ quantity: 3, amount: 38.25, money: 'not_refunded' })])).toContain(
          'money: 38.25 EUR for 3 unit(s) is not refunded yet',
        );
      });

      it('says the money was refused, with the reason in words of the customer for goods that never came', () => {
        expect(
          moneyOf([row({ amount: 12.75, money: 'refused', refusal: 'not_arrived' })]),
        ).toContain('money: 12.75 EUR for 1 unit(s) is refused (the goods never arrived)');
      });

      it('says the money was refused, with the reason the shop gave', () => {
        expect(moneyOf([row({ amount: 12.75, money: 'refused', refusal: 'damaged' })])).toContain(
          'money: 12.75 EUR for 1 unit(s) is refused (damaged)',
        );
      });

      it('names every reason once when several rows were refused for the same or other reasons', () => {
        const text = moneyOf([
          row({ money: 'refused', refusal: 'used' }),
          row({ money: 'refused', refusal: 'used' }),
          row({ money: 'refused', refusal: 'not_arrived' }),
        ]);

        expect(text).toContain(
          'money: 38.25 EUR for 3 unit(s) is refused (used, the goods never arrived)',
        );
      });

      // the bot does not know why the shop refused, so it does not make one up
      it('names no reason when the row has none', () => {
        const text = moneyOf([row({ money: 'refused', refusal: null })]);

        expect(text).toMatch(/unit\(s\) is refused$/m);
        expect(text).not.toContain('by the shop');
      });

      // a statement of two rows with two fates: each fate is a part of the line, in a fixed order
      it('gives a part for each state of the rows of one statement', () => {
        const text = moneyOf([
          row({ money: 'refused', refusal: 'not_arrived' }),
          row({ money: 'not_refunded' }),
          row({ money: 'pending' }),
          row({ money: 'refunded', refundedAt: '2026-10-29T12:30:00.000Z' }),
        ]);

        expect(text).toContain(
          'money: refunded 12.75 EUR for 1 unit(s) on 2026-10-29T12:30:00.000Z (UTC); ' +
            '12.75 EUR for 1 unit(s) is on its way to the card; ' +
            '12.75 EUR for 1 unit(s) is not refunded yet; ' +
            '12.75 EUR for 1 unit(s) is refused (the goods never arrived)',
        );
      });

      it('names the money in the currency of the shop, in upper case', () => {
        const text = build({
          currency: ' usd ',
          orders: [
            order({
              returnStatus: 'open',
              returns: [statement({ items: [row({ money: 'not_refunded' })] })],
            }),
          ],
        }).messages[0]!.content;

        expect(text).toContain('12.75 USD for 1 unit(s) is not refunded yet');
      });
    });

    // the bot knows where the money is, not what the shop does with the goods
    describe('the goods', () => {
      it('are not in the context: nothing of what became of them reaches the model', () => {
        // a row that carried the outcome of the goods anyway must not leak it into the prompt
        const leaky = {
          ...row({ money: 'refunded', refundedAt: '2026-10-29T12:30:00.000Z' }),
          goods: 'to_stock',
          notAcceptedReason: 'unsealed',
        } as ChatBotReturnContextItemDto['items'][number];
        const { instructions, messages } = build({
          orders: [
            order({
              returnStatus: 'full',
              returns: [
                statement({ step: 'closed', items: [leaky] }),
                statement({
                  id: 32,
                  items: [row({ money: 'refused', refusal: 'not_arrived' })],
                }),
              ],
            }),
          ],
        });

        const everything = [instructions, ...messages.map((message) => message.content)].join('\n');
        expect(everything).not.toMatch(
          /to_stock|written_off|not_accepted|unsealed|shelf|restock|put back/i,
        );
      });
    });

    // spec 10.2 and 10.3: the bot files nothing and promises nothing, it points to the button
    describe('the rules for the model', () => {
      const RULES_MARK = 'You cannot file a withdrawal or a return';

      it('end the message of the orders with the button of the website', () => {
        const lines = build({ orders: [order()] }).messages[0]!.content.split('\n');
        const rule = lines.at(-1)!;

        expect(rule).toContain(RULES_MARK);
        expect(rule).toContain('you never promise that one will be accepted or refunded');
        expect(rule).toContain('uses the button "Withdraw from the contract here" in the order');
        expect(rule).toContain('a function of the website; point to it');
      });

      it('tell the model to say only what the data of the order tells', () => {
        const rule = build({ orders: [order()] }).messages[0]!.content;

        expect(rule).toContain(
          'whether the customer may still withdraw, until when, for how many units, and where the money is',
        );
      });

      // the bot does not know what the shop does with the goods, and why a cancellation was made
      it('tell the model it does not know what the shop does with the goods or why an order was cancelled', () => {
        const rule = build({ orders: [order()] }).messages[0]!.content;

        expect(rule).toContain(
          'You do not know what the shop does with the goods after the customer sends them, or why an order was cancelled; say so.',
        );
      });

      it('come with the rule of the unusual orders when there is one, and without it when there is none', () => {
        const plain = build({ orders: [order()] }).messages[0]!.content;
        const unusual = build({ orders: [order(), order({ id: 7, unusual: true })] }).messages[0]!
          .content;

        expect(plain).toContain(RULES_MARK);
        expect(plain).not.toContain('HUMAN ONLY');
        expect(unusual).toContain(RULES_MARK);
        expect(unusual).toContain('An order marked HUMAN ONLY is for an admin');
      });

      it('are not sent when the customer has no orders', () => {
        const { instructions, messages } = build({ orders: [] });

        expect(
          messages.some((message) => message.content.includes('Withdraw from the contract here')),
        ).toBe(false);
        expect(instructions).not.toContain('Withdraw from the contract here');
      });

      // the line of the order is data, the rules are said once for all the orders
      it('are said once, whatever the number of orders', () => {
        const text = build({ orders: [order({ id: 1 }), order({ id: 2 }), order({ id: 3 })] })
          .messages[0]!.content;

        expect(text.split(RULES_MARK)).toHaveLength(2);
      });
    });
  });
});
