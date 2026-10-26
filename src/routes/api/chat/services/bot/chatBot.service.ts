import { expiredUnitsOf, freeUnits } from '@db/expiredStock.helper.js';
import { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { isRetryableTxError, prisma, tx } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import { parseProductDescription } from '@helpers/productDescription.js';
import { isSaleOn } from '@helpers/productSale.js';
import {
    paymentProviders,
    shopCurrency,
} from '@routes/api/payments/providers/index.js';
import {
    askAiForBotReply,
    askAiForBotText,
    type ChatBotLogger,
} from './chatBotAi.service.js';
import {
    BadRequestError,
    ForbiddenError,
    InternalError,
    isAppError,
    NotFoundError,
    ResourceBusyError,
} from '@utils/errors.js';

import {
    buildChatBotPrompt,
    ChatBotActorRole,
    ChatBotHistoryMessageDto,
    ChatBotOrderContextItemDto,
    ChatBotOrderStatus,
    ChatBotProductContextItemDto,
} from './chatBotPrompt.service.js';
import { evaluateChatBotEscalation } from './chatBotEscalation.service.js';

import type {
    ChatMessageItemDto,
    ChatThreadItemDto,
} from 'types/dto/chats.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

interface HandleChatBotTurnDto {
    actorId: UserId;
    actorRole: Role;
    threadId: string;
    userMessageId: number;
    userMessage: string;
    log: ChatBotLogger;
}

interface HandleChatBotTurnResultDto {
    thread: ChatThreadItemDto | null;
    botMessage: ChatMessageItemDto | null;
    adminPending: boolean;
}

interface LoadedChatBotContextDto {
    thread: ChatThreadItemDto;
    history: ChatBotHistoryMessageDto[];
    productContext: ChatBotProductContextItemDto[];
    // the last orders of a user, none for a guest
    orders: ChatBotOrderContextItemDto[];
    // only a user who confirmed the email talks to an admin
    emailConfirmed: boolean;
    // the answers the customer got from the bot in the last 24 hours
    recentTurns: number;
}

// what the bot writes in its turn, and whether the chat goes to the admins with it
interface ChatBotTurnPlanDto {
    text: string;
    toAdmin: boolean;
}

// who the customer is to the admin chat: only a user with a confirmed email talks to an admin
type AdminAccess = 'guest' | 'unconfirmed' | 'allowed';

interface BotMessageWriteResultDto {
    thread: ChatThreadItemDto;
    botMessage: ChatMessageItemDto;
}

const BOT_FALLBACK_MESSAGE =
    'I cannot answer reliably right now. Please try again later or ask for admin support.';

// the fixed texts of a request for an admin, by who asks: the fallback text as it is and the
// meaning the model puts in the language of the customer
const ADMIN_REQUEST_TEXTS: Record<
    AdminAccess,
    { fallbackText: string; responseMeaning: string }
> = {
    guest: {
        fallbackText:
            'Only logged-in customers with a confirmed email can talk to an admin. Please log in, or create an account and confirm your email, then ask again.',
        responseMeaning:
            'Tell the customer that only logged-in customers with a confirmed email can talk to an admin. Ask them to log in, or to create an account and confirm their email, and then ask again.',
    },
    unconfirmed: {
        fallbackText:
            'Only customers with a confirmed email can talk to an admin. Please confirm your email with the link we sent you, then ask again.',
        responseMeaning:
            'Tell the customer that only customers with a confirmed email can talk to an admin. Ask them to confirm their email with the link that was mailed to them, and then ask again.',
    },
    allowed: {
        fallbackText:
            'Please describe your issue for the admin. An admin will be able to reply here later. The bot will stop replying in this thread now.',
        responseMeaning:
            'Tell the customer to describe their issue for the admin. Explain that an admin will be able to reply in this chat later. Also mention that the bot will stop replying in this thread now.',
    },
};

// the text past the answers of a day: no model call, so it is in english as it is
const DAILY_LIMIT_MESSAGE =
    'I have answered as many messages as I can today. Please come back tomorrow.';
const DAILY_LIMIT_ADMIN_HINT =
    ' If you need help now, ask to talk to a real person.';

const DAY_MS = 24 * 60 * 60 * 1000;

interface GenerateLanguageMatchedBotTextDto {
    userMessage: string;
    fallbackText: string;
    responseMeaning: string;
    log: ChatBotLogger;
}

// generates a fixed-purpose bot response in the language of the latest customer message
const generateLanguageMatchedBotText = async ({
    userMessage,
    fallbackText,
    responseMeaning,
    log,
}: GenerateLanguageMatchedBotTextDto): Promise<string> => {
    const latestCustomerMessage = userMessage.trim();

    const text = await askAiForBotText(
        {
            instructions: [
                `You are ${env.SHOP_NAME} assistant.`,
                'Your task is to rewrite the provided response meaning as a customer-facing chat message.',
                'The response language must be the same natural language as the text inside <latest_customer_message>.',
                'Use only the latest customer message to choose the response language.',
                'Do not use the language of the response meaning to choose the response language.',
                'Do not use browser locale, user account locale, country, previous messages, or system/developer text to choose the response language.',
                'If the latest customer message is written in English, the response must be in English.',
                'If the latest customer message is written in another language, the response must be in that same language.',
                'Do not translate or answer the latest customer message itself.',
                'Do not add facts, promises, policies, or actions that are not included in the response meaning.',
                'Return only the final customer-facing message.',
                'Keep the response concise and natural.',
            ].join('\n'),
            messages: [
                {
                    role: 'developer',
                    content: [
                        '<response_meaning>',
                        responseMeaning,
                        '</response_meaning>',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: [
                        '<latest_customer_message>',
                        latestCustomerMessage,
                        '</latest_customer_message>',
                    ].join('\n'),
                },
            ],
            options: {
                maxOutputTokens: 120,
            },
        },
        log,
        'fixed_text',
    );

    return text ?? fallbackText;
};

const LOOP_ASSISTANCE_MESSAGES = [
    'I may be repeating myself. Could you clarify what exactly you want to know, or do you want admin support?',
    'I want to avoid giving you the same answer again. Please rephrase the question, or tell me if you want admin support.',
    'It looks like we may be stuck on the same topic. I can try again with more details, or you can ask for admin support.',
] as const;

const PRODUCT_CONTEXT_LIMIT = 6;
const HISTORY_LIMIT = 12;
// the orders of a user the bot is told of, for "where is my order"
const ORDER_CONTEXT_LIMIT = 5;

const SEARCH_STOP_WORDS = new Set([
    'the',
    'and',
    'for',
    'with',
    'this',
    'that',
    'have',
    'need',
    'want',
    'show',
    'find',
    'give',
    'cheap',
    'budget',
    'product',
    'products',
]);

// normalizes numeric user ids used by user-owned chat threads
const toUserId = (actorId: string | number): number => {
    const id = typeof actorId === 'number' ? actorId : Number(actorId);

    if (!Number.isInteger(id) || id <= 0) {
        throw new BadRequestError('USER_ID_INVALID');
    }

    return id;
};

// ensures that only customer roles can trigger the bot
const getChatBotActorRole = (actorRole: Role): ChatBotActorRole => {
    if (actorRole === 'GUEST' || actorRole === 'USER') {
        return actorRole;
    }

    throw new ForbiddenError('CHAT_BOT_FORBIDDEN');
};

// validates customer ownership of the target thread
const assertCustomerThreadAccess = (
    actorId: UserId,
    actorRole: ChatBotActorRole,
    thread: ChatThreadItemDto,
): void => {
    if (actorRole === 'GUEST' && thread.guestId !== String(actorId)) {
        throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
    }

    if (actorRole === 'USER' && thread.userId !== toUserId(actorId)) {
        throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
    }
};

// converts prisma chat messages into prompt history messages
const mapHistoryMessages = (
    messages: ChatMessageItemDto[],
): ChatBotHistoryMessageDto[] => {
    return messages
        .filter((message) => {
            return (
                message.senderType === 'user' ||
                message.senderType === 'guest' ||
                message.senderType === 'bot'
            );
        })
        .map((message) => ({
            senderType:
                message.senderType as ChatBotHistoryMessageDto['senderType'],
            content: message.content,
            createdAt: message.createdAt,
        }));
};

// extracts simple searchable terms from the customer message
const extractSearchTerms = (message: string): string[] => {
    const normalized = message
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalized) {
        return [];
    }

    return Array.from(new Set(normalized.split(' ')))
        .filter((term) => term.length >= 3)
        .filter((term) => !SEARCH_STOP_WORDS.has(term))
        .slice(0, 6);
};

// a product the bot may recommend has free units: stock not taken by confirmed orders
const IN_STOCK = { gt: prisma.product.fields.reservedStock };

// and is one the catalog lists: of the catalog, with an image
const LISTED = { deletedAt: null, images: { some: { isPrimary: true } } };

// builds product search conditions from extracted terms
const buildProductSearchWhere = (terms: string[]): Prisma.ProductWhereInput => {
    if (terms.length === 0) {
        return {
            ...LISTED,
            stock: IN_STOCK,
        };
    }

    return {
        ...LISTED,
        stock: IN_STOCK,
        OR: terms.flatMap((term) => [
            {
                name: {
                    contains: term,
                    mode: Prisma.QueryMode.insensitive,
                },
            },
            {
                description: {
                    contains: term,
                    mode: Prisma.QueryMode.insensitive,
                },
            },
            {
                category: {
                    name: {
                        contains: term,
                        mode: Prisma.QueryMode.insensitive,
                    },
                },
            },
        ]),
    };
};

// converts product rows into compact prompt context items; a product whose free units are all
// gone (held by waiting orders or in batches that are over) is no product to recommend
const mapProductContext = (
    products: Awaited<ReturnType<typeof findProductsForBotContext>>,
    expired: Map<number, number>,
): ChatBotProductContextItemDto[] => {
    return products
        .filter(
            (product) =>
                freeUnits(
                    product.stock,
                    product.reservedStock,
                    expired.get(product.id) ?? 0,
                ) > 0,
        )
        .map((product) => ({
            id: product.id,
            name: product.name,
            price: Number(product.price),
            // the sale while it lasts, the one the catalog shows next to the price
            sale: isSaleOn(product)
                ? {
                      price: Number(product.salePrice),
                      endsAt: product.saleEndsAt!.toISOString(),
                      priorPrice:
                          product.salePriorPrice === null
                              ? null
                              : Number(product.salePriorPrice),
                  }
                : null,
            // free units, never below zero, the stock the catalog shows
            stock: freeUnits(
                product.stock,
                product.reservedStock,
                expired.get(product.id) ?? 0,
            ),
            categoryName: product.category.name,
            // the text of the description, without the safety data it keeps
            description: parseProductDescription(product.description).text,
            popularity: product.popularity,
        }));
};

// loads matching products for the bot prompt
const findProductsForBotContext = async (
    db: Prisma.TransactionClient,
    userMessage: string,
) => {
    const terms = extractSearchTerms(userMessage);
    const where = buildProductSearchWhere(terms);

    const products = await db.product.findMany({
        where,
        include: {
            category: {
                select: {
                    name: true,
                },
            },
        },
        orderBy: [
            {
                popularity: 'desc',
            },
            {
                views: 'desc',
            },
            {
                id: 'asc',
            },
        ],
        take: PRODUCT_CONTEXT_LIMIT,
    });

    if (products.length > 0 || terms.length === 0) {
        return products;
    }

    return db.product.findMany({
        where: {
            ...LISTED,
            stock: IN_STOCK,
        },
        include: {
            category: {
                select: {
                    name: true,
                },
            },
        },
        orderBy: [
            {
                popularity: 'desc',
            },
            {
                views: 'desc',
            },
            {
                id: 'asc',
            },
        ],
        take: PRODUCT_CONTEXT_LIMIT,
    });
};

// loads thread, recent history, and product context for one bot turn
const loadChatBotContext = async ({
    actorId,
    actorRole,
    threadId,
    userMessageId,
    userMessage,
}: HandleChatBotTurnDto): Promise<LoadedChatBotContextDto | null> => {
    const chatBotActorRole = getChatBotActorRole(actorRole);

    return prisma.$transaction(async (db) => {
        // applies RLS context for reading customer thread data
        await setActorContext(db, {
            actorId,
            role: actorRole,
        });

        // loads target thread before deciding if bot is still allowed to answer
        const thread = await db.chatThread.findUnique({
            where: {
                id: threadId,
            },
        });

        // fails if the thread disappeared between customer message and bot turn
        if (!thread) {
            throw new NotFoundError('CHAT_THREAD_NOT_FOUND');
        }

        // validates that this customer owns the thread
        assertCustomerThreadAccess(actorId, chatBotActorRole, thread);

        // stops bot processing for closed or already escalated threads
        if (thread.status !== 'open' || thread.type !== 'bot') {
            return null;
        }

        // loads recent history without duplicating the current customer message
        const historyMessages = await db.chatMessage.findMany({
            where: {
                threadId,
                id: {
                    not: userMessageId,
                },
            },
            orderBy: {
                createdAt: 'desc',
            },
            take: HISTORY_LIMIT,
        });

        // loads compact product context for shopping-related answers
        const productRows = await findProductsForBotContext(db, userMessage);

        const userId = chatBotActorRole === 'USER' ? toUserId(actorId) : null;

        // returns prompt-ready context in chronological order
        return {
            thread,
            history: mapHistoryMessages(historyMessages.reverse()),
            productContext: mapProductContext(
                productRows,
                await expiredUnitsOf(
                    db,
                    productRows.map((product) => product.id),
                ),
            ),
            orders: userId ? await findOrdersForBotContext(db, userId) : [],
            emailConfirmed: userId ? await isEmailConfirmed(db, userId) : false,
            recentTurns: await countRecentBotTurns(
                db,
                chatBotActorRole,
                actorId,
            ),
        };
    });
};

// the last orders of the user under their own rights, newest first; the cart is no order
const findOrdersForBotContext = async (
    db: Prisma.TransactionClient,
    userId: number,
): Promise<ChatBotOrderContextItemDto[]> => {
    const orders = await db.order.findMany({
        where: { userId, status: { not: 'pending' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: ORDER_CONTEXT_LIMIT,
        select: {
            id: true,
            status: true,
            total: true,
            createdAt: true,
            paidAt: true,
            items: {
                orderBy: { id: 'asc' },
                select: {
                    quantity: true,
                    productName: true,
                    product: { select: { name: true } },
                },
            },
        },
    });

    return orders.map((order) => ({
        id: order.id,
        status: order.status as ChatBotOrderStatus,
        total: Number(order.total),
        createdAt: order.createdAt.toISOString(),
        paidAt: order.paidAt?.toISOString() ?? null,
        // the name an item was confirmed with, the one of now for an unconfirmed order
        items: order.items.map((item) => ({
            name:
                (order.status !== 'unconfirmed' && item.productName) ||
                item.product.name,
            quantity: item.quantity,
        })),
    }));
};

const isEmailConfirmed = async (
    db: Prisma.TransactionClient,
    userId: number,
) => {
    const user = await db.user.findUnique({
        where: { id: userId },
        select: { isVerified: true },
    });

    return user?.isVerified === true;
};

// the answers the bot gave the customer in the last 24 hours, in all of their chats; the welcome
// that opens a chat is the first message of it and no answer
const countRecentBotTurns = async (
    db: Prisma.TransactionClient,
    actorRole: ChatBotActorRole,
    actorId: UserId,
): Promise<number> => {
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const owner =
        actorRole === 'GUEST'
            ? Prisma.sql`t."guestId" = ${String(actorId)}::uuid`
            : Prisma.sql`t."userId" = ${toUserId(actorId)}`;

    const rows = await db.$queryRaw<{ turns: number }[]>`
        SELECT count(*)::int AS turns
        FROM cartlify.chat_messages m
        JOIN cartlify.chat_threads t ON t.id = m."threadId"
        WHERE ${owner}
          AND m."senderType" = 'bot'
          AND m."createdAt" > (${since}::timestamptz AT TIME ZONE 'UTC')
          AND EXISTS (
              SELECT 1 FROM cartlify.chat_messages p
              WHERE p."threadId" = m."threadId" AND p.id < m.id
          )
    `;

    return rows[0]?.turns ?? 0;
};

// generates fallback text in the customer's latest language when AI answer fails
const generateFallbackBotText = async (
    userMessage: string,
    log: ChatBotLogger,
): Promise<string> => {
    return generateLanguageMatchedBotText({
        userMessage,
        log,
        fallbackText: BOT_FALLBACK_MESSAGE,
        responseMeaning:
            'Tell the customer that the assistant cannot answer reliably right now. Ask them to try again later or ask for admin support.',
    });
};

// asks the model for the answer with its decision whether a human admin is needed; null when it
// gave no usable answer
const askModelForReply = (
    context: LoadedChatBotContextDto,
    actorRole: ChatBotActorRole,
    userMessage: string,
    log: ChatBotLogger,
) => {
    // builds the prompt of the shop outside the low-level OpenAI wrapper
    const prompt = buildChatBotPrompt({
        actorRole,
        emailConfirmed: context.emailConfirmed,
        userMessage,
        history: context.history,
        productContext: context.productContext,
        orders: context.orders,
        // the currency checkout charges in, so the bot names the same one
        currency: shopCurrency(),
        paymentProviders: paymentProviders.map((provider) => provider.label),
    });

    // a broken answer is asked once more, a failure is not
    return askAiForBotReply(
        { instructions: prompt.instructions, messages: prompt.messages },
        log,
    );
};

const adminAccessOf = (
    actorRole: ChatBotActorRole,
    emailConfirmed: boolean,
): AdminAccess =>
    actorRole === 'GUEST'
        ? 'guest'
        : emailConfirmed
          ? 'allowed'
          : 'unconfirmed';

// the answer to a request for an admin: a user with a confirmed email is asked to describe the
// issue and the chat goes to the admins, that description is what they read first; anyone else is
// told who talks to an admin. With the model, the text comes in the language of the customer
const planAdminRequest = async (
    access: AdminAccess,
    userMessage: string,
    log: ChatBotLogger,
    withModel: boolean,
): Promise<ChatBotTurnPlanDto> => {
    const texts = ADMIN_REQUEST_TEXTS[access];
    const text = withModel
        ? await generateLanguageMatchedBotText({ userMessage, log, ...texts })
        : texts.fallbackText;

    return { text, toAdmin: access === 'allowed' };
};

// generates loop-assistance response in the customer's latest language
const generateLoopAssistanceBotText = async (
    userMessage: string,
    log: ChatBotLogger,
): Promise<string> => {
    return generateLanguageMatchedBotText({
        userMessage,
        log,
        fallbackText: LOOP_ASSISTANCE_MESSAGES[0],
        responseMeaning:
            'Tell the customer that the conversation may be repeating. Ask them to clarify what exactly they want to know, or ask whether they want admin support. Do not say that admin support is required.',
    });
};

// decides the turn: an explicit request for a person and a loop are found before the model and
// take one call of it, for the text in the language of the customer; past the answers of the day
// the model is asked nothing; otherwise the model answers and decides by meaning whether a person
// is needed
const planBotTurn = async (
    context: LoadedChatBotContextDto,
    actorRole: ChatBotActorRole,
    userMessage: string,
    log: ChatBotLogger,
): Promise<ChatBotTurnPlanDto> => {
    const access = adminAccessOf(actorRole, context.emailConfirmed);
    const limit =
        actorRole === 'GUEST'
            ? env.CHAT_BOT_GUEST_DAILY_TURNS
            : env.CHAT_BOT_USER_DAILY_TURNS;
    const withModel = context.recentTurns < limit;

    const signal = evaluateChatBotEscalation({
        userMessage,
        history: context.history,
    });

    if (signal.reason === 'DIRECT_ADMIN_REQUEST') {
        return planAdminRequest(access, userMessage, log, withModel);
    }

    if (signal.reason === 'LOOP_DETECTED') {
        return {
            text: withModel
                ? await generateLoopAssistanceBotText(userMessage, log)
                : LOOP_ASSISTANCE_MESSAGES[0],
            toAdmin: false,
        };
    }

    if (!withModel) {
        return {
            text:
                DAILY_LIMIT_MESSAGE +
                (access === 'allowed' ? DAILY_LIMIT_ADMIN_HINT : ''),
            toAdmin: false,
        };
    }

    const answer = await askModelForReply(context, actorRole, userMessage, log);

    // keeps customer chat working even when AI provider fails, there is no decision then
    if (!answer) {
        return {
            text: await generateFallbackBotText(userMessage, log),
            toAdmin: false,
        };
    }

    // the model decided by meaning, in any language, that a person is needed
    if (answer.escalate)
        return planAdminRequest(access, userMessage, log, true);

    return { text: answer.reply, toAdmin: false };
};

// writes the answer of the bot and, when the plan says so, gives the chat to the admins in the
// same transaction: a bot that promised an admin always leaves the chat with one
const writeBotTurn = async ({
    actorId,
    actorRole,
    threadId,
    content,
    toAdmin,
}: {
    actorId: UserId;
    actorRole: ChatBotActorRole;
    threadId: string;
    content: string;
    toAdmin: boolean;
}): Promise<BotMessageWriteResultDto | null> => {
    return tx(
        async (db) => {
            // applies customer context so RLS allows writing inside this thread
            await setActorContext(db, {
                actorId,
                role: actorRole,
            });

            // keeps lock short and avoids waiting too long on busy chat rows
            await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

            // locks the thread before adding bot response
            const lockedThreads = await db.$queryRaw<ChatThreadItemDto[]>`
        SELECT id, "userId", "guestId", type, status, "lastMessageAt",
               "unreadCount", "adminRequestedAt", "adminUnreadSince",
               "lastMessagePreview", "createdAt", "updatedAt"
        FROM cartlify.chat_threads
        WHERE id = ${threadId}::uuid
        FOR UPDATE
      `;

            const lockedThread = lockedThreads[0];

            // fails if thread no longer exists
            if (!lockedThread) {
                throw new NotFoundError('CHAT_THREAD_NOT_FOUND');
            }

            // validates that customer still owns this thread
            assertCustomerThreadAccess(actorId, actorRole, lockedThread);

            // does not let bot answer after close or admin escalation
            if (lockedThread.status !== 'open' || lockedThread.type !== 'bot') {
                return null;
            }

            // stores bot message in the same thread
            const botMessage = await db.chatMessage.create({
                data: {
                    threadId,
                    senderId: null,
                    senderType: 'bot',
                    content,
                },
            });

            // updates thread preview and last-message timestamp; a chat given to the admins waits
            // from now, it enters their queue with the next message of the customer
            const thread = await db.chatThread.update({
                where: {
                    id: threadId,
                },
                data: {
                    lastMessageAt: botMessage.createdAt,
                    lastMessagePreview: content.slice(0, 120),
                    ...(toAdmin && {
                        type: 'admin',
                        adminRequestedAt: botMessage.createdAt,
                    }),
                },
            });

            return {
                thread,
                botMessage,
            };
        },
        {
            maxRetries: 3,
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 1500,
            timeout: 10_000,
        },
    );
};

// handles one full bot turn after customer message is already saved
export const handleChatBotTurn = async (
    dto: HandleChatBotTurnDto,
): Promise<HandleChatBotTurnResultDto> => {
    const actorRole = getChatBotActorRole(dto.actorRole);

    try {
        // loads all data needed to decide and answer
        const context = await loadChatBotContext(dto);

        // returns no bot output if thread is no longer a bot thread
        if (!context) {
            return {
                thread: null,
                botMessage: null,
                adminPending: false,
            };
        }

        const plan = await planBotTurn(
            context,
            actorRole,
            dto.userMessage,
            dto.log,
        );

        // saves the bot message, and gives the chat to the admins with it
        const writeResult = await writeBotTurn({
            actorId: dto.actorId,
            actorRole,
            threadId: dto.threadId,
            content: plan.text,
            toAdmin: plan.toAdmin,
        });

        // returns no bot output if another process already closed/escalated the thread
        if (!writeResult) {
            return {
                thread: null,
                botMessage: null,
                adminPending: false,
            };
        }

        return {
            thread: writeResult.thread,
            botMessage: writeResult.botMessage,
            adminPending: plan.toAdmin,
        };
    } catch (err) {
        // preserves known application errors
        if (isAppError(err)) {
            throw err;
        }

        // maps retryable transaction errors to stable resource-busy error
        if (isRetryableTxError(err)) {
            throw new ResourceBusyError();
        }

        // wraps unexpected bot failures into internal app error
        throw new InternalError({ reason: 'CHAT_BOT_TURN_UNEXPECTED' }, err);
    }
};

export const chatBotService = {
    handleChatBotTurn,
};
