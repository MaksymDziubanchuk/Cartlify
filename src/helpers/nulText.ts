// whether a value holds a NUL sign in a text, a key of an object included: postgres keeps no NUL
// in a text and fails the statement with a server error
export function holdsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(holdsNul);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, inner]) => key.includes('\u0000') || holdsNul(inner));
  }
  return false;
}
