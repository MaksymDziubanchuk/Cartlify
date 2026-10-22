import { describe, expect, it } from '@jest/globals';

import {
  buildChatBotPrompt,
  type BuildChatBotPromptDto,
  type ChatBotHistoryMessageDto,
  type ChatBotProductContextItemDto,
} from '@routes/api/chat/services/bot/chatBotPrompt.service.js';

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

const build = (patch: Partial<BuildChatBotPromptDto> = {}) =>
  buildChatBotPrompt({
    actorRole: 'USER',
    userMessage: 'Do you have mugs?',
    history: [],
    productContext: [],
    currency: 'eur',
    paymentProviders: ['Stripe'],
    ...patch,
  });

describe('buildChatBotPrompt', () => {
  it('tells the model a logged in customer can be transferred to an admin', () => {
    const { instructions } = build({ actorRole: 'USER' });

    expect(instructions).toContain('The current customer is logged in');
    expect(instructions).not.toContain('The current customer is a guest');
  });

  it('tells the model a guest has to log in before an admin can help', () => {
    const { instructions } = build({ actorRole: 'GUEST' });

    expect(instructions).toContain('Guests cannot be transferred to an admin chat');
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
});
