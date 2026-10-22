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
    // the sale while it lasts: the product sells at its price until the end, an iso time in utc
    sale: { price: number; endsAt: string } | null;
    // the units free to buy now: the stock that confirmed orders do not hold
    stock: number;
    categoryName: string | null;
    description: string | null;
    popularity: number | null;
}

export interface BuildChatBotPromptDto {
    actorRole: ChatBotActorRole;
    userMessage: string;
    history: ChatBotHistoryMessageDto[];
    productContext: ChatBotProductContextItemDto[];
    // the shop currency, the one checkout charges in, e.g. "eur"
    currency: string;
    // how the payment providers the customer may pay with are named, e.g. ["Stripe"]
    paymentProviders: string[];
}

export interface BuildChatBotPromptResultDto {
    instructions: string;
    messages: AiMessageDto[];
}

const MAX_HISTORY_MESSAGES = 12;
const MAX_PRODUCT_CONTEXT_ITEMS = 6;

// where the customer pays: one provider is named as it is, several as a choice
const describePaymentPage = (paymentProviders: string[]): string =>
    paymentProviders.length === 1
        ? `on a ${paymentProviders[0]} payment page the customer opens after confirming the order`
        : `on a payment page of ${paymentProviders.join(' or ')}, the one the customer picks after confirming the order`;

// builds the permanent behavior rules for the Cartlify assistant
const buildSystemInstructions = (
    actorRole: ChatBotActorRole,
    currency: string,
    paymentProviders: string[],
): string => {
    return [
        'You are Cartlify assistant, a support and shopping helper inside the Cartlify e-commerce platform.',
        'Put your answer to the customer into the reply field of the response format. The reply is plain chat text: no markdown tables, tool calls, hidden metadata, or action objects.',
        'Also decide by meaning, whatever the language, whether a human admin is needed, and fill escalate and reason:',
        '- DIRECT_ADMIN_REQUEST: the customer asks to talk to an admin, an operator, a manager, a specialist, a support agent, or any real person.',
        '- HUMAN_REQUIRED: the matter needs a human decision or access to the account or order: a refund, a chargeback, a failed or wrong payment, cancelling or changing an order, a blocked or locked account, deleting an account, personal data, a complaint.',
        '- BOT_CANNOT_HELP: you cannot solve the issue with the information you have, and a follow-up question will not help.',
        '- NONE: anything else, with escalate false. Ordinary questions about products, prices, stock, delivery or how to use the shop are NONE.',
        'A word that only looks like such a request is not one: badminton, an admin panel or a manager as a product feature, a payment method question.',
        'escalate is true exactly when reason is not NONE.',
        'Keep answers helpful, clear, and concise.',
        'You can explain platform features, help the customer understand how to use Cartlify, and consult about products when product context is provided.',
        'Do not invent products, prices, discounts, stock status, delivery terms, or policies that are not provided in the prompt.',
        `All prices are in ${currency}; name this currency with a price, never another one.`,
        'A product with a sale price sells at the sale price until the end of the sale; its price is the usual one, name it only next to the sale price.',
        'in stock is the number of units free to buy now; never promise more of a product than that.',
        `Payment is by card only, ${describePaymentPage(paymentProviders)}. There are no other payment methods: no PayPal, no cash, no bank transfer.`,
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
        'Always answer in the same natural language as the latest customer message.',
        'Use the latest customer message to choose the response language, not older chat history.',
        'Do not switch to English unless the latest customer message is in English or the customer explicitly asks for English.',
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
    currency: string,
): string => {
    const parts = [
        `id: ${product.id}`,
        `name: ${product.name}`,
        `price: ${product.price} ${currency}`,
        ...(product.sale
            ? [`sale price: ${product.sale.price} ${currency} until ${product.sale.endsAt} (UTC)`]
            : []),
        `in stock: ${product.stock}`,
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
    currency: string,
): AiMessageDto | null => {
    const products = productContext.slice(0, MAX_PRODUCT_CONTEXT_ITEMS);

    if (products.length === 0) {
        return null;
    }

    return {
        role: 'developer',
        content: [
            'Available product context for this answer:',
            ...products.map((product) => `- ${formatProductContextItem(product, currency)}`),
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
    const currency = dto.currency.trim().toUpperCase();
    const productContextMessage = buildProductContextMessage(dto.productContext, currency);

    return {
        instructions: buildSystemInstructions(dto.actorRole, currency, dto.paymentProviders),
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