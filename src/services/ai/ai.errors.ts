import {
    AiErrorCode,
    AiErrorDetailsDto,
    AiProviderName,
    OpenAiErrorBodyDto
} from './ai.types.js'

// custom error for all ai-level failures
export class AiServiceError extends Error {
    public readonly details: AiErrorDetailsDto;

    public readonly cause?: unknown;

    constructor(details: AiErrorDetailsDto, cause?: unknown) {
        super(details.message);

        this.name = 'AiServiceError';
        this.details = details;
        this.cause = cause;

        Object.setPrototypeOf(this, new.target.prototype);
    }

    public get provider(): AiProviderName {
        return this.details.provider;
    }

    public get code(): AiErrorCode {
        return this.details.code;
    }

    public get statusCode(): number | null {
        return this.details.statusCode;
    }

    public get retryable(): boolean {
        return this.details.retryable;
    }
}

// creates a normalized ai error object
const createAiError = (
    provider: AiProviderName,
    code: AiErrorCode,
    message: string,
    statusCode: number | null,
    retryable: boolean,
    cause?: unknown,
): AiServiceError => {
    return new AiServiceError(
        {
            provider,
            code,
            message,
            statusCode,
            retryable,
        },
        cause,
    );
};

// api is not available or returned unexpected server/network failure
export const createAiApiUnavailableError = (
    provider: AiProviderName,
    message = 'AI provider is unavailable.',
    statusCode: number | null = null,
    cause?: unknown,
): AiServiceError => {
    return createAiError(
        provider,
        'AI_API_UNAVAILABLE',
        message,
        statusCode,
        true,
        cause,
    );
};

// provider returned successful response but without usable text
export const createAiEmptyResponseError = (
    provider: AiProviderName,
    cause?: unknown,
): AiServiceError => {
    return createAiError(
        provider,
        'AI_EMPTY_RESPONSE',
        'AI provider returned an empty text response.',
        null,
        true,
        cause,
    );
};

// provider response body does not match the format expected by our wrapper
export const createAiInvalidResponseFormatError = (
    provider: AiProviderName,
    cause?: unknown,
): AiServiceError => {
    return createAiError(
        provider,
        'AI_INVALID_RESPONSE_FORMAT',
        'AI provider returned an invalid response format.',
        null,
        false,
        cause,
    );
};

// request exceeded allowed timeout
export const createAiTimeoutError = (
    provider: AiProviderName,
    timeoutMs: number,
    cause?: unknown,
): AiServiceError => {
    return createAiError(
        provider,
        'AI_TIMEOUT',
        `AI provider request timed out after ${timeoutMs} ms.`,
        null,
        true,
        cause,
    );
};

// provider rate limit response
export const createAiRateLimitError = (
    provider: AiProviderName,
    statusCode: number | null = 429,
    cause?: unknown,
): AiServiceError => {
    return createAiError(
        provider,
        'AI_RATE_LIMIT',
        'AI provider rate limit exceeded.',
        statusCode,
        true,
        cause,
    );
};

// fallback for unknown ai-level errors
export const createAiUnknownError = (
    provider: AiProviderName,
    cause?: unknown,
): AiServiceError => {
    return createAiError(
        provider,
        'AI_UNKNOWN_ERROR',
        'Unknown AI provider error.',
        null,
        true,
        cause,
    );
};

// type guard for errors already normalized by this layer
export const isAiServiceError = (error: unknown): error is AiServiceError => {
    return error instanceof AiServiceError;
};

// extracts readable message from OpenAI error body
export const getOpenAiErrorMessage = (
    body: OpenAiErrorBodyDto | null,
): string => {
    return body?.error?.message?.trim() || 'OpenAI API request failed.';
};

// maps OpenAI http status code to our normalized ai error
export const createOpenAiHttpError = (
    statusCode: number,
    body: OpenAiErrorBodyDto | null,
): AiServiceError => {
    const message = getOpenAiErrorMessage(body);

    if (statusCode === 429) {
        return createAiRateLimitError('openai', statusCode, body);
    }

    if (statusCode === 408 || statusCode === 504) {
        return createAiTimeoutError('openai', 0, body);
    }

    if (statusCode >= 500) {
        return createAiApiUnavailableError('openai', message, statusCode, body);
    }

    return createAiError(
        'openai',
        'AI_API_UNAVAILABLE',
        message,
        statusCode,
        false,
        body,
    );
};