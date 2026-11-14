import env from '@config/env.js';

import { pickProvider } from '../provider.js';

import { AI_PROVIDER_NAMES } from './names.js';
import { openAiProvider } from './openai/openai.provider.js';

import type { AiProvider } from './types.js';

export * from './errors.js';
export * from './names.js';
export type * from './types.js';

// every provider of the models this server has; AI_PROVIDER names the one it asks
const providers: readonly AiProvider[] = [openAiProvider];

// the list the settings take the names from is the list of the providers themselves
if (
    providers.length !== AI_PROVIDER_NAMES.length ||
    providers.some((provider, i) => provider.name !== AI_PROVIDER_NAMES[i])
) {
    throw new Error('AI_PROVIDER_NAMES must name the providers of the models in the same order');
}

export const aiProvider: AiProvider = pickProvider('AI_PROVIDER', env.AI_PROVIDER, providers);
