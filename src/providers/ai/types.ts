import type { Provider } from '../provider.js';

import type { AiProviderName } from './names.js';

// message roles accepted by our ai client abstraction
export type AiMessageRole = 'developer' | 'user' | 'assistant';

// normalized message format for ai providers
export interface AiMessageDto {
    role: AiMessageRole;
    content: string;
}

// options that control one ai text generation request
export interface AiGenerateTextOptionsDto {
    model?: string;
    timeoutMs?: number;
    maxOutputTokens?: number;

    // how freely the model picks its words; 0 gives the same answer to the same request, as a
    // check needs; a provider takes its own default without it
    temperature?: number;

    // asks for json of this schema instead of plain text; the result text is then that json
    jsonSchema?: AiJsonSchemaDto;
}

// a strict json schema for structured output: every property required, no extra ones
export interface AiJsonSchemaDto {
    name: string;
    schema: Record<string, unknown>;
}

// normalized request for text generation
export interface AiGenerateTextRequestDto {
    // high-priority instruction text for the model
    instructions: string;

    // conversation messages passed to the model
    messages: AiMessageDto[];

    // optional per-request overrides
    options?: AiGenerateTextOptionsDto;
}

// normalized result of a text generation
export interface AiGenerateTextResultDto {
    provider: AiProviderName;
    model: string;
    text: string;
    responseId: string | null;
}

// a text for the moderation of the provider, the scores of its categories come back
export interface AiModerateTextRequestDto {
    text: string;

    options?: {
        timeoutMs?: number;
    };
}

// the scores of the text in each category of the moderation (0 to 1), and whether the provider
// itself flags it
export interface AiModerationResultDto {
    provider: AiProviderName;
    model: string;
    flagged: boolean;
    scores: Record<string, number>;
}

// supported normalized ai error codes
export type AiErrorCode =
    | 'AI_API_UNAVAILABLE'
    | 'AI_EMPTY_RESPONSE'
    | 'AI_INCOMPLETE_RESPONSE'
    | 'AI_INVALID_RESPONSE_FORMAT'
    | 'AI_TIMEOUT'
    | 'AI_RATE_LIMIT'
    | 'AI_UNKNOWN_ERROR';

// normalized ai error details used by ai.errors.ts
export interface AiErrorDetailsDto {
    provider: AiProviderName;
    code: AiErrorCode;
    message: string;
    statusCode: number | null;
    retryable: boolean;
}

// what the rest of the app asks of the provider of the models: a text to a request, the scores of
// a text in the categories of a moderation. How it does it (its addresses, its models, its answers)
// is its own; every failure is an AiServiceError (errors.ts)
export interface AiProvider extends Provider<AiProviderName> {
    // the provider has what it needs to be asked (its key); without it the bot answers with its
    // fixed texts and the reviews and the translations go without the model
    isConfigured(): boolean;
    generateText(request: AiGenerateTextRequestDto): Promise<AiGenerateTextResultDto>;
    moderateText(request: AiModerateTextRequestDto): Promise<AiModerationResultDto>;
}
