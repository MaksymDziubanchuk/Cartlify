import { Prisma } from '@prisma/client';

import { getPgCode, getPgMessage, prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  writeAdminAuditLog,
  writeAdminAuditLogs,
  type AuditChange,
} from '@db/adminAudit.helper.js';
import type { AuditEvent, WrittenEvent } from '@config/journalEvents.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { AppError, InternalError, ResourceBusyError, isAppError } from '@utils/errors.js';

import type {
  AttributeActorDto,
  AttributeDto,
  AttributeOptionDto,
} from 'types/dto/attributes.dto.js';

// how many ids a refusal names, the rest is counted in details.total
export const NAMED_MAX = 20;

export type Tx = Prisma.TransactionClient;

// how many times a write runs again when another request took its place first, and the wait before
// the next run (doubled each time)
const PLACE_RETRIES = 3;
const PLACE_WAIT_MS = 20;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// runs fn in the transaction of an admin or a root (the context of RLS), and turns a failure of the
// database into an answer: an AppError goes through as it is, a failure onDbError knows is its
// AppError (a name that is taken), any other is 500. The key of the places is checked at the end of
// the transaction: two requests that took the same next place meet there, and the one that lost
// runs again (fn reads the places anew) up to PLACE_RETRIES times before it is asked to come again
// (409 RESOURCE_BUSY)
export async function inAdminTx<T>(
  actor: AttributeActorDto,
  reason: string,
  fn: (tx: Tx) => Promise<T>,
  onDbError?: (err: unknown) => Promise<AppError | null>,
  // a transaction that does more than rows (the pictures move at Cloudinary inside it) needs more
  // time than the default of prisma
  opts: { timeout?: number } = {},
): Promise<T> {
  assertAdminActor(actor.actorId, actor.actorRole);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await setUserContext(tx, { userId: actor.actorId, role: actor.actorRole });
          return fn(tx);
        },
        opts.timeout !== undefined ? { timeout: opts.timeout } : undefined,
      );
    } catch (err) {
      if (isAppError(err)) throw err;

      if (isUniqueViolationOn(err, '_position_key')) {
        if (attempt >= PLACE_RETRIES) {
          throw new ResourceBusyError({ reason: 'DIRECTORY_PLACE_TAKEN' }, err);
        }

        await sleep(PLACE_WAIT_MS * 2 ** attempt + Math.floor(Math.random() * PLACE_WAIT_MS));
        continue;
      }

      const known = onDbError ? await onDbError(err) : null;
      if (known) throw known;

      throw new InternalError({ reason }, err);
    }
  }
}

// locks the row a write depends on until the end of the transaction, and says whether it is there.
// SHARE keeps the row from being deleted or changed meanwhile (a value made for a characteristic
// that is a choice, a characteristic made in a group); UPDATE waits for those and keeps the others
// out (a change of a type that counts the values). Without it two requests that meet get a
// characteristic of a text with values, or a row whose parent is gone
export async function lockRow(
  tx: Tx,
  table: 'attributes' | 'attribute_groups',
  id: number,
  mode: 'SHARE' | 'UPDATE',
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT id FROM ${Prisma.raw(`cartlify.${table}`)} WHERE id = ${id}::int FOR ${Prisma.raw(mode)}
  `);

  return rows.length > 0;
}

// a failure the driver adapter raises when the transaction commits (a key that is checked at the
// end, like the places) comes bare, not as a Prisma error: its cause names the kind and the
// constraint
type AdapterCause = { kind?: string; constraint?: { index?: string; fields?: string[] } };

const adapterCauseOf = (err: unknown): AdapterCause | null =>
  err instanceof Error && err.name === 'DriverAdapterError'
    ? ((err as { cause?: AdapterCause }).cause ?? null)
    : null;

// a failed write that is a unique key or index whose name ends with the text given
export function isUniqueViolationOn(err: unknown, nameEnd: string): boolean {
  const adapter = adapterCauseOf(err);
  if (adapter) {
    return (
      adapter.kind === 'UniqueConstraintViolation' &&
      JSON.stringify(adapter.constraint ?? {}).includes(nameEnd)
    );
  }

  const unique =
    (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') ||
    getPgCode(err) === '23505';
  if (!unique) return false;

  const meta = err instanceof Prisma.PrismaClientKnownRequestError ? err.meta : undefined;
  const text = `${JSON.stringify(meta ?? {})} ${getPgMessage(err) ?? ''} ${(err as Error)?.message ?? ''}`;
  return text.includes(nameEnd);
}

export const isForeignKeyViolation = (err: unknown) =>
  adapterCauseOf(err)?.kind === 'ForeignKeyConstraintViolation' ||
  (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') ||
  getPgCode(err) === '23503';

// a failed write that is a foreign key whose name ends with the text given (a write that points at
// a row another request deleted meanwhile)
export function isForeignKeyViolationOn(err: unknown, nameEnd: string): boolean {
  const adapter = adapterCauseOf(err);
  if (adapter) {
    return (
      adapter.kind === 'ForeignKeyConstraintViolation' &&
      JSON.stringify(adapter.constraint ?? {}).includes(nameEnd)
    );
  }

  if (!isForeignKeyViolation(err)) return false;

  const meta = err instanceof Prisma.PrismaClientKnownRequestError ? err.meta : undefined;
  const text = `${JSON.stringify(meta ?? {})} ${getPgMessage(err) ?? ''} ${(err as Error)?.message ?? ''}`;
  return text.includes(nameEnd);
}

// a line of the admin log of the directory
export function logDirectory(
  tx: Tx,
  actor: AttributeActorDto,
  line: {
    event: WrittenEvent<AuditEvent>;
    entityId: number;
    changes: AuditChange[];
  },
): Promise<void> {
  return writeAdminAuditLog(tx, {
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    entityType: 'attribute',
    entityId: line.entityId,
    action: 'OTHER',
    event: line.event,
    changes: line.changes,
  });
}

// writes a new order of a whole list of the directory (the groups, the characteristics of a group,
// the values of a characteristic): the place of each row that moved in one statement, and its line
// of the log in one more. A statement for each row ran a list of hundreds past the time of its
// transaction (409 RESOURCE_BUSY). The key of the places is checked at the end of the transaction,
// so the rows may take each other's places in the one statement
export async function writeListOrder(
  tx: Tx,
  actor: AttributeActorDto,
  args: {
    table: 'attribute_groups' | 'attributes' | 'attribute_options';
    event: WrittenEvent<AuditEvent>;
    // the place of each row before, by its id
    before: Map<number, number>;
    // every id of the list in its new order, the first gets place 1
    ids: number[];
  },
): Promise<void> {
  const moved = args.ids
    .map((id, at) => ({ id, old: args.before.get(id), position: at + 1 }))
    .filter((row) => row.old !== row.position);
  if (!moved.length) return;

  await tx.$executeRaw(Prisma.sql`
    UPDATE ${Prisma.raw(`cartlify.${args.table}`)} AS target
    SET position = moved.position, "updatedAt" = now()
    FROM unnest(${moved.map((row) => row.id)}::int[], ${moved.map((row) => row.position)}::int[])
      AS moved(id, position)
    WHERE target.id = moved.id
  `);

  await writeAdminAuditLogs(tx, {
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    entityType: 'attribute',
    action: 'OTHER',
    event: args.event,
    lines: moved.map((row) => ({
      entityId: row.id,
      changes: [{ field: 'position', old: row.old, new: row.position }],
    })),
  });
}

type AttributeRow = {
  id: number;
  name: string;
  type: AttributeDto['type'];
  unit: string | null;
  groupId: number;
  group: { id: number; name: string };
  position: number;
  isMain: boolean;
  inFilters: boolean;
  decimals: number | null;
  minValue: Prisma.Decimal | null;
  maxValue: Prisma.Decimal | null;
  createdAt: Date;
  updatedAt: Date;
};

export const attributeSelect = {
  id: true,
  name: true,
  type: true,
  unit: true,
  groupId: true,
  group: { select: { id: true, name: true } },
  position: true,
  isMain: true,
  inFilters: true,
  decimals: true,
  minValue: true,
  maxValue: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const mapAttributeRow = (row: AttributeRow): AttributeDto => ({
  id: row.id,
  name: row.name,
  type: row.type,
  unit: row.unit,
  groupId: row.groupId,
  group: row.group,
  position: row.position,
  isMain: row.isMain,
  inFilters: row.inFilters,
  decimals: row.decimals,
  minValue: row.minValue === null ? null : decimalToNumber(row.minValue),
  maxValue: row.maxValue === null ? null : decimalToNumber(row.maxValue),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const optionSelect = {
  id: true,
  attributeId: true,
  name: true,
  position: true,
  colorCode: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const mapOptionRow = (row: {
  id: number;
  attributeId: number;
  name: string;
  position: number;
  colorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AttributeOptionDto => ({
  id: row.id,
  attributeId: row.attributeId,
  name: row.name,
  position: row.position,
  colorCode: row.colorCode,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
