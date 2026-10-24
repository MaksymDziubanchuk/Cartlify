// the years a date of a request may have: postgres has no year 0 (an iso year 0000 is 1 BC to it,
// and its input refuses it with a server error), and a year past 9999 is no date a page means
export const isDbYear = (date: Date): boolean => {
  const year = date.getUTCFullYear();
  return year >= 1 && year <= 9999;
};
