import type { ChatBotHistoryMessageDto } from './chatBotPrompt.service.js';

export type ChatBotEscalationReason =
    | 'DIRECT_ADMIN_REQUEST'
    | 'BOT_CANNOT_HELP'
    | 'LOOP_DETECTED'
    | 'HUMAN_REQUIRED'
    | 'NONE';

export interface EvaluateChatBotEscalationDto {
    userMessage: string;
    botMessage: string;
    history: ChatBotHistoryMessageDto[];
}

export interface ChatBotEscalationResultDto {
    shouldEscalate: boolean;
    reason: ChatBotEscalationReason;
    confidence: number;
    matchedPhrase: string | null;
}

const MIN_LOOP_REPEATED_USER_MESSAGES = 2;
const MAX_LOOP_HISTORY_MESSAGES = 8;

// phrases that mean the customer directly asks for human/admin support
// only explicit requests of several words: a single word like "admin" or "manager" also
// comes in "admin panel" or "password manager", the model decides those by meaning
const DIRECT_ADMIN_REQUEST_PHRASES = [
    'support agent',
    'human support',
    'real person',
    'live agent',
    'live chat',
    'connect me',
    'transfer me',
    'talk to a human',
    'speak to a human',
    'i want a human',
    'i need a human',
    'i want admin',
    'i need admin',
];

// phrases that mean the bot admits it cannot solve the issue
const BOT_CANNOT_HELP_PHRASES = [
    'i cannot help with this',
    'i can not help with this',
    'i cannot solve this',
    'i can not solve this',
    'i do not have enough information to solve this',
    'i am not able to solve this',
    'this needs admin support',
    'this requires admin support',
    'an admin is needed',
    'a specialist is needed',
    'a human is needed',
    'please contact admin',
    'please contact support',
];

// phrases that usually require a human decision or account-specific support
const HUMAN_REQUIRED_PHRASES = [
    'refund',
    'chargeback',
    'payment failed',
    'payment problem',
    'cancel order',
    'order cancellation',
    'change order',
    'account blocked',
    'account locked',
    'delete account',
    'personal data',
    'complaint',
];

// normalizes text before phrase matching
const normalizeText = (value: string): string => {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
};

// escapes regex characters of a phrase
const escapeRegExp = (value: string): string => {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// a phrase starts at the start of a word, so "admin" does not match inside "badminton";
// a phrase of several words also ends at the end of a word, so "transfer me" does not match
// "transfer methods"; one word may go on with an ending: "refund" matches "refunds";
// \b knows only latin letters, the lookarounds work for cyrillic too
const buildPhraseRegExp = (phrase: string): RegExp => {
    const normalizedPhrase = normalizeText(phrase);
    const end = normalizedPhrase.includes(' ') ? '(?![\\p{L}\\p{N}])' : '';

    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(normalizedPhrase)}${end}`, 'u');
};

// finds the first phrase found in normalized text
const findMatchedPhrase = (
    text: string,
    phrases: string[],
): string | null => {
    const normalizedText = normalizeText(text);

    return (
        phrases.find((phrase) => buildPhraseRegExp(phrase).test(normalizedText)) ??
        null
    );
};

// checks if the customer directly asked for admin or human support
const evaluateDirectAdminRequest = (
    userMessage: string,
): ChatBotEscalationResultDto | null => {
    const matchedPhrase = findMatchedPhrase(
        userMessage,
        DIRECT_ADMIN_REQUEST_PHRASES,
    );

    if (!matchedPhrase) {
        return null;
    }

    return {
        shouldEscalate: true,
        reason: 'DIRECT_ADMIN_REQUEST',
        confidence: 1,
        matchedPhrase,
    };
};

// checks if the bot response says that human/admin help is needed
const evaluateBotCannotHelp = (
    botMessage: string,
): ChatBotEscalationResultDto | null => {
    const matchedPhrase = findMatchedPhrase(
        botMessage,
        BOT_CANNOT_HELP_PHRASES,
    );

    if (!matchedPhrase) {
        return null;
    }

    return {
        shouldEscalate: true,
        reason: 'BOT_CANNOT_HELP',
        confidence: 0.9,
        matchedPhrase,
    };
};

// checks if the current issue likely needs a human decision
const evaluateHumanRequired = (
    userMessage: string,
): ChatBotEscalationResultDto | null => {
    const matchedPhrase = findMatchedPhrase(
        userMessage,
        HUMAN_REQUIRED_PHRASES,
    );

    if (!matchedPhrase) {
        return null;
    }

    return {
        shouldEscalate: true,
        reason: 'HUMAN_REQUIRED',
        confidence: 0.75,
        matchedPhrase,
    };
};

// extracts recent customer messages from thread history
const getRecentCustomerMessages = (
    history: ChatBotHistoryMessageDto[],
): string[] => {
    return history
        .filter((message) => message.senderType !== 'bot')
        .map((message) => normalizeText(message.content))
        .filter(Boolean)
        .slice(-MAX_LOOP_HISTORY_MESSAGES);
};

// detects when customer repeats the same question and bot keeps failing to progress
const evaluateLoopDetected = (
    userMessage: string,
    history: ChatBotHistoryMessageDto[],
): ChatBotEscalationResultDto | null => {
    const normalizedUserMessage = normalizeText(userMessage);

    if (!normalizedUserMessage) {
        return null;
    }

    const repeatedCount = getRecentCustomerMessages(history).filter(
        (message) => message === normalizedUserMessage,
    ).length;

    if (repeatedCount < MIN_LOOP_REPEATED_USER_MESSAGES) {
        return null;
    }

    return {
        shouldEscalate: true,
        reason: 'LOOP_DETECTED',
        confidence: 0.8,
        matchedPhrase: normalizedUserMessage,
    };
};

// returns default non-escalation result
const createNoEscalationResult = (): ChatBotEscalationResultDto => {
    return {
        shouldEscalate: false,
        reason: 'NONE',
        confidence: 0,
        matchedPhrase: null,
    };
};

// evaluates all escalation signals in priority order
export const evaluateChatBotEscalation = (
    dto: EvaluateChatBotEscalationDto,
): ChatBotEscalationResultDto => {
    return (
        evaluateDirectAdminRequest(dto.userMessage) ??
        evaluateBotCannotHelp(dto.botMessage) ??
        evaluateLoopDetected(dto.userMessage, dto.history) ??
        evaluateHumanRequired(dto.userMessage) ??
        createNoEscalationResult()
    );
};

export const chatBotEscalationService = {
    evaluateChatBotEscalation,
};