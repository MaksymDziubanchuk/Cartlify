import { describe, expect, it } from '@jest/globals';

import {
  PHONE_PATTERN,
  PROFILE_TEXT_MAX_LENGTH,
  cutProfileText,
  isPhone,
  textLength,
} from '@helpers/profileText.js';

describe('PROFILE_TEXT_MAX_LENGTH', () => {
  it('is 100', () => {
    expect(PROFILE_TEXT_MAX_LENGTH).toBe(100);
  });
});

describe('textLength', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['Ана', 3],
    // an emoji is two UTF-16 units, the schemas count one character
    ['😀', 1],
    ['a😀b', 3],
  ])('counts %p as %p characters', (text, length) => {
    expect(textLength(text)).toBe(length);
  });
});

describe('cutProfileText', () => {
  it('keeps null', () => {
    expect(cutProfileText(null)).toBeNull();
  });

  it('keeps a text of up to 100 characters as it is', () => {
    expect(cutProfileText('')).toBe('');
    expect(cutProfileText('x'.repeat(100))).toBe('x'.repeat(100));
    expect(cutProfileText('😀'.repeat(100))).toBe('😀'.repeat(100));
  });

  it('cuts a longer text to its first 100 characters', () => {
    expect(cutProfileText('x'.repeat(101))).toBe('x'.repeat(100));
    expect(cutProfileText('x'.repeat(5000))).toBe('x'.repeat(100));
  });

  it('never cuts an emoji in the middle', () => {
    const cut = cutProfileText('😀'.repeat(150))!;

    expect(cut).toBe('😀'.repeat(100));
    expect(textLength(cut)).toBe(100);
  });
});

describe('isPhone', () => {
  it.each(['+380501234567', '+12345678', '+123456789012345', '+10000000000'])(
    'accepts %s',
    (value) => {
      expect(isPhone(value)).toBe(true);
    },
  );

  it.each([
    ['', 'an empty value'],
    ['380501234567', 'no plus sign'],
    ['+0123456789', 'a zero after the plus'],
    ['+1234567', 'too few digits'],
    ['+1234567890123456', 'too many digits'],
    ['+38 (050) 123-45-67', 'spaces, brackets and dashes'],
    [' +380501234567', 'a space before'],
    ['+380501234567 ', 'a space after'],
    ['+380501234567\n', 'a line break after'],
    ['++380501234567', 'two plus signs'],
    ['+38050123456a', 'a letter'],
    ['+٣٨٠٥٠١٢٣٤٥٦٧', 'digits of another script'],
  ])('refuses %p (%s)', (value) => {
    expect(isPhone(value)).toBe(false);
  });
});

describe('PHONE_PATTERN', () => {
  // the schema wraps it as an optional group, so an empty value passes there and nowhere else
  const optional = new RegExp(`^(${PHONE_PATTERN})?$`);

  it('lets an empty value through when wrapped as optional', () => {
    expect(optional.test('')).toBe(true);
    expect(optional.test('+380501234567')).toBe(true);
    expect(optional.test('+38 050')).toBe(false);
  });
});

describe('cutProfileText at the limit', () => {
  it('gives back no text as none', () => {
    expect(cutProfileText(null)).toBeNull();
  });

  it('keeps a text of exactly the longest length as it is', () => {
    const text = 'n'.repeat(PROFILE_TEXT_MAX_LENGTH);

    expect(cutProfileText(text)).toBe(text);
  });
});
