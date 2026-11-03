import env from '@config/env.js';
import type { AiMessageDto } from '@services/ai/ai.types.js';
import type { DeliveryMethodInfoDto } from 'types/dto/delivery.dto.js';
import type { ReturnStatus } from '@prisma/client';
import type { BuyerReturnDto, BuyerReturnStep } from 'types/dto/returns.dto.js';

export type ChatBotActorRole = 'GUEST' | 'USER';

export type ChatBotHistorySenderType = 'user' | 'guest' | 'bot';

export interface ChatBotHistoryMessageDto {
    senderType: ChatBotHistorySenderType;
    content: string;
    createdAt: Date;
}

// a variant of a product that a buyer sees (alive, with a picture): what the customer buys, so the
// price, the sale and the free units are the variant's
export interface ChatBotVariantContextItemDto {
    id: number;
    // the name of the product and the values that tell its variants apart
    name: string;
    price: number;
    // the sale while it lasts: the variant sells at its sale price until the end, an iso time in
    // utc; priorPrice is the lowest price of the 30 days before it, none for an older sale
    sale: { price: number; endsAt: string; priorPrice?: number | null } | null;
    // the units free to buy now: the stock that confirmed orders do not hold, and no units over
    stock: number;
}

export interface ChatBotProductContextItemDto {
    id: number;
    name: string;
    categoryName: string | null;
    description: string | null;
    popularity: number | null;
    // the variants a buyer sees, in the order of the product; the prompt names at most
    // MAX_VARIANTS_PER_PRODUCT of them and sums up the rest
    variants: ChatBotVariantContextItemDto[];
}

export type ChatBotOrderStatus =
    'unconfirmed' | 'waiting' | 'paid' | 'shipped' | 'delivered' | 'cancelled';

// a statement of withdrawal or return on an order the way its buyer sees it: where it stands and
// where the money of its units is. What the shop does with the goods is no part of it
export interface ChatBotReturnContextItemDto {
    id: number;
    statedAt: string;
    step: BuyerReturnStep;
    items: Pick<
        BuyerReturnDto['items'][number],
        'quantity' | 'amount' | 'deliveryAmount' | 'money' | 'refundedAt' | 'refusal'
    >[];
}

// whether the customer may still withdraw from the contract of an order and for which units
export interface ChatBotWithdrawalContextDto {
    open: boolean;
    // the end of the period of the contract, an iso time in utc; none before the delivery starts it
    endsAt: string | null;
    // the end of the contract is past and the period is open only by the grace of the shop
    late?: boolean;
    // the units still free to state, by item
    free: { name: string; quantity: number }[];
    // the items the law gives no right of withdrawal for (a perishable or personalised good): there
    // is nothing to state for them, which is not the same as all of them being stated already
    noRight: string[];
}

// an order of the customer, the cart is none; times are iso in utc
export interface ChatBotOrderContextItemDto {
    id: number;
    status: ChatBotOrderStatus;
    total: number;
    createdAt: string;
    paidAt: string | null;
    items: { name: string; quantity: number }[];
    // the order had an event the bot does not talk about, a send taken back or a transfer of money
    // that failed: it is for an admin
    unusual: boolean;
    // where the order stands as to its statements of withdrawal and return, one value for it all
    returnStatus: ReturnStatus;
    // none for an order that cannot be withdrawn from (not paid, not sent, or cancelled)
    withdrawal: ChatBotWithdrawalContextDto | null;
    returns: ChatBotReturnContextItemDto[];
    // how it goes to the customer, without the address and the phone; none before the confirmation
    delivery: { method: 'manual' | 'pickup'; price: number; country: string | null } | null;
    // the send on its way, what the admin wrote of it
    shipment: {
        carrier: string | null;
        trackingNumber: string | null;
        trackingUrl: string | null;
    } | null;
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
    // the ways the shop delivers an order, as the list of the delivery methods gives them
    delivery: DeliveryMethodInfoDto[];
}

export interface BuildChatBotPromptResultDto {
    instructions: string;
    messages: AiMessageDto[];
}

const MAX_HISTORY_MESSAGES = 12;
const MAX_PRODUCT_CONTEXT_ITEMS = 6;
// the variants of a product the prompt names one by one; a product with more is summed up, so the
// prompt (a paid input of every turn) does not grow with the variants of a shop
export const MAX_VARIANTS_PER_PRODUCT = 20;
// the longest description of a product the prompt carries
const MAX_DESCRIPTION_CHARS = 500;

// what a status means to the customer of a pickup: the order waits at the shop, it is not on its way
const PICKUP_STATUS_MEANINGS: Partial<Record<ChatBotOrderStatus, string>> = {
    paid: 'paid, being prepared',
    shipped: 'ready, waiting for the customer to collect it',
    delivered: 'collected by the customer',
};

// what a status means to the customer, the words the model answers "where is my order" with
const ORDER_STATUS_MEANINGS: Record<ChatBotOrderStatus, string> = {
    unconfirmed:
        'not confirmed: the customer has to confirm it again before paying',
    waiting: 'confirmed, waiting for the payment',
    paid: 'paid, being prepared for shipping',
    shipped: 'sent, on its way to the customer',
    delivered: 'delivered to the customer',
    cancelled: 'cancelled, the money goes back to the card',
};

// where an order stands as to its statements of withdrawal and return
const RETURN_STATUS_MEANINGS: Record<ReturnStatus, string | null> = {
    none: null,
    open: 'a statement of withdrawal or return is open, no money went back yet',
    open_partial: 'a statement is open and part of the money went back',
    partial: 'all statements are closed and part of the money went back',
    full: 'all statements are closed and all the money went back',
    declined: 'all statements are closed and no money went back',
};

// where a statement stands for its buyer
const RETURN_STEP_MEANINGS: Record<BuyerReturnStep, string> = {
    received: 'registered',
    proof_provided: 'the customer told of the parcel, the shop has not confirmed it yet',
    proof_confirmed: 'the shop confirmed the parcel',
    closed: 'closed',
};

// what the money of a unit was in the words of the customer: refused by a reason of the shop or
// because the goods never came
const REFUSAL_MEANINGS: Record<string, string> = {
    not_arrived: 'the goods never arrived',
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

// a list of words as a sentence: a, b or c
const listWithOr = (words: string[]): string =>
    words.length < 2
        ? words.join('')
        : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;

// the ways the shop delivers an order, the only facts of the delivery the model may name
const describeDelivery = (
    methods: DeliveryMethodInfoDto[],
    currency: string,
): string[] => {
    if (methods.length === 0) return [];

    const lines = methods.map((method) => {
        if (method.method === 'pickup') {
            const hours = method.hours ? ` (${method.hours})` : '';
            return `- pickup: the customer collects the order at ${method.address ?? 'the shop'}${hours}; it costs nothing.`;
        }

        const price =
            method.price > 0
                ? `the delivery costs ${method.price} ${currency}${
                      method.freeFrom !== null
                          ? `, and nothing when the items cost ${method.freeFrom} ${currency} or more`
                          : ''
                  }.`
                : 'the delivery costs nothing.';
        return `- by hand: the shop sends the order to an address in ${listWithOr(method.countries)}; ${price}`;
    });

    return [
        methods.length === 1
            ? 'The shop delivers an order this way:'
            : 'The shop delivers an order in these ways, the customer picks one when confirming the order:',
        ...lines,
        'Name no other delivery method, country, price, carrier or delivery time than these.',
    ];
};

// builds the permanent behavior rules for the assistant of the shop (SHOP_NAME)
const buildSystemInstructions = (
    actorRole: ChatBotActorRole,
    emailConfirmed: boolean,
    orders: ChatBotOrderContextItemDto[],
    currency: string,
    paymentProviders: string[],
    delivery: DeliveryMethodInfoDto[],
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
        'A product has one or more variants (a size, a color, a memory): the customer buys a variant, and the price, the sale and the stock are the variant\'s. When you recommend, name a concrete variant by its name and its price; recommend only a variant that is listed and in stock.',
        'A variant with a sale price sells at the sale price until the end of the sale; its price is the usual one, name it only next to the sale price.',
        'in stock is the number of units of the variant free to buy now; never promise more of a variant than that.',
        `Payment is by card only, ${describePaymentPage(paymentProviders)}. There are no other payment methods: no PayPal, no cash, no bank transfer.`,
        ...describeDelivery(delivery, currency),
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

// formats one variant for prompt context
const formatVariantContextItem = (
    variant: ChatBotVariantContextItemDto,
    currency: string,
): string => {
    const parts = [
        `variant id: ${variant.id}`,
        `name: ${variant.name}`,
        `price: ${variant.price} ${currency}`,
        ...(variant.sale
            ? [
                  `sale price: ${variant.sale.price} ${currency} until ${variant.sale.endsAt} (UTC)`,
              ]
            : []),
        ...(variant.sale?.priorPrice != null
            ? [
                  `lowest price of the 30 days before the sale: ${variant.sale.priorPrice} ${currency}`,
              ]
            : []),
        `in stock: ${variant.stock}`,
    ];

    return parts.join('; ');
};

// the price a variant sells at now: the sale price while the sale lasts
const sellingPriceOf = (variant: ChatBotVariantContextItemDto): number =>
    variant.sale?.price ?? variant.price;

// the variants of a product that the prompt names: those with free units first, each group in the
// order of the product, no more than MAX_VARIANTS_PER_PRODUCT; the others are summed up
const splitVariants = (variants: ChatBotVariantContextItemDto[]) => {
    const ordered = [
        ...variants.filter((variant) => variant.stock > 0),
        ...variants.filter((variant) => variant.stock <= 0),
    ];

    return {
        listed: ordered.slice(0, MAX_VARIANTS_PER_PRODUCT),
        left: ordered.slice(MAX_VARIANTS_PER_PRODUCT),
    };
};

// the variants that are not named one by one: how many, how many are in stock, the prices
const formatLeftVariants = (
    left: ChatBotVariantContextItemDto[],
    currency: string,
): string | null => {
    if (left.length === 0) return null;

    const prices = left.map(sellingPriceOf);
    const inStock = left.filter((variant) => variant.stock > 0).length;

    return `  - ${left.length} more variants are not listed (${inStock} of them in stock), they sell at ${Math.min(...prices)} to ${Math.max(...prices)} ${currency}; name no detail of them`;
};

// formats one product for prompt context: the product, then its variants one per line
const formatProductContextItem = (
    product: ChatBotProductContextItemDto,
    currency: string,
): string => {
    const parts = [
        `product id: ${product.id}`,
        `name: ${product.name}`,
        `category: ${product.categoryName ?? 'unknown'}`,
    ];

    const description = product.description?.trim();
    if (description) {
        parts.push(
            `description: ${
                description.length > MAX_DESCRIPTION_CHARS
                    ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}...`
                    : description
            }`,
        );
    }

    if (typeof product.popularity === 'number') {
        parts.push(`popularity: ${product.popularity}`);
    }

    const { listed, left } = splitVariants(product.variants);
    const lines = [
        parts.join('; '),
        '  variants:',
        ...listed.map((variant) => `  - ${formatVariantContextItem(variant, currency)}`),
    ];
    const summary = formatLeftVariants(left, currency);
    if (summary) lines.push(summary);

    return lines.join('\n');
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
            'Use only this product context when recommending specific products and variants.',
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

    // an order with an event the bot does not talk about is for an admin, nothing else is told
    if (order.unusual) {
        return `order ${order.id}: HUMAN ONLY, an admin handles this order`;
    }

    const meaning =
        (order.delivery?.method === 'pickup' && PICKUP_STATUS_MEANINGS[order.status]) ||
        ORDER_STATUS_MEANINGS[order.status];

    return [
        `order ${order.id}: ${order.status} (${meaning})`,
        `total ${order.total} ${currency}`,
        `placed ${order.createdAt} (UTC)`,
        ...(order.paidAt ? [`paid ${order.paidAt} (UTC)`] : []),
        ...(order.delivery ? [describeOrderDelivery(order.delivery, currency)] : []),
        ...(order.shipment ? [describeShipment(order.shipment)] : []),
        `items: ${items}`,
        ...describeOrderReturns(order, currency),
    ].join('; ');
};

// how an order goes to the customer: the country and the price, not the address
const describeOrderDelivery = (
    delivery: NonNullable<ChatBotOrderContextItemDto['delivery']>,
    currency: string,
): string =>
    delivery.method === 'pickup'
        ? 'delivery: pickup at the shop'
        : `delivery: by hand to ${delivery.country ?? 'the address given'} for ${delivery.price} ${currency}`;

// what the admin wrote of the send: the carrier, the number, the link
const describeShipment = (
    shipment: NonNullable<ChatBotOrderContextItemDto['shipment']>,
): string => {
    const parts = [
        ...(shipment.carrier ? [`carrier ${shipment.carrier}`] : []),
        ...(shipment.trackingNumber
            ? [`tracking number ${shipment.trackingNumber}`]
            : []),
        ...(shipment.trackingUrl
            ? [`tracking link ${shipment.trackingUrl}`]
            : []),
    ];

    return `send: ${parts.length ? parts.join(', ') : 'no carrier or tracking number was given'}`;
};

// the money of the units of a statement, one part per state: refunded (with the day), on its way,
// not refunded yet, refused (with the reason)
const describeReturnMoney = (
    items: ChatBotReturnContextItemDto['items'],
    currency: string,
): string => {
    const parts: string[] = [];

    for (const money of ['refunded', 'pending', 'not_refunded', 'refused'] as const) {
        const rows = items.filter((item) => item.money === money);
        if (rows.length === 0) continue;

        const units = rows.reduce((sum, item) => sum + item.quantity, 0);
        const amount =
            Math.round(rows.reduce((sum, item) => sum + item.amount + item.deliveryAmount, 0) * 100) /
            100;
        const days = rows.flatMap((item) => (item.refundedAt ? [item.refundedAt] : [])).sort();
        const reasons = [
            ...new Set(rows.flatMap((item) => (item.refusal ? [item.refusal] : []))),
        ].map((reason) => REFUSAL_MEANINGS[reason] ?? reason.replace(/_/g, ' '));

        parts.push(
            money === 'refunded'
                ? `refunded ${amount} ${currency} for ${units} unit(s)${days.length ? ` on ${days.at(-1)} (UTC)` : ''}`
                : money === 'pending'
                  ? `${amount} ${currency} for ${units} unit(s) is on its way to the card`
                  : money === 'not_refunded'
                    ? `${amount} ${currency} for ${units} unit(s) is not refunded yet`
                    : `${amount} ${currency} for ${units} unit(s) is refused${reasons.length ? ` (${reasons.join(', ')})` : ''}`,
        );
    }

    return parts.join('; ');
};

// what the customer may still do about the contract of an order, and what they have done
const describeOrderReturns = (
    order: ChatBotOrderContextItemDto,
    currency: string,
): string[] => {
    const lines: string[] = [];
    const withdrawal = order.withdrawal;

    if (withdrawal?.open) {
        const noRight = withdrawal.noRight.length
            ? `; no right of withdrawal for ${withdrawal.noRight.join(', ')}`
            : '';

        lines.push(
            withdrawal.free.length > 0
                ? `withdrawal: the customer may still withdraw from the contract for ${withdrawal.free
                      .map((one) => `${one.name} x ${one.quantity}`)
                      .join(', ')}, ${
                      withdrawal.endsAt && withdrawal.late
                          ? `the period of the contract ended ${withdrawal.endsAt} (UTC), the shop still takes a statement for now`
                          : withdrawal.endsAt
                            ? `until ${withdrawal.endsAt} (UTC)`
                            : 'the period starts with the delivery'
                  }${noRight}`
                : // nothing free: the goods have no right, or every unit that has one is stated
                  withdrawal.noRight.length === order.items.length
                  ? `withdrawal: the goods of this order have no right of withdrawal (${withdrawal.noRight.join(', ')})`
                  : withdrawal.noRight.length === 0
                    ? 'withdrawal: every unit is already in a statement, nothing is left to state'
                    : `withdrawal: every unit that can be withdrawn from is already in a statement, nothing is left to state${noRight}`,
        );
    } else if (withdrawal) {
        lines.push(
            `withdrawal: the period is over${withdrawal.endsAt ? ` (it ended ${withdrawal.endsAt} UTC)` : ''}`,
        );
    }

    const status = RETURN_STATUS_MEANINGS[order.returnStatus];
    if (status) lines.push(`returns: ${status}`);

    for (const statement of order.returns) {
        lines.push(
            `statement ${statement.id} (stated ${statement.statedAt} UTC): ${RETURN_STEP_MEANINGS[statement.step]}; money: ${describeReturnMoney(statement.items, currency)}`,
        );
    }

    return lines;
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
            'You cannot file a withdrawal or a return and you never promise that one will be accepted or refunded. A customer who wants to withdraw from the contract uses the button "Withdraw from the contract here" in the order, a function of the website; point to it. Say only what the order data above tells: whether the customer may still withdraw, until when, for how many units, and where the money is. You do not know what the shop does with the goods after the customer sends them, or why an order was cancelled; say so.',
            ...(orders.some((order) => order.unusual)
                ? [
                      'An order marked HUMAN ONLY is for an admin: say nothing of its status, items, delivery or payment, tell the customer that an admin will look into it, and set escalate to true with the reason HUMAN_REQUIRED.',
                  ]
                : []),
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
            dto.delivery,
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
