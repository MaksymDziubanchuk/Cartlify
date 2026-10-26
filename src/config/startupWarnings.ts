// settings that let the server start but switch a feature off; production stops on some of them in
// env.ts instead (the webhook secret), elsewhere the start logs a warning. Never quotes a value
type StartupSettings = {
  NODE_ENV: string;
  STRIPE_WEBHOOK_SECRET: string;
  OPENAI_API_KEY: string;
  REVIEW_CHECK_ENABLED: boolean;
};

export function startupWarnings(settings: StartupSettings): string[] {
  const warnings: string[] = [];

  if (!settings.STRIPE_WEBHOOK_SECRET) {
    warnings.push(
      'STRIPE_WEBHOOK_SECRET is not set: every stripe event is refused, no order becomes paid',
    );
  }

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
