import { BadRequestError } from '@utils/errors.js';
import { b64urlJson } from '@helpers/b64Payload.js';

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

    if (!obj || !Number.isInteger(obj.id) || obj.id <= 0)
      throw new BadRequestError('CURSOR_INVALID');

    return obj;
  } catch {
    throw new BadRequestError('CURSOR_INVALID');
  }
}
