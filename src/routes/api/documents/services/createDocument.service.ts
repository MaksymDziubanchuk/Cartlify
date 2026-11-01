import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { InternalError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { normalizeDocumentKind, normalizeDocumentTitle } from '@helpers/documentFields.js';

import { documentSelect, mapDocumentRow } from './helpers/documents.helper.js';

import type { CreateDocumentDto, DocumentDto } from 'types/dto/documents.dto.js';

// the row of a document for the file that waits on Cloudinary. The file is the business of the
// caller, which deletes it when this refuses: for a title or a kind that is wrong or a failed write
export async function createDocument({
  actorId,
  actorRole,
  upload,
  title,
  kind,
}: CreateDocumentDto): Promise<DocumentDto> {
  assertAdminActor(actorId, actorRole);

  try {
    const titleNorm = normalizeDocumentTitle(title);
    const kindNorm = normalizeDocumentKind(kind);
    const file = await upload;

    const row = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const created = await tx.document.create({
        data: {
          title: titleNorm,
          kind: kindNorm,
          url: file.url,
          publicId: file.publicId,
          sizeBytes: file.sizeBytes,
        },
        select: documentSelect,
      });

      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'document',
        entityId: created.id,
        action: 'OTHER',
        event: 'document.create',
        changes: [
          { field: 'title', old: null, new: created.title },
          { field: 'kind', old: null, new: created.kind },
          { field: 'sizeBytes', old: null, new: created.sizeBytes },
        ],
      });

      return created;
    });

    return mapDocumentRow(row);
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'DOCUMENTS_CREATE_UNEXPECTED' }, err);
  }
}
