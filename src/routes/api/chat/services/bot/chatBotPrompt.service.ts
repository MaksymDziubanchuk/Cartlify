import type { AiMessageDto } from '@services/ai/ai.types.js';

export type ChatBotActorRole = 'GUEST' | 'USER';

export type ChatBotHistorySenderType = 'user' | 'guest' | 'bot';

export interface ChatBotHistoryMessageDto {
    senderType: ChatBotHistorySenderType;
    content: string;
    createdAt: Date;
}

export interface ChatBotProductContextItemDto {
    id: number;
    name: string;
    price: number;
    categoryName: string | null;
    description: string | null;
    popularity: number | null;
}

export interface BuildChatBotPromptDto {
    actorRole: ChatBotActorRole;
    userMessage: string;
    history: ChatBotHistoryMessageDto[];
    productContext: ChatBotProductContextItemDto[];
}

export interface BuildChatBotPromptResultDto {
    instructions: string;
    messages: AiMessageDto[];
}

const MAX_HISTORY_MESSAGES = 12;
const MAX_PRODUCT_CONTEXT_ITEMS = 6;

// builds the permanent behavior rules for the Cartlify assistant
const buildSystemInstructions = (actorRole: ChatBotActorRole): string => {
    return [
        'You are Cartlify assistant, a support and shopping helper inside the Cartlify e-commerce platform.',
        'Answer only as a text assistant. Do not return JSON, markdown tables, tool calls, hidden metadata, or action objects.',
        'Keep answers helpful, clear, and concise.',
        'You can explain platform features, help the customer understand how to use Cartlify, and consult about products when product context is provided.',
        'Do not invent products, prices, discounts, stock status, delivery terms, or policies that are not provided in the prompt.',
        'If product context is missing or insufficient, say that you do not have enough product data and ask a focused follow-up question.',
        'Do not claim that you are an admin, human operator, manager, or specialist.',
        'If the customer clearly asks for an admin, operator, specialist, manager, or human support, acknowledge the request.',
        actorRole === 'USER'
            ? 'The current customer is logged in. If admin help is needed, tell the customer that you can transfer the chat to an admin.'
            : 'The current customer is a guest. Guests cannot be transferred to an admin chat. If admin help is needed, ask the guest to log in or create an account first.',
        'If the conversation is going in circles, or the issue requires a human decision, explain that admin support is needed.',
        'For guests, any admin-support recommendation must include logging in or registration first.',
        'For logged-in users, admin-support recommendation may say that the chat can be transferred to an admin.',
        'Do not provide legal, medical, financial, or security-sensitive advice beyond general platform guidance.',
        'Do not ask for passwords, card numbers, secret tokens, or other sensitive credentials.',
        'Use the same language as the customer message when possible.',
    ].join('\n');
};

// converts stored chat sender type into ai message role
const mapHistorySenderToAiRole = (
    senderType: ChatBotHistorySenderType,
): AiMessageDto['role'] => {
    if (senderType === 'bot') {
        return 'assistant';
    }

    return 'user';
};

// limits history to recent useful messages
const getRecentHistory = (
    history: ChatBotHistoryMessageDto[],
): ChatBotHistoryMessageDto[] => {
    return history
        .filter((message) => message.content.trim())
        .slice(-MAX_HISTORY_MESSAGES);
};

// converts chat history into ai messages
const buildHistoryMessages = (
    history: ChatBotHistoryMessageDto[],
): AiMessageDto[] => {
    return getRecentHistory(history).map((message) => ({
        role: mapHistorySenderToAiRole(message.senderType),
        content: message.content.trim(),
    }));
};

// formats one product for prompt context
const formatProductContextItem = (
    product: ChatBotProductContextItemDto,
): string => {
    const parts = [
        `id: ${product.id}`,
        `name: ${product.name}`,
        `price: ${product.price}`,
        `category: ${product.categoryName ?? 'unknown'}`,
    ];

    if (product.description?.trim()) {
        parts.push(`description: ${product.description.trim()}`);
    }

    if (typeof product.popularity === 'number') {
        parts.push(`popularity: ${product.popularity}`);
    }

    return parts.join('; ');
};

// builds product context text for the model
const buildProductContextMessage = (
    productContext: ChatBotProductContextItemDto[],
): AiMessageDto | null => {
    const products = productContext.slice(0, MAX_PRODUCT_CONTEXT_ITEMS);

    if (products.length === 0) {
        return null;
    }

    return {
        role: 'developer',
        content: [
            'Available product context for this answer:',
            ...products.map((product) => `- ${formatProductContextItem(product)}`),
            'Use only this product context when recommending specific products.',
        ].join('\n'),
    };
};

// builds current request message with actor role metadata
const buildCurrentUserMessage = ({
    actorRole,
    userMessage,
}: Pick<BuildChatBotPromptDto, 'actorRole' | 'userMessage'>): AiMessageDto => {
    return {
        role: 'user',
        content: [
            `customer_role: ${actorRole}`,
            `customer_message: ${userMessage.trim()}`,
        ].join('\n'),
    };
};

// builds final prompt payload for aiClient.service.ts
export const buildChatBotPrompt = (
    dto: BuildChatBotPromptDto,
): BuildChatBotPromptResultDto => {
    const productContextMessage = buildProductContextMessage(dto.productContext);

    return {
        instructions: buildSystemInstructions(dto.actorRole),
        messages: [
            ...(productContextMessage ? [productContextMessage] : []),
            ...buildHistoryMessages(dto.history),
            buildCurrentUserMessage({
                actorRole: dto.actorRole,
                userMessage: dto.userMessage,
            }),
        ],
    };
};

export const chatBotPromptService = {
    buildChatBotPrompt,
};