import { describe, expect, it } from '@jest/globals';

import pickDefined from '@helpers/parameterNormalize.js';

type Dto = {
  id: number;
  name: string;
  note?: string | null;
  limit?: number;
};

describe('pickDefined', () => {
  it('keeps every required value', () => {
    const out = pickDefined<Dto>({ id: 1, name: 'a' }, { note: undefined, limit: undefined });

    expect(out).toEqual({ id: 1, name: 'a' });
  });

  it('adds optional values that are set', () => {
    const out = pickDefined<Dto>({ id: 1, name: 'a' }, { note: 'hi', limit: 0 });

    expect(out).toEqual({ id: 1, name: 'a', note: 'hi', limit: 0 });
  });

  it('leaves out optional keys that are undefined, so the result has no undefined keys', () => {
    const out = pickDefined<Dto>({ id: 1, name: 'a' }, { note: undefined, limit: 5 });

    expect(Object.keys(out)).toEqual(['id', 'name', 'limit']);
  });

  it('keeps null, because null is a deliberate value', () => {
    const out = pickDefined<Dto>({ id: 1, name: 'a' }, { note: null, limit: undefined });

    expect(out).toEqual({ id: 1, name: 'a', note: null });
  });

  it('does not change the objects it was given', () => {
    const required = { id: 1, name: 'a' };
    const patch = { note: 'x', limit: undefined };

    pickDefined<Dto>(required, patch);

    expect(required).toEqual({ id: 1, name: 'a' });
    expect(patch).toEqual({ note: 'x', limit: undefined });
  });
});
