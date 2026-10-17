import type { FastifyBaseLogger } from 'fastify';

import { isAiServiceError } from '@services/ai/ai.errors.js';
import { aiClientService } from '@services/ai/aiClient.service.js';

import type {
    AiErrorCode,
    AiGenerateTextRequestDto,
    AiJsonSchemaDto,
} from '@services/ai/ai.types.js';
import type { ChatBotEscalationReason } from './chatBotEscalation.service.js';

export type ChatBotLogger = Pick<FastifyBaseLogger, 'warn' | 'error'>;

// what the bot asked the model for, so a log line tells the bot answer from a fixed text
export type ChatBotAiPurpose = 'answer' | 'fixed_text';

// the reasons the model may give; a loop is found by the code, not by the model
export type ChatBotModelReason = Exclude<ChatBotEscalationReason, 'LOOP_DETECTED'>;

// the bot answer with the decision of the model whether a human admin is needed
export interface ChatBotReplyDto {
    reply: string;
    escalate: boolean;
    reason: ChatBotModelReason;
}

const MODEL_REASONS: ChatBotModelReason[] = [
    'DIRECT_ADMIN_REQUEST',
    'HUMAN_REQUIRED',
    'BOT_CANNOT_HELP',
    'NONE',
];

// structured output of the bot answer: the model decides by meaning, in any language
export const CHAT_BOT_REPLY_SCHEMA: AiJsonSchemaDto = {
    name: 'chat_bot_reply',
    schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
            reply: { type: 'string' },
            escalate: { type: 'boolean' },
            reason: { type: 'string', enum: MODEL_REASONS },
        },
        required: ['reply', 'escalate', 'reason'],
    },
};

// the model sent an answer, but a broken one: asking the same again usually gets a good one
const BROKEN_ANSWER_CODES = new Set<AiErrorCode>([
    'AI_INVALID_RESPONSE_FORMAT',
    'AI_EMPTY_RESPONSE',
]);

// code for a reply whose json does not match the schema
const BOT_REPLY_INVALID = 'BOT_REPLY_INVALID';

const MAX_ATTEMPTS = 2;

// writes one failed ai request to the log: code and status only, neither the customer
// text nor the provider message, which for a wrong key quotes a part of it
const logAiFailure = (
    log: ChatBotLogger,
    error: unknown,
    meta: { purpose: ChatBotAiPurpose; attempt: number; willRetry: boolean },
): void => {
    if (isAiServiceError(error)) {
        log.warn(
            {
                ...meta,
                provider: error.provider,
                code: error.code,
                statusCode: error.statusCode,
            },
            'chat bot ai request failed',
        );
        return;
    }

    log.error({ ...meta, err: error }, 'chat bot ai request failed unexpectedly');
};

// asks the model and reads the answer with parse. A broken answer (bad format, no text,
// or text parse rejects) is asked once more with the same request; any other failure
// (timeout, rate limit, network) is not. Every failure goes to the log.
// Returns null when there is no usable answer, the caller then sends its fallback text
const askAi = async <T>(
    request: AiGenerateTextRequestDto,
    log: ChatBotLogger,
    purpose: ChatBotAiPurpose,
    parse: (text: string) => T | null,
): Promise<T | null> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const willRetry = attempt < MAX_ATTEMPTS;

        try {
            const result = await aiClientService.generateText(request);
            const parsed = parse(result.text);

            if (parsed !== null) return parsed;

            log.warn(
                { purpose, attempt, willRetry, code: BOT_REPLY_INVALID },
                'chat bot ai answer does not match its schema',
            );
        } catch (error) {
            const broken = isAiServiceError(error) && BROKEN_ANSWER_CODES.has(error.code);

            logAiFailure(log, error, { purpose, attempt, willRetry: broken && willRetry });

            if (!broken) return null;
        }
    }

    return null;
};

// reads the json of a bot answer; null when it does not match the schema or contradicts
// itself (an escalation without a reason, or a reason without an escalation)
export const parseBotReply = (text: string): ChatBotReplyDto | null => {
    let value: unknown;

    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

    const { reply, escalate, reason } = value as Record<string, unknown>;

    if (typeof reply !== 'string' || !reply.trim()) return null;
    if (typeof escalate !== 'boolean') return null;
    if (!MODEL_REASONS.includes(reason as ChatBotModelReason)) return null;
    if (escalate !== (reason !== 'NONE')) return null;

    return { reply: reply.trim(), escalate, reason: reason as ChatBotModelReason };
};

// asks the model for a plain bot text, like a fixed message in the customer language
export const askAiForBotText = (
    request: AiGenerateTextRequestDto,
    log: ChatBotLogger,
    purpose: ChatBotAiPurpose,
): Promise<string | null> => {
    return askAi(request, log, purpose, (text) => text);
};

// asks the model for the bot answer together with its decision about a human admin
export const askAiForBotReply = (
    request: AiGenerateTextRequestDto,
    log: ChatBotLogger,
): Promise<ChatBotReplyDto | null> => {
    return askAi(
        { ...request, options: { ...request.options, jsonSchema: CHAT_BOT_REPLY_SCHEMA } },
        log,
        'answer',
        parseBotReply,
    );
};
