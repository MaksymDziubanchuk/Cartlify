import { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { BadRequestError, NotFoundError } from '@utils/errors.js';

import {
  currentDocuments,
  legalDocumentOf,
  legalDocumentSelect,
} from './helpers/legalDocuments.helper.js';

import type {
  LegalDocumentDto,
  LegalDocumentKind,
  LegalDocumentsHistoryResponseDto,
} from 'types/dto/legal.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the versions of the terms and of the contract of the shop. Root publishes a version
// (POST /api/root/legal-documents) and reads the history; everybody reads the versions in force
// and any version by its id. A version is never changed: the next one replaces it, the database
// numbers it and keeps the sha256 of its text (db/05)

type Actor = { actorId: UserId; actorRole: Role };

// the title loses the spaces at its edges, the text stays as it was sent; neither is spaces only
export async function publishLegalDocument(
  args: Actor & { kind: LegalDocumentKind; title: string; content: string },
): Promise<LegalDocumentDto> {
  const title = args.title.trim();
  if (!title || !args.content.trim()) throw new BadRequestError('LEGAL_DOCUMENT_EMPTY');

  const row = await prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    return db.legalDocument.create({
      data: {
        kind: args.kind,
        title,
        content: args.content,
        publishedById: Number(args.actorId),
        // both come from the database
        version: 0,
        sha256: '',
      },
      select: legalDocumentSelect,
    });
  });

  return legalDocumentOf(row);
}

// every version, the latest first, without the texts
export async function listLegalDocuments(
  args: Actor & {
    kind?: LegalDocumentKind | undefined;
    limit: number;
    cursor?: string | undefined;
  },
): Promise<LegalDocumentsHistoryResponseDto> {
  const after = args.cursor ? decodeCursor(args.cursor).id : undefined;
  const where: Prisma.LegalDocumentWhereInput = {
    ...(args.kind ? { kind: args.kind } : {}),
    ...(after !== undefined ? { id: { lt: after } } : {}),
  };

  const rows = await prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    return db.legalDocument.findMany({
      where,
      orderBy: { id: 'desc' },
      take: args.limit + 1,
      select: {
        id: true,
        kind: true,
        version: true,
        title: true,
        sha256: true,
        createdAt: true,
        publishedBy: { select: { id: true, name: true, email: true, deletedAt: true } },
      },
    });
  });

  const page = rows.slice(0, args.limit);
  const last = page[page.length - 1];

  return {
    items: page.map((row) => ({
      id: row.id,
      kind: row.kind as LegalDocumentKind,
      version: row.version,
      title: row.title,
      sha256: row.sha256,
      publishedAt: row.createdAt.toISOString(),
      publishedBy: {
        id: row.publishedBy.id,
        name: row.publishedBy.name,
        // a deleted account keeps what it published, not its address
        email: row.publishedBy.deletedAt ? null : row.publishedBy.email,
      },
    })),
    nextCursor: rows.length > args.limit && last ? encodeCursor({ id: last.id, v: null }) : null,
  };
}

// the latest version of each kind, terms first; none before root publishes one
export async function getCurrentLegalDocuments(): Promise<{ items: LegalDocumentDto[] }> {
  const rows = await prisma.$transaction((db) => currentDocuments(db));
  return { items: rows.map(legalDocumentOf) };
}

export async function getLegalDocument(documentId: number): Promise<LegalDocumentDto> {
  const row = await prisma.legalDocument.findUnique({
    where: { id: documentId },
    select: legalDocumentSelect,
  });
  if (!row) throw new NotFoundError('LEGAL_DOCUMENT_NOT_FOUND', { documentId });

  return legalDocumentOf(row);
}
