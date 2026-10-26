import env from '@config/env.js';
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
    // the sale while it lasts: the product sells at its price until the end, an iso time in utc;
    // priorPrice is the lowest price of the 30 days before it, none for an older sale
    sale: { price: number; endsAt: string; priorPrice?: number | null } | null;
    // the units free to buy now: the stock that confirmed orders do not hold
    stock: number;
    categoryName: string | null;
    description: string | null;
    popularity: number | null;
}

export type ChatBotOrderStatus =
    'unconfirmed' | 'waiting' | 'paid' | 'shipped' | 'delivered' | 'cancelled';

// an order of the customer, the cart is none; times are iso in utc
export interface ChatBotOrderContextItemDto {
    id: number;
    status: ChatBotOrderStatus;
    total: number;
    createdAt: string;
    paidAt: string | null;
    items: { name: string; quantity: number }[];
}

export interface BuildChatBotPromptDto {
    actorRole: ChatBotActorRole;
    // only a customer who confirmed the email talks to an admin, a guest never has
    emailConfirmed: boolean;
    userMessage: string;
    history: ChatBotHistoryMessageDto[];
    productContext: ChatBotProductContextItemDto[];
    // the last orders of a signed-in customer, newest first; none for a guest
    orders: ChatBotOrderContextItemDto[];
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

// what a status means to the customer, the words the model answers "where is my order" with
const ORDER_STATUS_MEANINGS: Record<ChatBotOrderStatus, string> = {
    unconfirmed:
        'not confirmed: the customer has to confirm it again before paying',
    waiting: 'confirmed, waiting for the payment',
    paid: 'paid, being prepared for shipping',
    shipped: 'sent, on its way to the customer',
    delivered: 'delivered to the customer',
    cancelled: 'cancelled by the shop, the payment is refunded',
};

// who the customer is to the admin chat: a guest, a customer without a confirmed email, or one
// the chat can be transferred for
const describeAdminAccess = (
    actorRole: ChatBotActorRole,
    emailConfirmed: boolean,
): string => {
    if (actorRole === 'GUEST') {
        return 'The current customer is a guest. Only customers with a confirmed email can talk to an admin; if admin help is needed, ask the guest to log in, or to create an account and confirm the email, first.';
    }

    if (!emailConfirmed) {
        return 'The current customer is logged in but has not confirmed their email. Only customers with a confirmed email can talk to an admin; if admin help is needed, ask the customer to confirm their email with the link that was mailed to them first.';
    }

    return 'The current customer is logged in with a confirmed email. If admin help is needed, tell the customer that you can transfer the chat to an admin.';
};

// what the model knows of the orders when there is no order message
const describeNoOrders = (
    actorRole: ChatBotActorRole,
    orders: ChatBotOrderContextItemDto[],
) => {
    if (actorRole === 'GUEST')
        return ['A guest has no orders; the customer logs in to see them.'];

    return orders.length === 0 ? ['The customer has no orders yet.'] : [];
};

// where the customer pays: one provider is named as it is, several as a choice
const describePaymentPage = (paymentProviders: string[]): string =>
    paymentProviders.length === 1
        ? `on a ${paymentProviders[0]} payment page the customer opens after confirming the order`
        : `on a payment page of ${paymentProviders.join(' or ')}, the one the customer picks after confirming the order`;

// builds the permanent behavior rules for the assistant of the shop (SHOP_NAME)
const buildSystemInstructions = (
    actorRole: ChatBotActorRole,
    emailConfirmed: boolean,
    orders: ChatBotOrderContextItemDto[],
    currency: string,
    paymentProviders: string[],
): string => {
    return [
        `You are ${env.SHOP_NAME} assistant, a support and shopping helper inside the ${env.SHOP_NAME} online shop.`,
        'Put your answer to the customer into the reply field of the response format. The reply is plain chat text: no markdown tables, tool calls, hidden metadata, or action objects.',
        'Also decide by meaning, whatever the language, whether a human admin is needed, and fill escalate and reason:',
        '- DIRECT_ADMIN_REQUEST: the customer asks to talk to an admin, an operator, a manager, a specialist, a support agent, or any real person.',
        '- HUMAN_REQUIRED: the matter needs a human decision or access to the account or order: a refund, a chargeback, a failed or wrong payment, cancelling or changing an order, a blocked or locked account, deleting an account, personal data, a complaint.',
        '- BOT_CANNOT_HELP: you cannot solve the issue with the information you have, and a follow-up question will not help.',
        '- NONE: anything else, with escalate false. Ordinary questions about products, prices, stock, delivery or how to use the shop are NONE.',
        'A word that only looks like such a request is not one: badminton, an admin panel or a manager as a product feature, a payment method question.',
        'escalate is true exactly when reason is not NONE.',
        'Keep answers helpful, clear, and concise.',
        `You can explain the features of the shop, help the customer understand how to use ${env.SHOP_NAME}, and consult about products when product context is provided.`,
        'Do not invent products, prices, discounts, stock status, delivery terms, or policies that are not provided in the prompt.',
        `All prices are in ${currency}; name this currency with a price, never another one.`,
        'A product with a sale price sells at the sale price until the end of the sale; its price is the usual one, name it only next to the sale price.',
        'in stock is the number of units free to buy now; never promise more of a product than that.',
        `Payment is by card only, ${describePaymentPage(paymentProviders)}. There are no other payment methods: no PayPal, no cash, no bank transfer.`,
        'If product context is missing or insufficient, say that you do not have enough product data and ask a focused follow-up question.',
        'Do not claim that you are an admin, human operator, manager, or specialist.',
        'If the customer clearly asks for an admin, operator, specialist, manager, or human support, acknowledge the request.',
        describeAdminAccess(actorRole, emailConfirmed),
        'If the conversation is going in circles, or the issue requires a human decision, explain that admin support is needed.',
        ...describeNoOrders(actorRole, orders),
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
            ? [
                  `sale price: ${product.sale.price} ${currency} until ${product.sale.endsAt} (UTC)`,
              ]
            : []),
        ...(product.sale?.priorPrice != null
            ? [
                  `lowest price of the 30 days before the sale: ${product.sale.priorPrice} ${currency}`,
              ]
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
            ...products.map(
                (product) => `- ${formatProductContextItem(product, currency)}`,
            ),
            'Use only this product context when recommending specific products.',
        ].join('\n'),
    };
};

// formats one order for prompt context
const formatOrderContextItem = (
    order: ChatBotOrderContextItemDto,
    currency: string,
): string => {
    const items = order.items.length
        ? order.items
              .map((item) => `${item.name} x ${item.quantity}`)
              .join(', ')
        : 'none';

    return [
        `order ${order.id}: ${order.status} (${ORDER_STATUS_MEANINGS[order.status]})`,
        `total ${order.total} ${currency}`,
        `placed ${order.createdAt} (UTC)`,
        ...(order.paidAt ? [`paid ${order.paidAt} (UTC)`] : []),
        `items: ${items}`,
    ].join('; ');
};

// builds the orders of the customer for the model, none without orders
const buildOrdersMessage = (
    orders: ChatBotOrderContextItemDto[],
    currency: string,
): AiMessageDto | null => {
    if (orders.length === 0) return null;

    return {
        role: 'developer',
        content: [
            'Orders of the customer, newest first:',
            ...orders.map(
                (order) => `- ${formatOrderContextItem(order, currency)}`,
            ),
            'Use only these orders when the customer asks about an order; never invent an order, a status or a date.',
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
    const productContextMessage = buildProductContextMessage(
        dto.productContext,
        currency,
    );
    const ordersMessage = buildOrdersMessage(dto.orders, currency);

    return {
        instructions: buildSystemInstructions(
            dto.actorRole,
            dto.emailConfirmed,
            dto.orders,
            currency,
            dto.paymentProviders,
        ),
        messages: [
            ...(productContextMessage ? [productContextMessage] : []),
            ...(ordersMessage ? [ordersMessage] : []),
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
