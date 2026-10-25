// settings that let the server start but switch a feature off; production stops on them in
// env.ts instead, elsewhere the start logs a warning. Never quotes a value
type StartupSettings = {
  NODE_ENV: string;
  STRIPE_WEBHOOK_SECRET: string;
};

export function startupWarnings(settings: StartupSettings): string[] {
  const warnings: string[] = [];

  if (!settings.STRIPE_WEBHOOK_SECRET) {
    warnings.push(
      'STRIPE_WEBHOOK_SECRET is not set: every stripe event is refused, no order becomes paid',
    );
  }

  return warnings;
}
