import { randomInt } from 'node:crypto';

import { hashToken } from '@helpers/tokenHash.js';

// A set of recovery codes: ten codes of ten characters, XXXXX-XXXXX, of an alphabet without the
// letters and digits a person mixes up (0 and O, 1 and I and L). Each one lets a login through once
// in place of a code of the app. The database keeps only their sha256.
export const RECOVERY_CODES_IN_SET = 10;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const HALF = 5;

function newRecoveryCode(): string {
  let code = '';
  for (let i = 0; i < HALF * 2; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];

  return `${code.slice(0, HALF)}-${code.slice(HALF)}`;
}

export function newRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODES_IN_SET) codes.add(newRecoveryCode());

  return [...codes];
}

// the case, the spaces and the dash a person types do not matter
export function recoveryCodeHash(code: string): string {
  return hashToken(code.replace(/[\s-]/g, '').toUpperCase());
}
