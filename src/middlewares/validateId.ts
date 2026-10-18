import { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { BadRequestError } from '@utils/errors.js';
import { MAX_ID } from '@schemas/idPathParam.js';

// validate numeric id param
export default function validateId(paramName: string): preHandlerHookHandler {
  return async function (req: FastifyRequest): Promise<void> {
    const value = (req.params as Record<string, unknown>)[paramName];

    // a route with a params schema hands over a number already coerced by ajv;
    // a raw string must be plain digits, Number() alone also reads '1e3', '0x1A' and ' 7 '
    const isDigits = typeof value === 'string' && /^\d+$/.test(value);
    if (typeof value !== 'number' && !isDigits) {
      throw new BadRequestError('INVALID_ID_PARAM');
    }

    const num = Number(value);

    // an id above the int column of the database matches no row, and the database would
    // answer it with an error instead of a miss
    if (!Number.isSafeInteger(num) || num <= 0 || num > MAX_ID) {
      throw new BadRequestError('INVALID_ID_PARAM');
    }
  };
}
