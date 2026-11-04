// settings that let the server start but switch a feature off, the same in every mode; a setting
// the shop cannot work without stops the start in env.ts instead (the secrets of the webhook and
// of the codes of withdrawal). Never quotes a value
type StartupSettings = {
  OPENAI_API_KEY: string;
  REVIEW_CHECK_ENABLED: boolean;
};

export function startupWarnings(settings: StartupSettings): string[] {
  const warnings: string[] = [];

  // the shop works without openai, production too: nobody would see it otherwise
  if (!settings.OPENAI_API_KEY.trim()) {
    warnings.push(
      settings.REVIEW_CHECK_ENABLED
        ? 'OPENAI_API_KEY is not set: the chat bot answers with a fixed text and the comments of ' +
            'reviews are published unchecked'
        : 'OPENAI_API_KEY is not set: the chat bot answers with a fixed text',
    );
  }

  if (!settings.REVIEW_CHECK_ENABLED) {
    warnings.push('REVIEW_CHECK_ENABLED is false: the comments of reviews are published unchecked');
  }

  return warnings;
}
