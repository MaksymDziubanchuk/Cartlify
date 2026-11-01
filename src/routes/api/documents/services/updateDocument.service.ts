import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import type { AuditChange } from '@db/adminAudit.helper.js';
import { BadRequestError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { normalizeDocumentKind, normalizeDocumentTitle } from '@helpers/documentFields.js';

import { documentSelect, mapDocumentRow } from './helpers/documents.helper.js';

import type { DocumentDto, UpdateDocumentDto } from 'types/dto/documents.dto.js';

const FIELDS = ['title', 'kind'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// changes the title and the kind of a document that were named; its file stays. Nothing named is
// no change (400), named values it has already are 200 with nothing written and no line of the log
export async function updateDocument({
  actorId,
  actorRole,
  documentId,
  body,
}: UpdateDocumentDto): Promise<DocumentDto> {
  assertAdminActor(actorId, actorRole);

  const named = isRecord(body) ? body : {};
  if (named.title === undefined && named.kind === undefined) {
    throw new BadRequestError('NO_FIELDS_TO_UPDATE');
  }
  const values = {
    ...(named.title !== undefined ? { title: normalizeDocumentTitle(named.title) } : {}),
    ...(named.kind !== undefined ? { kind: normalizeDocumentKind(named.kind) } : {}),
  };

  try {
    const row = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const before = await tx.document.findUnique({
        where: { id: documentId },
        select: documentSelect,
      });
      if (!before) throw new NotFoundError('DOCUMENT_NOT_FOUND');

      const changed = FIELDS.filter(
        (key) => values[key] !== undefined && values[key] !== before[key],
      );
      if (!changed.length) return before;

      const updated = await tx.document.update({
        where: { id: documentId },
        data: Object.fromEntries(changed.map((key) => [key, values[key]])),
        select: documentSelect,
      });

      const changes: AuditChange[] = changed.map((key) => ({
        field: key,
        old: before[key],
        new: values[key],
      }));
      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'document',
        entityId: documentId,
        action: 'OTHER',
        event: 'document.update',
        changes,
      });

      return updated;
    });

    return mapDocumentRow(row);
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'DOCUMENTS_UPDATE_UNEXPECTED' }, err);
  }
}
