import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { ConflictError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';
import { deleteDocument as deleteDocumentFile, isOwnFile } from '@utils/cloudinary.util.js';
import { assertAdminActor } from '@helpers/roleGuard.js';

import { isForeignKeyViolation, productsNaming } from './helpers/documents.helper.js';

import type { DeleteDocumentDto } from 'types/dto/documents.dto.js';
import type { MessageResponseDto } from 'types/common.js';

// takes a document out of the directory and deletes its file after the commit; a document a
// product names stays: 409 DOCUMENT_IN_USE names some of the products and how many
export async function deleteDocument({
  actorId,
  actorRole,
  documentId,
  log,
}: DeleteDocumentDto): Promise<MessageResponseDto> {
  assertAdminActor(actorId, actorRole);

  let publicId: string | null = null;

  try {
    await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const document = await tx.document.findUnique({
        where: { id: documentId },
        select: { title: true, kind: true, sizeBytes: true, publicId: true },
      });
      if (!document) throw new NotFoundError('DOCUMENT_NOT_FOUND');

      const naming = await productsNaming(tx, documentId);
      if (naming.total > 0) throw new ConflictError('DOCUMENT_IN_USE', naming);

      await tx.document.delete({ where: { id: documentId } });

      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'document',
        entityId: documentId,
        action: 'OTHER',
        event: 'document.delete',
        changes: [
          { field: 'title', old: document.title, new: null },
          { field: 'kind', old: document.kind, new: null },
          { field: 'sizeBytes', old: document.sizeBytes, new: null },
        ],
      });

      publicId = document.publicId;
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    // a product that named the document between the check and the delete: the key of the database holds
    if (isForeignKeyViolation(err)) throw new ConflictError('DOCUMENT_IN_USE');

    throw new InternalError({ reason: 'DOCUMENTS_DELETE_UNEXPECTED' }, err);
  }

  // the file goes once the row is gone, and only a file of this environment: dev is restored from a
  // copy of prod, whose rows can name the files of prod
  if (isOwnFile(publicId)) {
    try {
      await deleteDocumentFile(publicId);
    } catch (err) {
      log.warn({ err, publicId }, 'file of a deleted document was not deleted');
    }
  }

  return { message: 'Document deleted successfully.' };
}
