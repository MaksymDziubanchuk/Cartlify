export type FormPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; data: Buffer };

// a multipart/form-data request body the way a browser form sends it; the payload and the
// content-type header (with the boundary) go to app.inject together
export function multipartBody(parts: FormPart[]): {
  payload: Buffer;
  headers: { 'content-type': string };
} {
  const boundary = `----cartlify-test-${Date.now().toString(16)}`;
  const chunks: Buffer[] = [];

  for (const part of parts) {
    const disposition =
      'filename' in part
        ? `form-data; name="${part.name}"; filename="${part.filename}"`
        : `form-data; name="${part.name}"`;
    const type = 'filename' in part ? `\r\nContent-Type: ${part.contentType}` : '';
    const body = 'filename' in part ? part.data : Buffer.from(part.value);

    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}${type}\r\n\r\n`),
      body,
      Buffer.from('\r\n'),
    );
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
