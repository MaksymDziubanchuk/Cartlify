// the providers of the models this server can ask (the chat bot, the check of the reviews, the
// translations of the newsletters); AI_PROVIDER names the one it works with. No client here
export const AI_PROVIDER_NAMES = ['openai'] as const;

export type AiProviderName = (typeof AI_PROVIDER_NAMES)[number];
