import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// what an admin sees of root in a journal, where root sees itself: the same lines with the same
// fields, and in place of a value that tells who root is, from where or with what, this word; a
// number that points to the account (its id) is 0. The role stays, so does the shape of the answer

export const HIDDEN_TEXT = 'hidden';
export const HIDDEN_ID = 0;

export const hiddenText = (value: string | null): string | null =>
  value === null ? null : HIDDEN_TEXT;

// a value of a change of the account of root: its texts are hidden, its numbers 0, the rest keeps
// its form
export function hiddenValue(value: unknown): unknown {
  if (typeof value === 'string') return HIDDEN_TEXT;
  if (typeof value === 'number') return HIDDEN_ID;
  if (Array.isArray(value)) return value.map(hiddenValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, hiddenValue(part)]));
  }
  return value;
}

// the changes of a line about the account of root: each field is named, its values are hidden
export const hiddenChanges = (changes: unknown[]): unknown[] =>
  changes.map((change) =>
    change !== null && typeof change === 'object' && 'field' in change
      ? {
          ...change,
          old: hiddenValue((change as { old?: unknown }).old),
          new: hiddenValue((change as { new?: unknown }).new),
        }
      : hiddenValue(change),
  );

// the account of root as an admin sees it
export const hiddenAccount = (name: string | null, email: string | null) => ({
  id: HIDDEN_ID as UserId,
  name: hiddenText(name),
  email: hiddenText(email),
  role: 'ROOT' as Role,
});
