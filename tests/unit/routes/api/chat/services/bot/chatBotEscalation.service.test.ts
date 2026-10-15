import { describe, expect, it } from '@jest/globals';

import { evaluateChatBotEscalation } from '@routes/api/chat/services/bot/chatBotEscalation.service.js';

import type { ChatBotHistoryMessageDto } from '@routes/api/chat/services/bot/chatBotPrompt.service.js';

const said = (
  senderType: ChatBotHistoryMessageDto['senderType'],
  content: string,
): ChatBotHistoryMessageDto => ({
  senderType,
  content,
  createdAt: new Date('2026-05-01T10:00:00Z'),
});

const evaluate = (
  userMessage: string,
  botMessage = 'Here is what I found.',
  history: ChatBotHistoryMessageDto[] = [],
) => evaluateChatBotEscalation({ userMessage, botMessage, history });

describe('evaluateChatBotEscalation', () => {
  it('does not escalate an ordinary shopping question', () => {
    expect(evaluate('Do you have red mugs?')).toEqual({
      shouldEscalate: false,
      reason: 'NONE',
      confidence: 0,
      matchedPhrase: null,
    });
  });

  it.each([
    'Can I talk to a human please?',
    'I want a real person',
    'connect me to support',
    'Is there a live agent?',
  ])('escalates when the customer asks for a person: %s', (message) => {
    expect(evaluate(message)).toMatchObject({
      shouldEscalate: true,
      reason: 'DIRECT_ADMIN_REQUEST',
      confidence: 1,
    });
  });

  it('finds the request whatever the case and spacing', () => {
    expect(evaluate('I   NEED\nADMIN')).toMatchObject({
      reason: 'DIRECT_ADMIN_REQUEST',
      matchedPhrase: 'i need admin',
    });
  });

  // a phrase is a word of the message, not a piece of a longer word
  it.each([
    ['admin inside badminton', 'Do you sell badminton rackets?'],
    ['transfer me inside transfer methods', 'Which bank transfer methods do you accept?'],
  ])('does not escalate on %s', (_case, message) => {
    expect(evaluate(message)).toMatchObject({ shouldEscalate: false, reason: 'NONE' });
  });

  it.each([
    ['connect me inside connect meeting', 'How do I connect meeting rooms to the app?'],
    ['refund inside a word that only starts the same', 'Is this a prefund offer?'],
  ])('does not escalate on %s either', (_case, message) => {
    expect(evaluate(message).shouldEscalate).toBe(false);
  });

  // a single word like admin or manager also names a product feature: the model decides it
  it.each([
    ['an admin panel', 'Does this router have an admin panel?'],
    ['a password manager', 'Do you sell a password manager?'],
    ['an operator', 'Which mobile operator works with this phone?'],
    ['managers', 'Can I talk to one of your managers?'],
  ])('leaves a single word to the model: %s', (_case, message) => {
    expect(evaluate(message)).toMatchObject({ shouldEscalate: false, reason: 'NONE' });
  });

  // one word may go on with an ending, the way people write it
  it.each([
    ['refunded', 'I want my order refunded', 'HUMAN_REQUIRED'],
    ['complaints', 'Where do I send complaints?', 'HUMAN_REQUIRED'],
  ])('still escalates on %s', (_case, message, reason) => {
    expect(evaluate(message)).toMatchObject({ shouldEscalate: true, reason });
  });

  it('finds a phrase next to punctuation', () => {
    expect(evaluate('(real person) please!').reason).toBe('DIRECT_ADMIN_REQUEST');
    expect(evaluate('Talk to a human, now.').reason).toBe('DIRECT_ADMIN_REQUEST');
  });

  it('escalates when the bot itself says it cannot help', () => {
    expect(evaluate('Where is my parcel?', 'Sorry, I cannot help with this.')).toMatchObject({
      shouldEscalate: true,
      reason: 'BOT_CANNOT_HELP',
      confidence: 0.9,
      matchedPhrase: 'i cannot help with this',
    });
  });

  it.each(['I want a refund', 'There was a payment problem', 'Please delete account data'])(
    'escalates a matter that needs a human decision: %s',
    (message) => {
      expect(evaluate(message)).toMatchObject({
        shouldEscalate: true,
        reason: 'HUMAN_REQUIRED',
        confidence: 0.75,
      });
    },
  );

  describe('a customer who keeps asking the same', () => {
    const question = 'Where is my order?';
    const twice = [
      said('user', question),
      said('bot', 'It is on its way.'),
      said('user', question),
    ];

    it('escalates the third time a question comes, the two earlier ones in the history', () => {
      expect(evaluate(question, 'It is on its way.', twice)).toMatchObject({
        shouldEscalate: true,
        reason: 'LOOP_DETECTED',
        confidence: 0.8,
        matchedPhrase: 'where is my order?',
      });
    });

    it('does not escalate the second time', () => {
      expect(evaluate(question, 'It is on its way.', twice.slice(0, 2))).toMatchObject({
        reason: 'NONE',
      });
    });

    it('treats a repeat in another case or spacing as the same question', () => {
      const history = [said('guest', 'WHERE is my   order?'), said('guest', 'where is my order?')];

      expect(evaluate(question, 'It is on its way.', history).reason).toBe('LOOP_DETECTED');
    });

    it('does not count the bot repeating the same words', () => {
      const history = [said('bot', question), said('bot', question)];

      expect(evaluate(question, 'It is on its way.', history).reason).toBe('NONE');
    });

    it('looks only at the last 8 customer messages', () => {
      const others = Array.from({ length: 8 }, (_, n) => said('user', `question number ${n}`));
      const history = [said('user', question), said('user', question), ...others];

      expect(evaluate(question, 'It is on its way.', history).reason).toBe('NONE');
    });

    it('does not treat a blank message as a repeat', () => {
      expect(evaluate('   ', 'Hello!', [said('user', ' '), said('user', '')]).reason).toBe('NONE');
    });
  });

  describe('priority of the signals', () => {
    it('puts a direct request first, before the bot admitting it cannot help', () => {
      expect(evaluate('I need admin', 'I cannot help with this.').reason).toBe(
        'DIRECT_ADMIN_REQUEST',
      );
    });

    it('puts the bot admitting it cannot help before a loop', () => {
      const history = [said('user', 'refund?'), said('user', 'refund?')];

      expect(evaluate('refund?', 'I cannot help with this.', history).reason).toBe(
        'BOT_CANNOT_HELP',
      );
    });

    it('puts a loop before a matter that needs a human', () => {
      const history = [said('user', 'refund?'), said('user', 'refund?')];

      expect(evaluate('refund?', 'Refunds take 5 days.', history).reason).toBe('LOOP_DETECTED');
    });
  });
});
