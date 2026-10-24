import { BadRequestError } from '@utils/errors.js';
import { b64urlJson } from '@helpers/b64Payload.js';
import { MAX_ID } from '@schemas/idPathParam.js';

export type CursorPayload = { id: number; v: string | number | null };

export function encodeCursor(payload: CursorPayload): string {
  return b64urlJson(payload);
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    if (typeof cursor !== 'string' || !cursor.length || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new BadRequestError('CURSOR_INVALID');
    }

    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const obj = JSON.parse(raw) as CursorPayload;

    // an id past the int of postgres is no row: the database failed it with a server error
    if (!obj || !Number.isInteger(obj.id) || obj.id <= 0 || obj.id > MAX_ID)
      throw new BadRequestError('CURSOR_INVALID');

    return obj;
  } catch {
    throw new BadRequestError('CURSOR_INVALID');
  }
}

// the sort value of a cursor comes back from the client: a value that does not fit the sort
// is a bad request; passed on, an invalid date or NaN makes prisma fail with a server error

export function cursorDate(v: CursorPayload['v']): Date {
  const date = typeof v === 'string' ? new Date(v) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new BadRequestError('CURSOR_INVALID');

  return date;
}

export function cursorNumber(v: CursorPayload['v']): number {
  const num =
    typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  if (!Number.isFinite(num)) throw new BadRequestError('CURSOR_INVALID');

  return num;
}

export function cursorString(v: CursorPayload['v']): string {
  if (typeof v !== 'string') throw new BadRequestError('CURSOR_INVALID');

  return v;
}
