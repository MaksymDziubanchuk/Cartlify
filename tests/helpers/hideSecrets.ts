import { CLOUDINARY_PLACEHOLDERS } from '../setup/isolateEnv.js';

// the real keys some integration tests hold (cloudinary, from the local .env or a ci secret)
// must never reach the output, and github hides only a whole secret, not its parts: every text
// a test prints goes through hideSecrets. The cloud name is in every image url the app gives

const HIDDEN = '[hidden]';

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

  // the longest first, so a part inside a longer one does not break it before it is replaced
  return [...new Set(parts)].filter((part) => part.length >= 3).sort((a, b) => b.length - a.length);
}

export function hideSecrets(text: string): string {
  secrets ??= cloudinarySecrets();

  return secrets.reduce((out, secret) => out.replaceAll(secret, HIDDEN), text);
}
