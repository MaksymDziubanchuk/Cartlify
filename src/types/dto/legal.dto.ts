// LEGAL: the versions of the terms and of the contract of the shop and the consents to them

export type LegalDocumentKind = 'terms' | 'contract';

// a version with its text
export interface LegalDocumentDto {
  id: number;
  kind: LegalDocumentKind;
  version: number;
  title: string;
  content: string;
  sha256: string;
  publishedAt: string;
}

// a version without its text
export interface LegalDocumentSummaryDto {
  id: number;
  kind: LegalDocumentKind;
  version: number;
  title: string;
}

// a version in the history root reads, with who published it
export interface LegalDocumentHistoryItemDto {
  id: number;
  kind: LegalDocumentKind;
  version: number;
  title: string;
  sha256: string;
  publishedAt: string;
  publishedBy: { id: number; name: string | null; email: string | null };
}

export interface PublishLegalDocumentBodyDto {
  kind: LegalDocumentKind;
  title: string;
  content: string;
}

export interface LegalDocumentsHistoryQueryDto {
  kind?: LegalDocumentKind;
  limit?: number;
  cursor?: string;
}

export interface LegalDocumentsHistoryResponseDto {
  items: LegalDocumentHistoryItemDto[];
  nextCursor: string | null;
}

export interface LegalDocumentParamsDto {
  documentId: number | string;
}

// what the customer accepted of each kind, the version in force or an older one
export interface LegalAcceptedDto {
  documentId: number;
  kind: LegalDocumentKind;
  version: number;
  acceptedAt: string;
}

// the versions in force, what the customer accepted, and the kinds still to accept
export interface LegalAcceptanceStatusDto {
  current: LegalDocumentSummaryDto[];
  accepted: LegalAcceptedDto[];
  required: LegalDocumentKind[];
}

export interface AcceptLegalDocumentsBodyDto {
  documentIds: number[];
}
