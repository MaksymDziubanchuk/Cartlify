// the biggest file a multipart request may carry, in bytes: a bigger one is cut off while it is
// read and the request is answered with 413 PAYLOAD_TOO_LARGE. The swagger names the same number
export const MAX_UPLOAD_SIZE_BYTES = 5_000_000;

// the images one product has at most, the ones of one form too
export const MAX_PRODUCT_IMAGES = 10;

// the biggest x-www-form-urlencoded body, in bytes
export const FORM_BODY_LIMIT_BYTES = 1_048_576;
