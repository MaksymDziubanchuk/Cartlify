import { describe, expect, it } from '@jest/globals';

import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

describe('withOpenApiTag', () => {
  it('tags every schema that has no tags', () => {
    const out = withOpenApiTag({ list: {}, get: { summary: 'get' } }, 'Products');

    expect((out.list as { tags?: unknown }).tags).toEqual(['Products']);
    expect(out.get).toEqual({ summary: 'get', tags: ['Products'] });
  });

  it('keeps tags that a schema already declares', () => {
    const out = withOpenApiTag({ special: { tags: ['Admin'] } }, 'Products');

    expect(out.special.tags).toEqual(['Admin']);
  });
});
