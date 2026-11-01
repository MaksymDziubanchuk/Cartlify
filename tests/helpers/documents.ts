import type { FormPart } from './multipart.js';

const PAGE_OBJECTS = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
];

// a small PDF as the bytes of a file: one empty page and a table of its objects, which is what
// Cloudinary reads of a pdf it keeps (a file that only starts as a pdf does is refused). extra
// bytes of spaces make it bigger
export const samplePdf = (extra = 0): Buffer => {
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  PAGE_OBJECTS.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const table = body.length;
  body += `xref\n0 ${PAGE_OBJECTS.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${PAGE_OBJECTS.length + 1} /Root 1 0 R >>\nstartxref\n${table}\n%%EOF\n`;

  return Buffer.concat([Buffer.from(body), Buffer.alloc(extra, 0x20)]);
};

// a file that starts as a pdf does but has no page: the app takes it by its bytes, Cloudinary
// refuses it
export const brokenPdf = (): Buffer => Buffer.from('%PDF-1.4\nthis is not a pdf at all\n');

// the file part of a document form
export const pdfField = (
  data: Buffer = samplePdf(),
  opts: { name?: string; filename?: string; contentType?: string } = {},
): FormPart => ({
  name: opts.name ?? 'file',
  filename: opts.filename ?? 'manual.pdf',
  contentType: opts.contentType ?? 'application/pdf',
  data,
});
