import type { FastifyBaseLogger } from 'fastify';
import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';
import type { DocumentKind } from '@helpers/documentFields.js';
import type { UploadDocumentResult } from '@utils/cloudinary.util.js';

// a document of the directory: its title, its kind and the url of its PDF
export interface DocumentDto {
  id: number;
  title: string;
  kind: DocumentKind;
  url: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDetailDto extends DocumentDto {
  // how many products name the document
  usage: { products: number };
}

export interface DocumentParamsDto {
  documentId: string;
}

export interface UpdateDocumentBodyDto {
  title?: string;
  kind?: DocumentKind;
}

export interface DocumentsListQueryDto {
  limit?: number;
  cursor?: string;
  q?: string;
  kind?: DocumentKind;
  sortOrder?: 'asc' | 'desc';
}

export interface DocumentsListResponseDto {
  items: DocumentDetailDto[];
  total: number;
  limit: number;
  nextCursor: string | null;
}

interface DocumentActorDto {
  actorId: UserId;
  actorRole: Role;
}

// the file of a form, waiting on Cloudinary
export type UploadedDocumentFile = UploadDocumentResult;

export interface CreateDocumentDto extends DocumentActorDto {
  upload: Promise<UploadedDocumentFile>;
  title: unknown;
  kind: unknown;
}

export interface UpdateDocumentDto extends DocumentActorDto {
  documentId: number;
  body: unknown;
}

export interface GetDocumentDto extends DocumentActorDto {
  documentId: number;
}

export interface DeleteDocumentDto extends GetDocumentDto {
  log: Pick<FastifyBaseLogger, 'warn'>;
}

export interface ListDocumentsDto extends DocumentActorDto {
  limit: number;
  cursor?: string;
  q?: string;
  kind?: DocumentKind;
  sortOrder: 'asc' | 'desc';
}
