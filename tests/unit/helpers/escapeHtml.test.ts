import { describe, expect, it } from '@jest/globals';

import { escapeHtml } from '@helpers/escapeHtml.js';

describe('escapeHtml', () => {
  it('escapes every character that can break out of html text or an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>Tom & Jerry</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;Tom &amp; Jerry&lt;/a&gt;',
    );
  });

  it('turns a script tag into harmless text', () => {
    const out = escapeHtml('<script>alert(1)</script>');

    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('escapes an ampersand of an existing entity again instead of trusting it', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('Plain text, 100% safe: ok?')).toBe('Plain text, 100% safe: ok?');
  });

  it('returns an empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });
});
