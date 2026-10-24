import type { ChatBotHistoryMessageDto } from './chatBotPrompt.service.js';

export type ChatBotEscalationReason =
    | 'DIRECT_ADMIN_REQUEST'
    | 'BOT_CANNOT_HELP'
    | 'LOOP_DETECTED'
    | 'HUMAN_REQUIRED'
    | 'NONE';

export interface EvaluateChatBotEscalationDto {
    userMessage: string;
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

// "yes", "ok thanks" or "the red one" come again and again in a good conversation: a message of
// up to this many words said again is no loop
const MAX_SHORT_MESSAGE_WORDS = 3;

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
// "transfer methods"; \b knows only latin letters, the lookarounds work for cyrillic too
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

// the words of a message: runs of letters or digits, punctuation is none
const countWords = (text: string): number => {
    return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
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

    if (!normalizedUserMessage || countWords(normalizedUserMessage) <= MAX_SHORT_MESSAGE_WORDS) {
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

// the signals the code finds before the model is asked: an explicit request for a person in
// english words and a loop. Whether a matter needs a human (a refund, a complaint) the model
// decides by meaning in any language: most of them it answers itself
export const evaluateChatBotEscalation = (
    dto: EvaluateChatBotEscalationDto,
): ChatBotEscalationResultDto => {
    return (
        evaluateDirectAdminRequest(dto.userMessage) ??
        evaluateLoopDetected(dto.userMessage, dto.history) ??
        createNoEscalationResult()
    );
};

export const chatBotEscalationService = {
    evaluateChatBotEscalation,
};
