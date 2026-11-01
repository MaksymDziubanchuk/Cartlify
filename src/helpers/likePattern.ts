// the pattern of a LIKE or ILIKE that finds the text anywhere in a value, with the signs that
// mean something to LIKE (a percent sign, an underscore, a backslash) taken as themselves
export const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, '\\$&')}%`;
