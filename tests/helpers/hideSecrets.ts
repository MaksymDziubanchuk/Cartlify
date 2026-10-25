import { CLOUDINARY_PLACEHOLDERS } from '../setup/isolateEnv.js';

// the real keys some integration tests hold (cloudinary, stripe and openai, from the local .env or
// a ci secret) must never reach the output, and github hides only a whole secret, not its parts: every
// text a test prints goes through hideSecrets. The cloud name is in every image url the app gives

const HIDDEN = '[hidden]';

// a stripe key, whole or the way stripe quotes one in an error (sk_test_****abcd)
const STRIPE_KEY = /\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g;

// an openai key, whole or the way openai quotes one in an error (sk-proj-****abcd)
const OPENAI_KEY = /\bsk-[A-Za-z0-9_*-]{4,}/g;

let secrets: string[] | undefined;

function cloudinarySecrets(): string[] {
  const parts: string[] = [];

  const url = process.env.CLOUDINARY_URL?.trim();
  if (url) {
    parts.push(url);
    const match = /^cloudinary:\/\/([^:@/]+):([^@/]+)@([^/?#]+)/i.exec(url);
    if (match) {
      for (const part of match.slice(1)) {
        parts.push(part);
        try {
          parts.push(decodeURIComponent(part));
        } catch {
          // a broken escape stays as it is in the url
        }
      }
    }
  }

  for (const [key, placeholder] of Object.entries(CLOUDINARY_PLACEHOLDERS)) {
    const value = process.env[key]?.trim();
    if (value && value !== placeholder) parts.push(value);
  }

  const openAiKey = process.env.OPENAI_API_TEST_KEY?.trim();
  if (openAiKey) parts.push(openAiKey);

  // the longest first, so a part inside a longer one does not break it before it is replaced
  return [...new Set(parts)].filter((part) => part.length >= 3).sort((a, b) => b.length - a.length);
}

export function hideSecrets(text: string): string {
  secrets ??= cloudinarySecrets();

  return secrets
    .reduce((out, secret) => out.replaceAll(secret, HIDDEN), text)
    .replace(STRIPE_KEY, HIDDEN)
    .replace(OPENAI_KEY, HIDDEN);
}
