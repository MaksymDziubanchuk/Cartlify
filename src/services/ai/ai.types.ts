// provider name is separated from implementation so another ai provider can be added later
export type AiProviderName = 'openai';

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

// normalized result returned by aiClient.service.ts
export interface AiGenerateTextResultDto {
    provider: AiProviderName;
    model: string;
    text: string;
    responseId: string | null;
}

// supported normalized ai error codes
export type AiErrorCode =
    | 'AI_API_UNAVAILABLE'
    | 'AI_EMPTY_RESPONSE'
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

// minimal OpenAI Responses API text content shape
export interface OpenAiTextContentDto {
    type?: string;
    text?: string;
}

// minimal OpenAI Responses API output item shape
export interface OpenAiOutputItemDto {
    type?: string;
    content?: OpenAiTextContentDto[];
}

// minimal OpenAI Responses API response shape used by our wrapper
export interface OpenAiResponseDto {
    id?: string;
    model?: string;
    output_text?: string;
    output?: OpenAiOutputItemDto[];
}

// minimal OpenAI error body shape
export interface OpenAiErrorBodyDto {
    error?: {
        message?: string;
        type?: string;
        code?: string;
    };
}