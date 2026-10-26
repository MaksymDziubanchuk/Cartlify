import env from '@config/env.js';

import {
    AiGenerateTextRequestDto,
    AiGenerateTextResultDto,
    AiModerateTextRequestDto,
    AiModerationResultDto,
    OpenAiErrorBodyDto,
    OpenAiModerationResponseDto,
    OpenAiResponseDto,
} from './ai.types.js';

import {
    createAiApiUnavailableError,
    createAiEmptyResponseError,
    createAiIncompleteResponseError,
    createAiInvalidResponseFormatError,
    createAiTimeoutError,
    createAiUnknownError,
    createOpenAiHttpError,
    isAiServiceError,
} from './ai.errors.js';

// base url for OpenAI Responses API
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

// the moderation of openai: free of charge, many languages, scores a text in its categories
const OPENAI_MODERATIONS_URL = 'https://api.openai.com/v1/moderations';
const OPENAI_MODERATION_MODEL = 'omni-moderation-latest';

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
    store: false;
    temperature?: number;
    text?: {
        format: {
            type: 'json_schema';
            name: string;
            schema: Record<string, unknown>;
            strict: true;
        };
    };
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

// checks one content part of an output item: an object whose text, if any, is a string
const isOpenAiTextContent = (value: unknown): boolean => {
    return (
        isRecord(value) &&
        !Array.isArray(value) &&
        (value.text === undefined || typeof value.text === 'string')
    );
};

// checks one output item: an object whose content, if any, is a list of content parts
const isOpenAiOutputItem = (value: unknown): boolean => {
    return (
        isRecord(value) &&
        !Array.isArray(value) &&
        (value.content === undefined ||
            (Array.isArray(value.content) && value.content.every(isOpenAiTextContent)))
    );
};

// checks expected shape of OpenAI success body, down to the parts text is read from,
// so reading the text never fails on a broken body
const isOpenAiResponse = (value: unknown): value is OpenAiResponseDto => {
    if (!isRecord(value) || Array.isArray(value)) {
        return false;
    }

    return (
        (value.id === undefined || typeof value.id === 'string') &&
        (value.model === undefined || typeof value.model === 'string') &&
        (value.status === undefined || typeof value.status === 'string') &&
        (value.output_text === undefined ||
            typeof value.output_text === 'string') &&
        (value.output === undefined ||
            (Array.isArray(value.output) && value.output.every(isOpenAiOutputItem)))
    );
};

// checks the shape of a moderation answer: its first result, a flag and a number for each score
const isOpenAiModerationResponse = (
    value: unknown,
): value is OpenAiModerationResponseDto => {
    if (!isRecord(value) || Array.isArray(value) || !Array.isArray(value.results)) {
        return false;
    }

    const [result] = value.results as unknown[];

    if (!isRecord(result) || typeof result.flagged !== 'boolean') {
        return false;
    }

    const scores = result.category_scores;

    return (
        (value.model === undefined || typeof value.model === 'string') &&
        isRecord(scores) &&
        !Array.isArray(scores) &&
        Object.values(scores).every((score) => typeof score === 'number')
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
const readOpenAiSuccessBody = async <T>(
    response: Response,
    isValid: (value: unknown) => value is T,
): Promise<T> => {
    let body: unknown;

    try {
        body = (await response.json()) as unknown;
    } catch (error) {
        // the time ran out while the body came: a timeout, not a broken answer to ask again
        if (isAbortError(error)) throw error;

        throw createAiInvalidResponseFormatError('openai', error);
    }

    if (!isValid(body)) {
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
    const jsonSchema = request.options?.jsonSchema;
    const temperature = request.options?.temperature;

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
        // openai keeps every request and answer in the account unless told not to; the chat
        // carries names, addresses and phones, and each turn sends the whole history anyway
        store: false,
        ...(temperature !== undefined ? { temperature } : {}),
        // structured output: the model answers with json that matches the schema
        ...(jsonSchema
            ? {
                  text: {
                      format: {
                          type: 'json_schema' as const,
                          name: jsonSchema.name,
                          schema: jsonSchema.schema,
                          strict: true as const,
                      },
                  },
              }
            : {}),
    };
};

// posts one request to OpenAI with our key and gives what read makes of the successful answer;
// no key, the network, an error status, the timeout (also while the body comes) and anything
// unexpected end as normalized ai errors
const postToOpenAi = async <T>(
    url: string,
    payload: unknown,
    timeoutMs: number,
    read: (response: Response) => Promise<T>,
): Promise<T> => {
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

    // creates abort controller for manual request timeout
    const controller = new AbortController();

    // schedules request cancellation after configured timeout
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        // sends http request to OpenAI; a TypeError means a network failure only when fetch
        // itself throws it, one from reading the answer is not about the network
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        }).catch((error: unknown) => {
            if (error instanceof TypeError) {
                throw createAiApiUnavailableError(
                    'openai',
                    'OpenAI API request failed before receiving a response.',
                    null,
                    error,
                );
            }

            throw error;
        });

        // maps non-success OpenAI responses into normalized AI errors
        if (!response.ok) {
            const errorBody = await readOpenAiErrorBody(response);

            throw createOpenAiHttpError(response.status, errorBody);
        }

        return await read(response);
    } catch (error) {
        // keeps already normalized AI errors unchanged
        if (isAiServiceError(error)) {
            throw error;
        }

        // maps AbortController cancellation to AI_TIMEOUT, while waiting or while reading the answer
        if (isAbortError(error)) {
            throw createAiTimeoutError('openai', timeoutMs, error);
        }

        // maps unexpected failures to AI_UNKNOWN_ERROR
        throw createAiUnknownError('openai', error);
    } finally {
        // clears timeout timer after request finishes or fails
        clearTimeout(timeoutId);
    }
};

// sends request to OpenAI and returns normalized text result
export const generateText = async (
    request: AiGenerateTextRequestDto,
): Promise<AiGenerateTextResultDto> => {
    // prepares payload and timeout before starting the request
    const payload = buildOpenAiPayload(request);
    const timeoutMs = getOpenAiTimeoutMs(request.options?.timeoutMs);

    return postToOpenAi(OPENAI_RESPONSES_URL, payload, timeoutMs, async (response) => {
        // reads and validates successful OpenAI response
        const body = await readOpenAiSuccessBody(response, isOpenAiResponse);

        // an answer cut short is never a text: the json of a structured answer breaks off
        if (body.status === 'incomplete') {
            const reason = isRecord(body.incomplete_details)
                ? String(body.incomplete_details.reason ?? 'unknown')
                : 'unknown';

            throw createAiIncompleteResponseError('openai', reason, { id: body.id, reason });
        }

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
    });
};

// asks the moderation of OpenAI to score a text and returns the scores of its categories
export const moderateText = async (
    request: AiModerateTextRequestDto,
): Promise<AiModerationResultDto> => {
    const payload = { model: OPENAI_MODERATION_MODEL, input: request.text };
    const timeoutMs = getOpenAiTimeoutMs(request.options?.timeoutMs);

    return postToOpenAi(OPENAI_MODERATIONS_URL, payload, timeoutMs, async (response) => {
        const body = await readOpenAiSuccessBody(response, isOpenAiModerationResponse);
        const [result] = body.results;

        return {
            provider: 'openai',
            model: body.model ?? OPENAI_MODERATION_MODEL,
            flagged: result!.flagged,
            scores: result!.category_scores,
        };
    });
};

// public service object for consistent imports
export const aiClientService = {
    generateText,
    moderateText,
};