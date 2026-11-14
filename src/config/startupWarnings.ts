// settings that let the server start but switch a feature off; a setting the shop cannot work
// without stops the start in env.ts instead (the secrets of the webhook and of the codes of
// withdrawal). "reviewCheckEnabled" is not env any more (root sets it, shopSettings.ts): this
// still names it at the moment the server reads it, the most a one-time startup warning can say,
// called after loadShopSettings (src/index.ts). Never quotes a value
type StartupSettings = {
  // the provider of the models: its name, and whether it has what it needs to be asked (its key)
  ai: { label: string; configured: boolean };
  reviewCheckEnabled: boolean;
};

export function startupWarnings(settings: StartupSettings): string[] {
  const warnings: string[] = [];

  // the shop works without the models, production too: nobody would see it otherwise
  if (!settings.ai.configured) {
    const missing = `${settings.ai.label}, the provider of the models, has no key`;
    warnings.push(
      settings.reviewCheckEnabled
        ? `${missing}: the chat bot answers with a fixed text and the comments of reviews are ` +
            'published unchecked'
        : `${missing}: the chat bot answers with a fixed text`,
    );
  }

  if (!settings.reviewCheckEnabled) {
    warnings.push(
      'reviewCheckEnabled is false (root set it, PUT /api/root/shop-settings): the comments of ' +
        'reviews are published unchecked',
    );
  }

  return warnings;
}
