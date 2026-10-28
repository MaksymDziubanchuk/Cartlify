import { describe, expect, it } from '@jest/globals';

import {
  HIDDEN_ID,
  HIDDEN_TEXT,
  hiddenAccount,
  hiddenChanges,
  hiddenText,
  hiddenValue,
} from '@helpers/rootHidden.js';

describe('rootHidden', () => {
  it('hides a text and keeps none as none', () => {
    expect(hiddenText('203.0.113.5')).toBe(HIDDEN_TEXT);
    expect(hiddenText('')).toBe(HIDDEN_TEXT);
    expect(hiddenText(null)).toBeNull();
  });

  it('hides each text and number of a value, inside lists and objects too, and keeps the rest', () => {
    expect(hiddenValue('root@example.com')).toBe('hidden');
    expect(hiddenValue(42)).toBe(0);
    expect(hiddenValue(true)).toBe(true);
    expect(hiddenValue(null)).toBeNull();
    expect(hiddenValue(undefined)).toBeUndefined();
    expect(hiddenValue({ id: 7, name: 'Root', on: false, tags: ['a', 3] })).toEqual({
      id: 0,
      name: 'hidden',
      on: false,
      tags: ['hidden', 0],
    });
  });

  it('names the fields of the changes and hides their values', () => {
    expect(
      hiddenChanges([
        { field: 'email', old: 'a@example.com', new: 'b@example.com' },
        { field: 'deletedAt', old: null, new: '2026-10-28T10:00:00.000Z' },
        { field: 'avatarRemovals', old: 1, new: 2 },
      ]),
    ).toEqual([
      { field: 'email', old: 'hidden', new: 'hidden' },
      { field: 'deletedAt', old: null, new: 'hidden' },
      { field: 'avatarRemovals', old: 0, new: 0 },
    ]);
  });

  it('gives the account of root the id 0, its texts hidden and its role', () => {
    expect(hiddenAccount('Root', 'root@example.com')).toEqual({
      id: HIDDEN_ID,
      name: 'hidden',
      email: 'hidden',
      role: 'ROOT',
    });
    expect(hiddenAccount(null, null)).toEqual({ id: 0, name: null, email: null, role: 'ROOT' });
  });
});
