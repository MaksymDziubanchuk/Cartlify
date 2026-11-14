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
    // "completed", or "incomplete" for an answer cut short, with the reason in incomplete_details
    status?: string;
    incomplete_details?: { reason?: string } | null;
    output_text?: string;
    output?: OpenAiOutputItemDto[];
}

// minimal OpenAI moderation response shape used by our wrapper
export interface OpenAiModerationResponseDto {
    id?: string;
    model?: string;
    results: Array<{
        flagged: boolean;
        category_scores: Record<string, number>;
    }>;
}

// minimal OpenAI error body shape
export interface OpenAiErrorBodyDto {
    error?: {
        message?: string;
        type?: string;
        code?: string;
    };
}
