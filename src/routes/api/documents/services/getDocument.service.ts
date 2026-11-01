import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { InternalError, NotFoundError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';

import { documentSelect, mapDocumentRow, usageOf } from './helpers/documents.helper.js';

import type { DocumentDetailDto, GetDocumentDto } from 'types/dto/documents.dto.js';

// a document of the directory with the number of products that name it
export async function getDocument({
  actorId,
  actorRole,
  documentId,
}: GetDocumentDto): Promise<DocumentDetailDto> {
  assertAdminActor(actorId, actorRole);

  try {
    return await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const row = await tx.document.findUnique({
        where: { id: documentId },
        select: documentSelect,
      });
      if (!row) throw new NotFoundError('DOCUMENT_NOT_FOUND');

      const usage = (await usageOf(tx, [documentId])).get(documentId)!;
      return { ...mapDocumentRow(row), usage };
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'DOCUMENTS_GET_UNEXPECTED' }, err);
  }
}
