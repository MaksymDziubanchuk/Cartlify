import env from '@config/env.js';

import {
    AiGenerateTextRequestDto,
    AiGenerateTextResultDto,
    OpenAiErrorBodyDto,
    OpenAiResponseDto,
} from './ai.types.js';

import {
    createAiApiUnavailableError,
    createAiEmptyResponseError,
    createAiInvalidResponseFormatError,
    createAiTimeoutError,
    createAiUnknownError,
    createOpenAiHttpError,
    isAiServiceError,
} from './ai.errors.js';

// base url for OpenAI Responses API
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

// fallback settings used when config values are missing or invalid
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 450;

// message format accepted by OpenAI input
type OpenAiInputMessageDto = {
    role: 'developer' | 'user' | 'assistant';
    content: string;
};

// payload format sent to OpenAI Responses API
type OpenAiResponsesPayloadDto = {
    model: string;
    instructions: string;
    input: OpenAiInputMessageDto[];
    max_output_tokens: number;
};

// shared guard for object-like values
const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

// validates numeric config and request override values
const normalizePositiveInteger = (
    value: number | undefined,
    fallback: number,
): number => {
    if (value === undefined || !Number.isInteger(value) || value <= 0) {
        return fallback;
    }

    return value;
};

// resolves model from request options, config, or fallback value
const getOpenAiModel = (requestModel: string | undefined): string => {
    return requestModel?.trim() || env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
};

// resolves timeout from request options, config, or fallback value
const getOpenAiTimeoutMs = (requestTimeoutMs: number | undefined): number => {
    return normalizePositiveInteger(
        requestTimeoutMs,
        normalizePositiveInteger(env.OPENAI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    );
};

// resolves max output tokens from request options, config, or fallback value
const getOpenAiMaxOutputTokens = (
    requestMaxOutputTokens: number | undefined,
): number => {
    return normalizePositiveInteger(
        requestMaxOutputTokens,
        normalizePositiveInteger(
            env.OPENAI_MAX_OUTPUT_TOKENS,
            DEFAULT_MAX_OUTPUT_TOKENS,
        ),
    );
};

// detects request cancellation caused by AbortController timeout
const isAbortError = (error: unknown): boolean => {
    return error instanceof Error && error.name === 'AbortError';
};

// checks minimal expected shape of OpenAI error body
const isOpenAiErrorBody = (value: unknown): value is OpenAiErrorBodyDto => {
    if (!isRecord(value)) {
        return false;
    }

    const error = value.error;

    if (error === undefined) {
        return true;
    }

    if (!isRecord(error)) {
        return false;
    }

    return (
        (error.message === undefined || typeof error.message === 'string') &&
        (error.type === undefined || typeof error.type === 'string') &&
        (error.code === undefined || typeof error.code === 'string')
    );
};

// checks minimal expected shape of OpenAI success body
const isOpenAiResponse = (value: unknown): value is OpenAiResponseDto => {
    if (!isRecord(value)) {
        return false;
    }

    return (
        (value.id === undefined || typeof value.id === 'string') &&
        (value.model === undefined || typeof value.model === 'string') &&
        (value.output_text === undefined ||
            typeof value.output_text === 'string') &&
        (value.output === undefined || Array.isArray(value.output))
    );
};

// reads OpenAI error response body and keeps it nullable if invalid
const readOpenAiErrorBody = async (
    response: Response,
): Promise<OpenAiErrorBodyDto | null> => {
    try {
        const body = (await response.json()) as unknown;

        if (!isOpenAiErrorBody(body)) {
            return null;
        }

        return body;
    } catch {
        return null;
    }
};

// reads OpenAI success response body and validates its shape
const readOpenAiSuccessBody = async (
    response: Response,
): Promise<OpenAiResponseDto> => {
    let body: unknown;

    try {
        body = (await response.json()) as unknown;
    } catch (error) {
        throw createAiInvalidResponseFormatError('openai', error);
    }

    if (!isOpenAiResponse(body)) {
        throw createAiInvalidResponseFormatError('openai', body);
    }

    return body;
};

// extracts text from output_text first, then falls back to nested output content
const extractOpenAiText = (body: OpenAiResponseDto): string => {
    const directText = body.output_text?.trim();

    if (directText) {
        return directText;
    }

    const textParts: string[] = [];

    for (const outputItem of body.output ?? []) {
        for (const contentItem of outputItem.content ?? []) {
            const text = contentItem.text?.trim();

            if (text) {
                textParts.push(text);
            }
        }
    }

    return textParts.join('\n').trim();
};

// converts internal request dto into OpenAI Responses API payload
const buildOpenAiPayload = (
    request: AiGenerateTextRequestDto,
): OpenAiResponsesPayloadDto => {
    return {
        model: getOpenAiModel(request.options?.model),
        instructions: request.instructions,
        input: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
        })),
        max_output_tokens: getOpenAiMaxOutputTokens(
            request.options?.maxOutputTokens,
        ),
    };
};

// sends request to OpenAI and returns normalized text result
export const generateText = async (
    request: AiGenerateTextRequestDto,
): Promise<AiGenerateTextResultDto> => {
    // reads api key from app config
    const apiKey = env.OPENAI_API_KEY.trim();

    // fails before request if OpenAI key is not configured
    if (!apiKey) {
        throw createAiApiUnavailableError(
            'openai',
            'OPENAI_API_KEY is not configured.',
            null,
        );
    }

    // prepares payload and timeout before starting the request
    const payload = buildOpenAiPayload(request);
    const timeoutMs = getOpenAiTimeoutMs(request.options?.timeoutMs);

    // creates abort controller for manual request timeout
    const controller = new AbortController();

    // schedules request cancellation after configured timeout
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        // sends http request to OpenAI
        const response = await fetch(OPENAI_RESPONSES_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        // maps non-success OpenAI responses into normalized AI errors
        if (!response.ok) {
            const errorBody = await readOpenAiErrorBody(response);

            throw createOpenAiHttpError(response.status, errorBody);
        }

        // reads and validates successful OpenAI response
        const body = await readOpenAiSuccessBody(response);

        // extracts final assistant text
        const text = extractOpenAiText(body);

        // treats empty text as a separate normalized AI error
        if (!text) {
            throw createAiEmptyResponseError('openai', body);
        }

        // returns normalized result without leaking raw OpenAI body
        return {
            provider: 'openai',
            model: body.model ?? payload.model,
            text,
            responseId: body.id ?? null,
        };
    } catch (error) {
        // keeps already normalized AI errors unchanged
        if (isAiServiceError(error)) {
            throw error;
        }

        // maps AbortController cancellation to AI_TIMEOUT
        if (isAbortError(error)) {
            throw createAiTimeoutError('openai', timeoutMs, error);
        }

        // maps network-level fetch failure to AI_API_UNAVAILABLE
        if (error instanceof TypeError) {
            throw createAiApiUnavailableError(
                'openai',
                'OpenAI API request failed before receiving a response.',
                null,
                error,
            );
        }

        // maps unexpected failures to AI_UNKNOWN_ERROR
        throw createAiUnknownError('openai', error);
    } finally {
        // clears timeout timer after request finishes or fails
        clearTimeout(timeoutId);
    }
};

// public service object for consistent imports
export const aiClientService = {
    generateText,
};