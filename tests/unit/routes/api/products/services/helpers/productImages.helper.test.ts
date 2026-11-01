import { describe, expect, it } from '@jest/globals';

import {
  IMAGES_TX_BASE_MS,
  IMAGES_TX_PER_FILE_MS,
  imagesTxTimeout,
} from '@routes/api/products/services/helpers/productImages.helper.js';

// the transaction of a gallery moves its files at Cloudinary one after the other before it ends
describe('imagesTxTimeout', () => {
  it('gives the time the transaction had whatever its files, and the time of a move for each file', () => {
    expect(imagesTxTimeout(0)).toBe(IMAGES_TX_BASE_MS);
    expect(imagesTxTimeout(1)).toBe(IMAGES_TX_BASE_MS + IMAGES_TX_PER_FILE_MS);
    expect(imagesTxTimeout(10)).toBe(IMAGES_TX_BASE_MS + 10 * IMAGES_TX_PER_FILE_MS);
  });

  it('is never below the 20 s the transaction had before it grew with the files', () => {
    expect(IMAGES_TX_BASE_MS).toBeGreaterThanOrEqual(20_000);
  });

  // a full gallery of 50 pictures at 2 s a move
  it('leaves room for the moves of a full gallery', () => {
    expect(imagesTxTimeout(50)).toBeGreaterThanOrEqual(50 * 2_000);
  });
});
