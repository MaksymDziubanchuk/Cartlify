import {
    createAiApiUnavailableError,
    createAiError,
    createAiRateLimitError,
    type AiServiceError,
} from '../errors.js';

import type { OpenAiErrorBodyDto } from './openai.types.js';

// extracts readable message from OpenAI error body
export const getOpenAiErrorMessage = (body: OpenAiErrorBodyDto | null): string => {
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

    // openai itself timed out: keep its status and its own words,
    // createAiTimeoutError is for our own timeout, where the waited time is known
    if (statusCode === 408 || statusCode === 504) {
        const timeoutMessage =
            body?.error?.message?.trim() || `OpenAI API request timed out (HTTP ${statusCode}).`;

        return createAiError('openai', 'AI_TIMEOUT', timeoutMessage, statusCode, true, body);
    }

    if (statusCode >= 500) {
        return createAiApiUnavailableError('openai', message, statusCode, body);
    }

    return createAiError('openai', 'AI_API_UNAVAILABLE', message, statusCode, false, body);
};
