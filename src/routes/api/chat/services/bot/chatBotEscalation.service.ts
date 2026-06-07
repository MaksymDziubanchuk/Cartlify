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
const DIRECT_ADMIN_REQUEST_PHRASES = [
    'admin',
    'administrator',
    'operator',
    'support agent',
    'human support',
    'real person',
    'live agent',
    'live chat',
    'manager',
    'specialist',
    'representative',
    'connect me',
    'transfer me',
    'talk to a human',
    'speak to a human',
    'i want a human',
    'i need a human',
    'i want admin',
    'i need admin',
    'адмін',
    'админа',
    'адміну',
    'адміністратор',
    'адміністратора',
    'адміністратору',
    'оператор',
    'оператора',
    'оператору',
    'спеціаліст',
    'спеціаліста',
    'спеціалісту',
    'людина',
    'людину',
    'жива людина',
    'підключи адміна',
    'переключи на адміна',
    'з’єднай з адміном',
    "з'єднай з адміном",
    'хочу адміна',
    'хочу спеціаліста',
    'хочу оператора',
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
    'не можу допомогти з цим',
    'не можу вирішити це',
    'я не можу це вирішити',
    'потрібен адмін',
    'потрібен адміністратор',
    'потрібен спеціаліст',
    'потрібна людина',
    'потрібна допомога адміна',
    'треба звернутись до адміна',
    'треба звернутися до адміна',
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
    'скарга',
    'повернення коштів',
    'повернути кошти',
    'скасувати замовлення',
    'змінити замовлення',
    'проблема з оплатою',
    'оплата не пройшла',
    'акаунт заблоковано',
    'видалити акаунт',
    'персональні дані',
];

// normalizes text before phrase matching
const normalizeText = (value: string): string => {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
};

// finds the first phrase included in normalized text
const findMatchedPhrase = (
    text: string,
    phrases: string[],
): string | null => {
    const normalizedText = normalizeText(text);

    return (
        phrases.find((phrase) => normalizedText.includes(normalizeText(phrase))) ??
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