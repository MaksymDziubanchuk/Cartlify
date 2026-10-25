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

const evaluate = (userMessage: string, history: ChatBotHistoryMessageDto[] = []) =>
  evaluateChatBotEscalation({ userMessage, history });

// before the model only an explicit request for a person and a loop are found by the code:
// whether a matter needs a human, the model decides by meaning in any language
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
    ['connect me inside connect meeting', 'How do I connect meeting rooms to the app?'],
  ])('does not escalate on %s', (_case, message) => {
    expect(evaluate(message)).toMatchObject({ shouldEscalate: false, reason: 'NONE' });
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

  // "refund" also comes in "how long does a refund take", which the bot answers itself
  it.each([
    'I want a refund',
    'I want my order refunded',
    'Where do I send complaints?',
    'There was a payment problem',
    'Please delete account data',
    'How long does a refund take?',
  ])('leaves a matter that may need a human to the model: %s', (message) => {
    expect(evaluate(message)).toMatchObject({ shouldEscalate: false, reason: 'NONE' });
  });

  it('finds a phrase next to punctuation', () => {
    expect(evaluate('(real person) please!').reason).toBe('DIRECT_ADMIN_REQUEST');
    expect(evaluate('Talk to a human, now.').reason).toBe('DIRECT_ADMIN_REQUEST');
  });

  describe('a customer who keeps asking the same', () => {
    const question = 'Where is my order?';
    const twice = [
      said('user', question),
      said('bot', 'It is on its way.'),
      said('user', question),
    ];

    it('finds a loop the third time a question comes, the two earlier ones in the history', () => {
      expect(evaluate(question, twice)).toMatchObject({
        shouldEscalate: true,
        reason: 'LOOP_DETECTED',
        confidence: 0.8,
        matchedPhrase: 'where is my order?',
      });
    });

    it('does not find one the second time', () => {
      expect(evaluate(question, twice.slice(0, 2))).toMatchObject({ reason: 'NONE' });
    });

    it('treats a repeat in another case or spacing as the same question', () => {
      const history = [said('guest', 'WHERE is my   order?'), said('guest', 'where is my order?')];

      expect(evaluate(question, history).reason).toBe('LOOP_DETECTED');
    });

    it('does not count the bot repeating the same words', () => {
      const history = [said('bot', question), said('bot', question)];

      expect(evaluate(question, history).reason).toBe('NONE');
    });

    it('looks only at the last 8 customer messages', () => {
      const others = Array.from({ length: 8 }, (_, n) => said('user', `question number ${n}`));
      const history = [said('user', question), said('user', question), ...others];

      expect(evaluate(question, history).reason).toBe('NONE');
    });

    it('does not treat a blank message as a repeat', () => {
      expect(evaluate('   ', [said('user', ' '), said('user', '')]).reason).toBe('NONE');
    });

    // "yes", "ok, thanks" or "the red one" come again and again in a good conversation
    it.each(['yes', 'ok thanks', 'the red one', 'no ,  not that'])(
      'does not take a short answer of up to 3 words said again for a loop: %s',
      (message) => {
        expect(evaluate(message, [said('user', message), said('user', message)]).reason).toBe(
          'NONE',
        );
      },
    );

    it('takes a message of 4 words said again for a loop', () => {
      const message = 'is it in stock';

      expect(evaluate(message, [said('user', message), said('user', message)]).reason).toBe(
        'LOOP_DETECTED',
      );
    });
  });

  it('puts a direct request before a loop', () => {
    const message = 'I need admin right now';
    const history = [said('user', message), said('user', message)];

    expect(evaluate(message, history).reason).toBe('DIRECT_ADMIN_REQUEST');
  });
});
