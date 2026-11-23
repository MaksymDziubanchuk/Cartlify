// The number of an invoice or a credit note as it is printed and told: its series and its number in
// it (F2026-12, db/05: tax_document_number). A receipt has none of its own: null
export function taxDocumentNumberOf(series: string | null, number: number | null): string | null {
  return series && number ? `${series}-${number}` : null;
}

// the same as the name of a file: only the signs a file name takes everywhere (a series may hold a
// slash, F/2026)
export function taxDocumentFileNameOf(series: string | null, number: number | null): string {
  return `${(taxDocumentNumberOf(series, number) ?? 'document').replace(/[^A-Za-z0-9_.-]/g, '_')}.pdf`;
}
