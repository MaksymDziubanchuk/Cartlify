import env from '@config/env.js';

// the biggest file a multipart request may carry, in bytes (UPLOAD_MAX_BYTES, 5 MB unless set): a
// bigger one is cut off while it is read and the request is answered with 413 PAYLOAD_TOO_LARGE.
// The swagger names the same number
export const MAX_UPLOAD_SIZE_BYTES = env.UPLOAD_MAX_BYTES;

// the images one product has at most, the ones of one form too (PRODUCT_IMAGES_MAX, 10 unless set)
export const MAX_PRODUCT_IMAGES = env.PRODUCT_IMAGES_MAX;

// the biggest x-www-form-urlencoded body, in bytes
export const FORM_BODY_LIMIT_BYTES = 1_048_576;
