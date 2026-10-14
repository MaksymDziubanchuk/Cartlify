import { describe, expect, it } from '@jest/globals';

import {
  normalizeCreateCategoryInput,
  normalizeDeleteCategoryInput,
  normalizeFindCategoryByIdInput,
  normalizeUpdateCategoryInput,
  slugifyLoose,
} from '@routes/api/categories/services/helpers/categories.helper.js';
import { ForbiddenError } from '@utils/errors.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

describe('slugifyLoose', () => {
  it.each([
    ['Home & Garden', 'home-garden'],
    ['  Café Décor  ', 'cafe-decor'],
    ['--Already--slugged--', 'already-slugged'],
    ['TV / Audio 2026', 'tv-audio-2026'],
    ['a___b', 'a-b'],
  ])('turns %p into %p', (input, slug) => {
    expect(slugifyLoose(input)).toBe(slug);
  });

  it('returns an empty slug when nothing usable is left', () => {
    expect(slugifyLoose('!!!')).toBe('');
  });
});

describe('normalizeFindCategoryByIdInput', () => {
  it('accepts a positive id', () => {
    expect(normalizeFindCategoryByIdInput({ categoryId: '5' })).toEqual({ categoryId: 5 });
  });

  it.each([0, -1, 'x', null])('rejects %p', (categoryId) => {
    expect(thrownBy(() => normalizeFindCategoryByIdInput({ categoryId }))).toMatchObject({
      errorCode: 'CATEGORY_ID_INVALID',
    });
  });
});

describe('normalizeCreateCategoryInput', () => {
  it('trims the name, slugifies the slug and keeps the parent', () => {
    expect(
      normalizeCreateCategoryInput({
        name: '  Desk Lamps ',
        slug: 'Desk Lamps!',
        description: '  For work ',
        parentId: 2,
      }),
    ).toEqual({
      nameNorm: 'Desk Lamps',
      slugNorm: 'desk-lamps',
      descriptionNorm: 'For work',
      parentIdNorm: 2,
    });
  });

  it('stores a blank description and a missing parent as null', () => {
    expect(
      normalizeCreateCategoryInput({ name: 'Lamps', slug: 'lamps', description: ' ' }),
    ).toMatchObject({
      descriptionNorm: null,
      parentIdNorm: null,
    });
  });

  it.each([
    ['the name is blank', { name: ' ', slug: 'x' }, 'CATEGORY_NAME_INVALID'],
    ['the slug is missing', { name: 'Lamps', slug: undefined }, 'CATEGORY_SLUG_INVALID'],
    ['the slug has no usable characters', { name: 'Lamps', slug: '%%%' }, 'CATEGORY_SLUG_INVALID'],
    [
      'the parent is invalid',
      { name: 'Lamps', slug: 'lamps', parentId: 0 },
      'CATEGORY_PARENT_ID_INVALID',
    ],
  ])('throws when %s', (_case, args, code) => {
    expect(thrownBy(() => normalizeCreateCategoryInput(args))).toMatchObject({ errorCode: code });
  });
});

describe('normalizeUpdateCategoryInput', () => {
  it('changes nothing for an empty patch', () => {
    expect(normalizeUpdateCategoryInput({})).toEqual({
      nameNorm: undefined,
      slugNorm: undefined,
      descriptionNorm: undefined,
      parentIdNorm: undefined,
    });
  });

  it('clears the description and the parent with null', () => {
    expect(normalizeUpdateCategoryInput({ description: null, parentId: null })).toMatchObject({
      descriptionNorm: null,
      parentIdNorm: null,
    });
  });

  it('clears the description with a blank string too', () => {
    expect(normalizeUpdateCategoryInput({ description: '  ' }).descriptionNorm).toBeNull();
  });

  it.each([
    ['the name is blank', { name: '' }, 'CATEGORY_NAME_INVALID'],
    ['the slug is blank', { slug: '  ' }, 'CATEGORY_SLUG_INVALID'],
    ['the slug has no usable characters', { slug: '???' }, 'CATEGORY_SLUG_INVALID'],
    ['the parent is a word', { parentId: 'root' }, 'CATEGORY_PARENT_ID_INVALID'],
  ])('throws when %s', (_case, args, code) => {
    expect(thrownBy(() => normalizeUpdateCategoryInput(args))).toMatchObject({ errorCode: code });
  });
});

describe('normalizeDeleteCategoryInput', () => {
  it('lets an admin delete', () => {
    expect(
      normalizeDeleteCategoryInput({ categoryId: '4', actorId: 1, actorRole: 'ADMIN' }),
    ).toEqual({
      categoryId: 4,
      actorId: 1,
      actorRole: 'ADMIN',
    });
  });

  it('forbids a user before looking at the category', () => {
    expect(
      thrownBy(() =>
        normalizeDeleteCategoryInput({ categoryId: 'bad', actorId: 1, actorRole: 'USER' }),
      ),
    ).toBeInstanceOf(ForbiddenError);
  });
});
