import { BadRequestError } from '@utils/errors.js';

// the title and the kind of a document of the directory (src/routes/api/documents); db/06 holds the
// same values

export const DOCUMENT_KINDS = ['instruction', 'certificate', 'declaration', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_TITLE_MAX = 200;

export const isDocumentKind = (value: unknown): value is DocumentKind =>
  typeof value === 'string' && (DOCUMENT_KINDS as readonly string[]).includes(value);

// the title as it is kept: trimmed. Missing, not text or blank is 400 DOCUMENT_TITLE_REQUIRED,
// more than DOCUMENT_TITLE_MAX signs (as a person counts them) 400 DOCUMENT_TITLE_TOO_LONG
export function normalizeDocumentTitle(input: unknown): string {
  const title = typeof input === 'string' ? input.trim() : '';
  if (!title) throw new BadRequestError('DOCUMENT_TITLE_REQUIRED');

  if ([...title].length > DOCUMENT_TITLE_MAX) {
    throw new BadRequestError('DOCUMENT_TITLE_TOO_LONG', { max: DOCUMENT_TITLE_MAX });
  }

  return title;
}

// the kind, one of the four; a form gives it as text, a missing or other one is 400
// DOCUMENT_KIND_INVALID naming the four
export function normalizeDocumentKind(input: unknown): DocumentKind {
  const kind = typeof input === 'string' ? input.trim() : input;
  if (!isDocumentKind(kind)) {
    throw new BadRequestError('DOCUMENT_KIND_INVALID', { allowed: [...DOCUMENT_KINDS] });
  }

  return kind;
}
