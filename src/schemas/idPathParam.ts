// ids are int columns in postgres, the largest one is 2^31 - 1; a bigger number is no id of any row
export const MAX_ID = 2_147_483_647;

// a numeric id in the url path, taken as a digit string (a number type would let ajv turn '1e3'
// into 1000). The pattern only checks the digits; validateId checks the range and the controller
// turns the string into a number
export const idPathParam = (what: string) =>
  ({
    type: 'string',
    pattern: '^[1-9][0-9]*$',
    description: `Id of ${what}: a whole number from 1 to ${MAX_ID}.`,
  }) as const;
