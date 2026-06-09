import { Prisma } from '@prisma/client';

import { isRetryableTxError, prisma, tx } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import { aiClientService } from '@services/ai/aiClient.service.js';
import {
    BadRequestError,
    ConflictError,
    ForbiddenError,
    InternalError,
    isAppError,
    NotFoundError,
    ResourceBusyError,
} from '@utils/errors.js';

import { requestAdminService } from '../requestAdmin.service.js';
import {
    buildChatBotPrompt,
    ChatBotActorRole,
    ChatBotHistoryMessageDto,
    ChatBotProductContextItemDto,
} from './chatBotPrompt.service.js';
import {
    ChatBotEscalationResultDto,
    evaluateChatBotEscalation,
} from './chatBotEscalation.service.js';

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
}

interface BotMessageWriteResultDto {
    thread: ChatThreadItemDto;
    botMessage: ChatMessageItemDto;
}

const BOT_FALLBACK_MESSAGE =
    'I cannot answer reliably right now. Please try again later or ask for admin support.';

const GUEST_ADMIN_REQUIRED_MESSAGE =
    'To contact an admin, please log in or create an account first. After that, I will be able to transfer your chat to an admin.';

const USER_ADMIN_TRANSFER_MESSAGE =
    'I will transfer this chat to an admin. The bot will stop replying in this thread now.';

interface GenerateLanguageMatchedBotTextDto {
    userMessage: string;
    fallbackText: string;
    responseMeaning: string;
}

// generates a fixed-purpose bot response in the language of the latest customer message
const generateLanguageMatchedBotText = async ({
    userMessage,
    fallbackText,
    responseMeaning,
}: GenerateLanguageMatchedBotTextDto): Promise<string> => {
    try {
        const result = await aiClientService.generateText({
            instructions: [
                'You are Cartlify assistant.',
                'Write the response in the same natural language as the latest customer message.',
                'Use the latest customer message only to detect the response language.',
                'Do not answer the customer question directly.',
                'Do not add facts, promises, policies, or actions that are not included in the response meaning.',
                'Keep the response concise and natural.',
            ].join('\n'),
            messages: [
                {
                    role: 'developer',
                    content: `response_meaning: ${responseMeaning}`,
                },
                {
                    role: 'user',
                    content: `latest_customer_message: ${userMessage.trim()}`,
                },
            ],
            options: {
                maxOutputTokens: 120,
            },
        });

        return result.text;
    } catch {
        return fallbackText;
    }
};

const LOOP_ASSISTANCE_MESSAGES = [
    'I may be repeating myself. Could you clarify what exactly you want to know, or do you want admin support?',
    'I want to avoid giving you the same answer again. Please rephrase the question, or tell me if you want admin support.',
    'It looks like we may be stuck on the same topic. I can try again with more details, or you can ask for admin support.',
] as const;

const PRODUCT_CONTEXT_LIMIT = 6;
const HISTORY_LIMIT = 12;

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
    'товар',
    'товари',
    'покажи',
    'знайди',
    'потрібно',
    'потрібен',
    'хочу',
    'можеш',
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
            senderType: message.senderType as ChatBotHistoryMessageDto['senderType'],
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

// builds product search conditions from extracted terms
const buildProductSearchWhere = (
    terms: string[],
): Prisma.ProductWhereInput => {
    if (terms.length === 0) {
        return {
            deletedAt: null,
            stock: {
                gt: 0,
            },
        };
    }

    return {
        deletedAt: null,
        stock: {
            gt: 0,
        },
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

// converts product rows into compact prompt context items
const mapProductContext = (
    products: Awaited<ReturnType<typeof findProductsForBotContext>>,
): ChatBotProductContextItemDto[] => {
    return products.map((product) => ({
        id: product.id,
        name: product.name,
        price: Number(product.price),
        categoryName: product.category.name,
        description: product.description,
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
            deletedAt: null,
            stock: {
                gt: 0,
            },
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

        // returns prompt-ready context in chronological order
        return {
            thread,
            history: mapHistoryMessages(historyMessages.reverse()),
            productContext: mapProductContext(productRows),
        };
    });
};

// generates fallback text in the customer's latest language when AI answer fails
const generateFallbackBotText = async (
    userMessage: string,
): Promise<string> => {
    return generateLanguageMatchedBotText({
        userMessage,
        fallbackText: BOT_FALLBACK_MESSAGE,
        responseMeaning:
            'Tell the customer that the assistant cannot answer reliably right now. Ask them to try again later or ask for admin support.',
    });
};

// calls AI client and protects chat flow from provider failures
const generateAiBotText = async (
    context: LoadedChatBotContextDto,
    actorRole: ChatBotActorRole,
    userMessage: string,
): Promise<string> => {
    try {
        // builds Cartlify-specific prompt outside the low-level OpenAI wrapper
        const prompt = buildChatBotPrompt({
            actorRole,
            userMessage,
            history: context.history,
            productContext: context.productContext,
        });

        // sends normalized request to the AI client
        const result = await aiClientService.generateText({
            instructions: prompt.instructions,
            messages: prompt.messages,
        });

        return result.text;
    } catch (error) {
        // keeps customer chat working even when AI provider fails
        console.error('AI_BOT_ERROR');
        console.dir(error, { depth: 10 });

        return generateFallbackBotText(userMessage);
    }
};

// generates admin-related response in the customer's latest language
const generateEscalationBotText = async (
    actorRole: ChatBotActorRole,
    userMessage: string,
): Promise<string> => {
    if (actorRole === 'GUEST') {
        return generateLanguageMatchedBotText({
            userMessage,
            fallbackText: GUEST_ADMIN_REQUIRED_MESSAGE,
            responseMeaning:
                'Tell the customer that to contact an admin, they need to log in or create an account first. After that, the chat can be transferred to an admin.',
        });
    }

    return generateLanguageMatchedBotText({
        userMessage,
        fallbackText: USER_ADMIN_TRANSFER_MESSAGE,
        responseMeaning:
            'Tell the customer that this chat will be transferred to an admin and the bot will stop replying in this thread.',
    });
};

// generates loop-assistance response in the customer's latest language
const generateLoopAssistanceBotText = async (
    userMessage: string,
): Promise<string> => {
    return generateLanguageMatchedBotText({
        userMessage,
        fallbackText: LOOP_ASSISTANCE_MESSAGES[0],
        responseMeaning:
            'Tell the customer that the conversation may be repeating. Ask them to clarify what exactly they want to know, or ask whether they want admin support. Do not say that admin support is required.',
    });
};

// evaluates direct escalation before spending an AI request
const evaluatePreAiEscalation = (
    userMessage: string,
    history: ChatBotHistoryMessageDto[],
): ChatBotEscalationResultDto => {
    return evaluateChatBotEscalation({
        userMessage,
        botMessage: '',
        history,
    });
};

// evaluates escalation again after AI response
const evaluatePostAiEscalation = (
    userMessage: string,
    botMessage: string,
    history: ChatBotHistoryMessageDto[],
): ChatBotEscalationResultDto => {
    return evaluateChatBotEscalation({
        userMessage,
        botMessage,
        history,
    });
};

// creates bot message and updates thread last-message metadata
const createBotMessage = async ({
    actorId,
    actorRole,
    threadId,
    content,
}: {
    actorId: UserId;
    actorRole: ChatBotActorRole;
    threadId: string;
    content: string;
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

            // updates thread preview and last-message timestamp
            const thread = await db.chatThread.update({
                where: {
                    id: threadId,
                },
                data: {
                    lastMessageAt: botMessage.createdAt,
                    lastMessagePreview: content.slice(0, 120),
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

// switches logged-in user thread to admin mode after bot message is saved
const requestAdminIfNeeded = async ({
    actorId,
    actorRole,
    threadId,
    shouldEscalate,
}: {
    actorId: UserId;
    actorRole: ChatBotActorRole;
    threadId: string;
    shouldEscalate: boolean;
}): Promise<ChatThreadItemDto | null> => {
    if (!shouldEscalate || actorRole !== 'USER') {
        return null;
    }

    const result = await requestAdminService({
        actorId,
        actorRole,
        threadId,
    });

    return result.thread;
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

        // checks direct admin/human request and loop signals before AI call
        const preAiEscalation = evaluatePreAiEscalation(
            dto.userMessage,
            context.history,
        );

        // skips AI only for deterministic admin or loop responses
        const aiText =
            preAiEscalation.reason === 'LOOP_DETECTED'
                ? await generateLoopAssistanceBotText(dto.userMessage)
                : preAiEscalation.shouldEscalate
                    ? await generateEscalationBotText(actorRole, dto.userMessage)
                    : await generateAiBotText(context, actorRole, dto.userMessage);

        // checks whether AI answer itself says that human/admin help is needed
        const finalEscalation = preAiEscalation.shouldEscalate
            ? preAiEscalation
            : evaluatePostAiEscalation(dto.userMessage, aiText, context.history);

        // keeps loop assistance text instead of forcing admin escalation text
        const finalBotText =
            finalEscalation.reason === 'LOOP_DETECTED'
                ? aiText
                : finalEscalation.shouldEscalate
                    ? await generateEscalationBotText(actorRole, dto.userMessage)
                    : aiText;

        // saves final bot message and updates thread metadata
        const writeResult = await createBotMessage({
            actorId: dto.actorId,
            actorRole,
            threadId: dto.threadId,
            content: finalBotText,
        });

        // returns no bot output if another process already closed/escalated the thread
        if (!writeResult) {
            return {
                thread: null,
                botMessage: null,
                adminPending: false,
            };
        }

        // requests admin only for real escalation reasons, not for loop assistance
        const shouldRequestAdmin =
            finalEscalation.shouldEscalate &&
            finalEscalation.reason !== 'LOOP_DETECTED';

        const adminThread = await requestAdminIfNeeded({
            actorId: dto.actorId,
            actorRole,
            threadId: dto.threadId,
            shouldEscalate: shouldRequestAdmin,
        });

        // returns final thread state and created bot message
        return {
            thread: adminThread ?? writeResult.thread,
            botMessage: writeResult.botMessage,
            adminPending: Boolean(adminThread),
        };
    } catch (err) {

        console.error('CHAT_MESSAGE_SEND_ERROR');
        console.dir(
            {
                isAppError: isAppError(err),
                isRetryableTxError: isRetryableTxError(err),
                name: err instanceof Error ? err.name : typeof err,
                message: err instanceof Error ? err.message : String(err),
                error: err,
            },
            { depth: 10 },
        );

        // preserves known application errors
        if (isAppError(err)) {
            throw err;
        }

        // maps retryable transaction errors to stable resource-busy error
        if (isRetryableTxError(err)) {
            throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');
        }

        // wraps unexpected bot failures into internal app error
        throw new InternalError({ reason: 'CHAT_BOT_TURN_UNEXPECTED' }, err);
    }
};

export const chatBotService = {
    handleChatBotTurn,
};