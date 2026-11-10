import { describe, expect, it } from '@jest/globals';

import {
  MARKUP_MAX_LENGTH,
  MARKUP_MAX_NESTING,
  MarkupTooLongError,
  linksOfMarkup,
  parseMarkup,
  renderMarkupHtml,
  renderMarkupText,
} from '@helpers/newsletterMarkup.js';

const ORIGIN = 'https://shop.example.com';
const SHOP = { origin: ORIGIN };
const MARKED = { origin: ORIGIN, campaignId: 7 };
// the marks as they stand in the attribute of a link: an ampersand is escaped there
const UTM = 'utm_source=newsletter&amp;utm_campaign=7';
const UTM_PLAIN = 'utm_source=newsletter&utm_campaign=7';

type Options = { origin: string | null; campaignId?: number; trusted?: readonly string[] };

const html = (source: string, options: Options = SHOP) =>
  renderMarkupHtml(parseMarkup(source), options);
const text = (source: string, options: Options = SHOP) =>
  renderMarkupText(parseMarkup(source), options);

const anchor = (href: string, label: string) =>
  `<a href="${href}" rel="noopener noreferrer">${label}</a>`;

// The text an admin writes in a block of a newsletter is a small markup: **bold**, *italic*, a line
// that starts with "# " is a heading, lines that start with "- " are a list, [label](url) is a link
// and an empty line separates paragraphs. The server turns it into a safe html and a plain text, and
// nothing the admin types reaches the mail as markup of its own
describe('the structure of the markup', () => {
  it('reads a paragraph', () => {
    expect(parseMarkup('Hello')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'Hello' }] },
    ]);
  });

  it('reads the bold, the italic and the plain parts of a paragraph', () => {
    expect(parseMarkup('a **b** and *c* d')).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'a ' },
          { type: 'bold', children: [{ type: 'text', text: 'b' }] },
          { type: 'text', text: ' and ' },
          { type: 'italic', children: [{ type: 'text', text: 'c' }] },
          { type: 'text', text: ' d' },
        ],
      },
    ]);
  });

  it('reads a heading, a list and a paragraph, each from its own lines', () => {
    expect(parseMarkup('# Title\n- one\n- two\nAfter')).toEqual([
      { type: 'heading', children: [{ type: 'text', text: 'Title' }] },
      {
        type: 'list',
        items: [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]],
      },
      { type: 'paragraph', children: [{ type: 'text', text: 'After' }] },
    ]);
  });

  it('reads a link with its label and its address as they were written', () => {
    expect(parseMarkup('[Shop](/sale)')).toEqual([
      { type: 'paragraph', children: [{ type: 'link', label: 'Shop', url: '/sale' }] },
    ]);
  });

  it('reads a line break inside a paragraph', () => {
    expect(parseMarkup('one\ntwo')).toEqual([
      {
        type: 'paragraph',
        children: [{ type: 'text', text: 'one' }, { type: 'break' }, { type: 'text', text: 'two' }],
      },
    ]);
  });

  it('reads nothing from an empty text or from spaces and empty lines', () => {
    expect(parseMarkup('')).toEqual([]);
    expect(parseMarkup('   \n\n \t \r\n')).toEqual([]);
  });

  it('puts the same kind of marker inside itself as nested parts', () => {
    expect(parseMarkup('**a **b** c**')).toEqual([
      {
        type: 'paragraph',
        children: [
          {
            type: 'bold',
            children: [
              { type: 'text', text: 'a ' },
              { type: 'bold', children: [{ type: 'text', text: 'b' }] },
              { type: 'text', text: ' c' },
            ],
          },
        ],
      },
    ]);
  });
});

describe('the html of the markup', () => {
  it.each([
    ['a paragraph', 'plain text', '<p>plain text</p>'],
    ['bold', '**bold**', '<p><strong>bold</strong></p>'],
    ['italic', '*italic*', '<p><em>italic</em></p>'],
    ['bold and italic together', '***both***', '<p><strong><em>both</em></strong></p>'],
    [
      'italic inside bold',
      '**bold *italic* bold**',
      '<p><strong>bold <em>italic</em> bold</strong></p>',
    ],
    [
      'bold inside italic',
      '*italic **bold** italic*',
      '<p><em>italic <strong>bold</strong> italic</em></p>',
    ],
    ['a heading', '# Title', '<h2>Title</h2>'],
    ['a heading with bold in it', '# The **big** news', '<h2>The <strong>big</strong> news</h2>'],
    ['a list', '- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
    ['a list item with bold', '- **a** b', '<ul><li><strong>a</strong> b</li></ul>'],
    ['two paragraphs', 'one\n\ntwo', '<p>one</p>\n<p>two</p>'],
    ['many empty lines between paragraphs', 'one\n\n\n\n   \ntwo', '<p>one</p>\n<p>two</p>'],
    ['a line break', 'line one\nline two', '<p>line one<br>line two</p>'],
    ['windows line ends', 'a\r\nb\r\n\r\nc', '<p>a<br>b</p>\n<p>c</p>'],
    ['old mac line ends', 'a\rb', '<p>a<br>b</p>'],
    ['a heading in the middle', 'a\n# H\nb', '<p>a</p>\n<h2>H</h2>\n<p>b</p>'],
    [
      'a list that a paragraph ends',
      '- a\n- b\ntext',
      '<ul><li>a</li><li>b</li></ul>\n<p>text</p>',
    ],
    ['a list that an empty line splits', '- a\n\n- b', '<ul><li>a</li></ul>\n<ul><li>b</li></ul>'],
    ['a paragraph that a list interrupts', 'a\n- b', '<p>a</p>\n<ul><li>b</li></ul>'],
    ['spaces around a line', '   padded   ', '<p>padded</p>'],
  ])('writes %s', (_name, source, expected) => {
    expect(html(source)).toBe(expected);
  });

  it.each([
    ['a hash without a space', '#tag', '<p>#tag</p>'],
    ['two hashes', '## Not a heading', '<p>## Not a heading</p>'],
    ['a hash after a space', ' # Not a heading', '<p># Not a heading</p>'],
    ['a dash without a space', '-x', '<p>-x</p>'],
    ['a star with a space as a bullet', '* item', '<p>* item</p>'],
    ['an empty heading', '# ', ''],
    ['an empty list item', '- ', ''],
    ['a lone dash', '-', '<p>-</p>'],
  ])('keeps %s as the text it is', (_name, source, expected) => {
    expect(html(source)).toBe(expected);
  });

  it.each([
    ['an unclosed bold', '**unclosed', '<p>**unclosed</p>'],
    ['an unclosed italic', '*unclosed', '<p>*unclosed</p>'],
    ['a bold that is never opened', 'closed**', '<p>closed**</p>'],
    ['an italic that is never opened', 'closed*', '<p>closed*</p>'],
    ['markers apart from words', 'a ** b', '<p>a ** b</p>'],
    ['stars as multiplication', '2 * 3 * 4', '<p>2 * 3 * 4</p>'],
    ['four stars', '****', '<p>****</p>'],
    ['a run of many stars', '*********', '<p>*********</p>'],
    ['a bold with nothing in it', '** **', '<p>** **</p>'],
    ['an italic opened and a bold closed', '*a**', '<p>*a**</p>'],
    ['markers that cross', '**a *b** c*', '<p><strong>a *b</strong> c*</p>'],
    ['markers that cross the other way', '*a **b* c**', '<p><em>a **b</em> c**</p>'],
    ['an open bold inside a closed italic', '*a **b* c', '<p><em>a **b</em> c</p>'],
    ['three stars closed by one', '***a*', '<p>**<em>a</em></p>'],
    ['three stars closed by two', '***a**', '<p><strong>*a</strong></p>'],
    ['a bold closed by three stars', '**a***', '<p><strong>a*</strong></p>'],
    ['an italic closed by three stars', '*a***', '<p><em>a</em>**</p>'],
    ['an italic inside a word', 'a*b*c', '<p>a<em>b</em>c</p>'],
  ])('keeps %s as the text it is', (_name, source, expected) => {
    expect(html(source)).toBe(expected);
  });

  it('writes a link to the shop, with the marks of the newsletter when it has an id', () => {
    expect(html('[Shop](/sale)')).toBe(`<p>${anchor('https://shop.example.com/sale', 'Shop')}</p>`);
    expect(html('[Shop](/sale)', MARKED)).toBe(
      `<p>${anchor(`https://shop.example.com/sale?${UTM}`, 'Shop')}</p>`,
    );
  });

  it('escapes the ampersand of a query in the address of a link', () => {
    expect(html('[x](/p?a=1&b=2#top)', MARKED)).toBe(
      `<p>${anchor(`https://shop.example.com/p?a=1&amp;b=2&amp;${UTM}#top`, 'x')}</p>`,
    );
  });

  it('writes an absolute address of the shop the same way', () => {
    expect(html('[x](https://shop.example.com/c/1)', MARKED)).toBe(
      `<p>${anchor(`https://shop.example.com/c/1?${UTM}`, 'x')}</p>`,
    );
  });

  it('writes bold and italic around a link and keeps the label of a link plain', () => {
    expect(html('**[Shop](/a)**')).toBe(
      `<p><strong>${anchor('https://shop.example.com/a', 'Shop')}</strong></p>`,
    );
    expect(html('[**x**](/a)')).toBe(`<p>${anchor('https://shop.example.com/a', '**x**')}</p>`);
    expect(html('[*x*](/a)')).toBe(`<p>${anchor('https://shop.example.com/a', '*x*')}</p>`);
  });

  it('keeps the brackets of a label', () => {
    expect(html('[a [b] c](/x)')).toBe(`<p>${anchor('https://shop.example.com/x', 'a [b] c')}</p>`);
  });

  it('reads two links of one line', () => {
    expect(html('[a](/a) and [b](/b)')).toBe(
      `<p>${anchor('https://shop.example.com/a', 'a')} and ${anchor('https://shop.example.com/b', 'b')}</p>`,
    );
  });

  it('writes the label only for a link that does not lead to the shop', () => {
    expect(html('[x](https://evil.example.org/p)')).toBe('<p>x</p>');
    expect(html('[x](//evil.example.org)')).toBe('<p>x</p>');
    expect(html('[x](javascript:alert)')).toBe('<p>x</p>');
    expect(html('[x](data:text/html;base64,AAAA)')).toBe('<p>x</p>');
    expect(html('[x](JaVaScRiPt:alert)')).toBe('<p>x</p>');
    expect(html('[<b>x</b>](https://evil.example.org)')).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });

  it('writes the label only for every link when the shop has no address', () => {
    expect(html('[x](/sale)', { origin: null })).toBe('<p>x</p>');
  });

  // a site root trusts is a place a link may lead to, as the shop is; its address goes as it is, without
  // the marks of the campaign (the analytics of the shop is not that site's)
  describe('a link to a site root trusts', () => {
    const TRUSTED = { origin: ORIGIN, trusted: ['partner.test'] };

    it('is written as a link', () => {
      expect(html('[x](https://partner.test/p)', TRUSTED)).toBe(
        `<p>${anchor('https://partner.test/p', 'x')}</p>`,
      );
      expect(html('[x](https://www.partner.test/p?a=1#top)', TRUSTED)).toBe(
        `<p>${anchor('https://www.partner.test/p?a=1#top', 'x')}</p>`,
      );
    });

    it('gets no marks of the campaign, while a link to the shop does', () => {
      const options = { ...TRUSTED, campaignId: 7 };

      expect(html('[x](https://partner.test/p)', options)).toBe(
        `<p>${anchor('https://partner.test/p', 'x')}</p>`,
      );
      expect(html('[x](/p)', options)).toBe(
        `<p>${anchor(`https://shop.example.com/p?${UTM}`, 'x')}</p>`,
      );
    });

    it('is written with its address in the plain text', () => {
      expect(text('[x](https://partner.test/p)', { ...TRUSTED, campaignId: 7 })).toBe(
        'x (https://partner.test/p)',
      );
    });

    it('is written as a link without an address of the shop', () => {
      expect(html('[x](https://partner.test/p)', { origin: null, trusted: ['partner.test'] })).toBe(
        `<p>${anchor('https://partner.test/p', 'x')}</p>`,
      );
    });

    it.each([
      ['another site', '[x](https://evil.test/p)'],
      ['a site that starts like a trusted one', '[x](https://partner.test.evil.test/p)'],
      ['a trusted site as a user name', '[x](https://partner.test@evil.test/p)'],
      ['a trusted site with a user name', '[x](https://user@partner.test/p)'],
      ['a path', '[x](//partner.test/p)'],
      ['a javascript address', '[x](javascript:alert)'],
    ])('is not one for %s', (_name, source) => {
      expect(html(source, TRUSTED)).toBe('<p>x</p>');
      expect(text(source, TRUSTED)).toBe('x');
    });

    it('is the label only when no site is trusted', () => {
      expect(html('[x](https://partner.test/p)', { origin: ORIGIN, trusted: [] })).toBe('<p>x</p>');
      expect(html('[x](https://partner.test/p)')).toBe('<p>x</p>');
    });
  });

  it.each([
    ['empty brackets', '[](/a)', '<p>[](/a)</p>'],
    ['a blank label', '[   ](/a)', '<p>[   ](/a)</p>'],
    ['an empty address', '[x]()', '<p>[x]()</p>'],
    ['an address with a space', '[x](/a b)', '<p>[x](/a b)</p>'],
    ['an address with a bracket inside', '[x](/a(b))', '<p>[x](/a(b))</p>'],
    ['no address', '[x]', '<p>[x]</p>'],
    ['no closing bracket', '[x(/a)', '<p>[x(/a)</p>'],
    ['no closing parenthesis', '[x](/a', '<p>[x](/a</p>'],
    ['a space between', '[x] (/a)', '<p>[x] (/a)</p>'],
    [
      'a stray closing bracket in front',
      '] [x](/a)',
      `<p>] ${anchor('https://shop.example.com/a', 'x')}</p>`,
    ],
    [
      'a stray opening bracket in front',
      '[ [x](/a)',
      `<p>[ ${anchor('https://shop.example.com/a', 'x')}</p>`,
    ],
    [
      'an address with an unbalanced call',
      '[x](javascript:alert(1))',
      '<p>[x](javascript:alert(1))</p>',
    ],
  ])('keeps %s as the text it is', (_name, source, expected) => {
    expect(html(source)).toBe(expected);
  });

  it.each([
    ['a script tag', '<script>alert(1)</script>', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
    [
      'an image with a handler',
      '<img src=x onerror=alert(1)>',
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
    ],
    [
      'quotes and an ampersand',
      `Tom & "Jerry" it's`,
      '<p>Tom &amp; &quot;Jerry&quot; it&#39;s</p>',
    ],
    ['an entity', '&amp; &lt;b&gt; &#60;', '<p>&amp;amp; &amp;lt;b&amp;gt; &amp;#60;</p>'],
    ['a tag in a heading', '# <b>x</b>', '<h2>&lt;b&gt;x&lt;/b&gt;</h2>'],
    ['a tag in a list item', '- <i>x</i>', '<ul><li>&lt;i&gt;x&lt;/i&gt;</li></ul>'],
    ['a tag in bold', '**<u>x</u>**', '<p><strong>&lt;u&gt;x&lt;/u&gt;</strong></p>'],
    ['a comment', '<!-- x -->', '<p>&lt;!-- x --&gt;</p>'],
    ['a lone angle bracket', 'a < b > c', '<p>a &lt; b &gt; c</p>'],
  ])('keeps %s as plain text', (_name, source, expected) => {
    expect(html(source)).toBe(expected);
  });

  it.each([
    [
      'letters of other scripts',
      'Grüße **Welt** 😀 日本語',
      '<p>Grüße <strong>Welt</strong> 😀 日本語</p>',
    ],
    ['an emoji next to a marker', '**😀**', '<p><strong>😀</strong></p>'],
    ['zero width signs inside a word', 'a\u200bb\u200dc', '<p>a\u200bb\u200dc</p>'],
    ['a zero width sign as the only content of a bold', '**\u200b**', '<p>**\u200b**</p>'],
    ['a zero width sign after an opening marker', '**\u200bx**', '<p>**\u200bx**</p>'],
    ['control signs', 'a\u0007b\u001bc', '<p>abc</p>'],
    ['a left-to-right override', 'a\u202eb\u2066c', '<p>abc</p>'],
    ['a tab', 'a\tb', '<p>a\tb</p>'],
  ])('copes with %s', (_name, source, expected) => {
    expect(html(source)).toBe(expected);
  });

  it('never writes a tag the markup does not have', () => {
    const hostile = [
      '<script>alert(1)</script>',
      '"><img src=x onerror=alert(1)>',
      '[x](javascript:alert(1))',
      '[<script>](/a)',
      '**<b onclick=1>**',
      '# <iframe src=//evil></iframe>',
      '- <a href="https://evil">x</a>',
    ];
    const allowed = new Set(['p', 'h2', 'ul', 'li', 'strong', 'em', 'a', 'br']);

    for (const source of hostile) {
      const tags = [...html(source).matchAll(/<\/?([a-z0-9]+)/gi)].map((match) => match[1]!);
      expect(tags.filter((tag) => !allowed.has(tag))).toEqual([]);
    }
  });
});

describe('the plain text of the markup', () => {
  it.each([
    ['a paragraph', 'Hello', 'Hello'],
    ['bold and italic without their signs', 'a **b** and *c*', 'a b and c'],
    ['a heading as a plain line', '# Title', 'Title'],
    ['a list with dashes', '- one\n- two', '- one\n- two'],
    ['paragraphs apart by an empty line', 'one\n\ntwo', 'one\n\ntwo'],
    ['a line break', 'one\ntwo', 'one\ntwo'],
    ['the parts in order', '# T\n\ntext **b**\n- x\n- y', 'T\n\ntext b\n\n- x\n- y'],
    ['an unclosed marker as it is', '**open', '**open'],
    ['a tag as it is', '<b>x</b> & y', '<b>x</b> & y'],
    ['nothing', '', ''],
  ])('writes %s', (_name, source, expected) => {
    expect(text(source)).toBe(expected);
  });

  it('writes a link as its label and its address', () => {
    expect(text('[Shop](/sale)')).toBe('Shop (https://shop.example.com/sale)');
    expect(text('[Shop](/sale)', MARKED)).toBe(`Shop (https://shop.example.com/sale?${UTM_PLAIN})`);
    expect(text('see [A](/a) or [B](https://shop.example.com/b)')).toBe(
      'see A (https://shop.example.com/a) or B (https://shop.example.com/b)',
    );
  });

  it('writes the label only for a link that does not lead to the shop', () => {
    expect(text('[x](https://evil.example.org)')).toBe('x');
    expect(text('[x](javascript:alert)')).toBe('x');
  });

  it('writes a link in a heading and in a list item', () => {
    expect(text('# [Go](/a)')).toBe('Go (https://shop.example.com/a)');
    expect(text('- [Go](/a)')).toBe('- Go (https://shop.example.com/a)');
  });
});

describe('the links the markup finds', () => {
  it('lists every address in the order of the text, whatever it leads to', () => {
    const blocks = parseMarkup(
      'a [one](/a) b\n\n# [two](https://evil.example.org)\n- **[three](javascript:x)**\n- [four](//h)',
    );

    expect(linksOfMarkup(blocks)).toEqual([
      '/a',
      'https://evil.example.org',
      'javascript:x',
      '//h',
    ]);
  });

  it('finds none in a text without links', () => {
    expect(linksOfMarkup(parseMarkup('plain **text**'))).toEqual([]);
    expect(linksOfMarkup(parseMarkup('[](/a) and [x]()'))).toEqual([]);
  });

  it('does not take an address that sits inside the label of another link', () => {
    expect(linksOfMarkup(parseMarkup('[a [b](/inner) c](/outer)'))).toEqual(['/outer']);
  });
});

describe('the size and the time of the markup', () => {
  it('takes a text of the longest size and refuses one a sign longer', () => {
    expect(MARKUP_MAX_LENGTH).toBe(5000);
    expect(() => parseMarkup('a'.repeat(MARKUP_MAX_LENGTH))).not.toThrow();
    expect(() => parseMarkup('a'.repeat(MARKUP_MAX_LENGTH + 1))).toThrow(MarkupTooLongError);
  });

  it('counts the characters of the text and not the halves of the signs that need two', () => {
    expect(() => parseMarkup('😀'.repeat(MARKUP_MAX_LENGTH))).not.toThrow();
    expect(() => parseMarkup('😀'.repeat(MARKUP_MAX_LENGTH + 1))).toThrow(MarkupTooLongError);
  });

  it('refuses a huge text without reading it', () => {
    const huge = '*'.repeat(50_000_000);
    const started = Date.now();

    expect(() => parseMarkup(huge)).toThrow(MarkupTooLongError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reads a very long line of one letter', () => {
    const [block] = parseMarkup('a'.repeat(MARKUP_MAX_LENGTH));

    expect(block).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', text: 'a'.repeat(MARKUP_MAX_LENGTH) }],
    });
  });

  // the worst the parser can be given, at the longest size: each must finish at once, in a time that
  // would be a lot longer for a parser that goes back over the line for every marker
  it.each([
    ['openers without a closer', '**a '.repeat(1250)],
    ['single openers', '*a '.repeat(1666)],
    ['alternating markers', '*a**b'.repeat(1000)],
    ['crossing markers', '**a *b '.repeat(714)],
    ['three-star runs', '***a '.repeat(1000)],
    ['opening brackets', '['.repeat(5000)],
    ['closing brackets', ']'.repeat(5000)],
    ['brackets in pairs', '[]'.repeat(2500)],
    ['links without an end', '[a](b '.repeat(833)],
    ['links with an address that has a bracket', '[a](b( '.repeat(714)],
    ['nested brackets and an address', `${'['.repeat(2000)}a${']'.repeat(2000)}(/x)`],
    ['many short links', '[a](/b)'.repeat(714)],
    ['many headings', '# a\n'.repeat(1250)],
    ['many list items', '- a\n'.repeat(1250)],
    ['many empty lines', '\n'.repeat(5000)],
    ['tags', '<a>'.repeat(1666)],
  ])('finishes at once for %s', (_name, source) => {
    expect(source.length).toBeLessThanOrEqual(MARKUP_MAX_LENGTH);
    const started = Date.now();

    const blocks = parseMarkup(source);
    renderMarkupHtml(blocks, MARKED);
    renderMarkupText(blocks, MARKED);

    expect(Date.now() - started).toBeLessThan(500);
  });

  it('does not nest the parts of a text deeper than a mail needs', () => {
    const output = html(`${'**a '.repeat(20)}b${'**c'.repeat(MARKUP_MAX_NESTING)}`);

    expect(output.match(/<strong>/g)).toHaveLength(MARKUP_MAX_NESTING);
    expect(output.match(/<\/strong>/g)).toHaveLength(MARKUP_MAX_NESTING);
  });
});
