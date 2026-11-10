import env from '@config/env.js';

// the biggest file a multipart request may carry, in bytes (UPLOAD_MAX_BYTES, 5 MB unless set): a
// bigger one is cut off while it is read and the request is answered with 413 PAYLOAD_TOO_LARGE.
// The swagger names the same number
export const MAX_UPLOAD_SIZE_BYTES = env.UPLOAD_MAX_BYTES;

// the images one product has at most in its gallery, the ones of one form too (PRODUCT_IMAGES_MAX,
// 50 unless set)
export const MAX_PRODUCT_IMAGES = env.PRODUCT_IMAGES_MAX;

// the variants one product has at most, the deleted ones too (PRODUCT_VARIANTS_MAX, 200 unless set)
export const MAX_PRODUCT_VARIANTS = env.PRODUCT_VARIANTS_MAX;

// the pictures of the gallery one variant shows at most (VARIANT_IMAGES_MAX, 10 unless set)
export const MAX_VARIANT_IMAGES = env.VARIANT_IMAGES_MAX;

// the biggest PDF file of a document, in bytes (DOCUMENT_MAX_BYTES, 20 MB unless set): the routes of
// the documents raise the limit of the multipart plugin to it, every other route keeps
// MAX_UPLOAD_SIZE_BYTES
export const MAX_DOCUMENT_SIZE_BYTES = env.DOCUMENT_MAX_BYTES;

// the documents one product names at most (PRODUCT_DOCUMENTS_MAX, 20 unless set)
export const MAX_PRODUCT_DOCUMENTS = env.PRODUCT_DOCUMENTS_MAX;

// the values one characteristic of a choice has at most (ATTRIBUTE_OPTIONS_MAX, 500 unless set)
export const MAX_ATTRIBUTE_OPTIONS = env.ATTRIBUTE_OPTIONS_MAX;

// the values of a set one variant has for one characteristic at most (ATTRIBUTE_MULTI_VALUES_MAX, 50
// unless set)
export const MAX_ATTRIBUTE_MULTI_VALUES = env.ATTRIBUTE_MULTI_VALUES_MAX;

// the biggest x-www-form-urlencoded body, in bytes
export const FORM_BODY_LIMIT_BYTES = 1_048_576;

// the filter of the catalog by characteristics (`f`, src/helpers/characteristicFilter.ts): the
// entries of a request (one for a characteristic), the values of a list one entry names, and the
// length of an entry in characters
export const FILTER_ENTRIES_MAX = 20;
export const FILTER_VALUES_MAX = 100;
export const FILTER_ENTRY_MAX_LENGTH = 1000;

// the biggest body of the Event Webhook of SendGrid, in bytes. SendGrid delivers the events in batches
// (up to about 3 MB, as far as its documentation tells), where every other json body is cut at 1 MB.
// The body is read whole before the signature can be checked, so the limit is no bigger than a batch
export const SENDGRID_WEBHOOK_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
