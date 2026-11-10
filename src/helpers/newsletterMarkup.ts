import { escapeHtml } from '@helpers/escapeHtml.js';
import { markedLink, shopLinkOf, trustedLinkOf } from '@helpers/shopLink.js';

// The simple markup of the text blocks of a newsletter. An admin writes
//   **bold**, *italic*, [label](address),
//   a line that starts with "# " (a heading), lines that start with "- " (a list),
//   an empty line (the end of a paragraph); a new line inside a paragraph is a line break.
// Nothing else is markup: a "<" is a "<", an entity is the text it spells, an unclosed marker stays
// as it was typed. The text is read into a small tree (parseMarkup), and the tree is written as a
// safe html (renderMarkupHtml: everything is escaped, the only tags are the ones below) and as a
// plain text (renderMarkupText). Pure functions, no dependency.
//
// What the parser promises, for the text of a hostile admin or a hostile script:
// - it reads the text in one pass, the time is linear in its size; a text longer than
//   MARKUP_MAX_LENGTH is refused before it is read
// - the parts are nested at most MARKUP_MAX_NESTING deep, so the writer never goes deep
// - a link is [label](address) with a label of plain text (a marker inside it stays a sign) and an
//   address of no space and no bracket; whether the address is allowed is not for the parser to say
//   (linksOfMarkup lists them), but the writers never write a link that does not lead to the shop or
//   to a site root trusts (MarkupRenderOptions.trusted)

// the longest text a block holds, in characters (not in the halves of the signs that need two)
export const MARKUP_MAX_LENGTH = 5000;

// how many parts of bold and italic may be open at once
export const MARKUP_MAX_NESTING = 8;

export class MarkupTooLongError extends Error {
  constructor() {
    super('MARKUP_TOO_LONG');
    this.name = 'MarkupTooLongError';
  }
}

export type MarkupInline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: MarkupInline[] }
  | { type: 'italic'; children: MarkupInline[] }
  | { type: 'link'; label: string; url: string }
  | { type: 'break' };

export type MarkupBlock =
  | { type: 'paragraph'; children: MarkupInline[] }
  | { type: 'heading'; children: MarkupInline[] }
  | { type: 'list'; items: MarkupInline[][] };

export type MarkupRenderOptions = {
  // the origin of the shop (WEB_ORIGIN): a link that does not lead there, or to a site of `trusted`,
  // is written as its label
  origin: string | null;
  // the domains of the sites root trusts (subdomains too): a link to one is written as it is, with
  // no marks of the campaign. None unless given
  trusted?: readonly string[];
  // the newsletter, for the marks that tell the analytics of the shop a visit came from it
  campaignId?: number;
};

// ---- reading ----

// signs that mean nothing in a mail and can only deceive: the control signs but the tab and the new
// line, and the marks that turn the direction of the text (they make a label read as another address)
const STRIPPED = /[^\P{Cc}\t\n]|[\u202a-\u202e\u2066-\u2069]/gu;

// the number of characters, a sign of two halves counted once
const characterCount = (text: string): number => [...text].length;

// a space for the rule of a marker (it opens a part only when a sign that is not a space follows
// it and closes one only when a sign that is not a space precedes it); the zero width signs are
// spaces here, a part made of them is empty
const isSpace = (sign: string): boolean => /[\s\u200b\u2060\ufeff]/.test(sign);

type Frame = { marker: '**' | '*' | ''; children: MarkupInline[] };

// merges the texts that follow each other, so the tree has the fewest nodes
function mergeTexts(nodes: MarkupInline[]): MarkupInline[] {
  const merged: MarkupInline[] = [];

  for (const node of nodes) {
    const last = merged.at(-1);
    if (node.type === 'text' && last?.type === 'text') last.text += node.text;
    else merged.push(node);
  }

  return merged;
}

function finish(node: MarkupInline): MarkupInline {
  if (node.type === 'bold' || node.type === 'italic') {
    return { type: node.type, children: mergeTexts(node.children).map(finish) };
  }

  return node;
}

// What a line of text is made of. One pass over the line with a stack of the parts that are open
// (the counts of the open parts of each kind tell at once whether a marker closes one). The helper
// tables of the links are made once for the line, each in one pass, so a link costs a lookup
function parseInline(line: string): MarkupInline[] {
  const length = line.length;
  const root: Frame = { marker: '', children: [] };
  const stack: Frame[] = [root];
  const open = { '**': 0, '*': 0 };
  let pending = '';

  const top = () => stack[stack.length - 1]!;
  const flush = () => {
    if (pending) {
      top().children.push({ type: 'text', text: pending });
      pending = '';
    }
  };

  // the helper tables of the links, made when the line has a bracket
  let closeOf: Int32Array | null = null;
  let nextParen: Int32Array | null = null;
  let nextBad: Int32Array | null = null;

  const prepareLinks = () => {
    closeOf = new Int32Array(length).fill(-1);
    nextParen = new Int32Array(length + 1);
    nextBad = new Int32Array(length + 1);
    const opened: number[] = [];

    for (let i = 0; i < length; i += 1) {
      if (line[i] === '[') opened.push(i);
      else if (line[i] === ']' && opened.length > 0) closeOf[opened.pop()!] = i;
    }

    nextParen[length] = length;
    nextBad[length] = length;
    for (let i = length - 1; i >= 0; i -= 1) {
      nextParen[i] = line[i] === ')' ? i : nextParen[i + 1]!;
      nextBad[i] = line[i] === '(' || isSpace(line[i]!) ? i : nextBad[i + 1]!;
    }
  };

  // a link that starts at the bracket i: the label up to its bracket, then an address in
  // parentheses of no space and no bracket
  const linkAt = (i: number): { node: MarkupInline; end: number } | null => {
    if (closeOf === null) prepareLinks();

    const labelEnd = closeOf![i]!;
    if (labelEnd < 0 || labelEnd === i + 1 || line[labelEnd + 1] !== '(') return null;

    const urlStart = labelEnd + 2;
    const urlEnd = nextParen![urlStart]!;
    if (urlEnd >= length || urlEnd === urlStart || nextBad![urlStart]! < urlEnd) return null;

    const label = line.slice(i + 1, labelEnd);
    if (label.trim() === '') return null;

    return {
      node: { type: 'link', label, url: line.slice(urlStart, urlEnd) },
      end: urlEnd + 1,
    };
  };

  // takes the open part of a marker off the stack. The parts opened after it, which nothing closed,
  // are signs and text after all: they give their marker back to the text and their content to the
  // part that holds them
  const close = (marker: '**' | '*') => {
    while (top().marker !== marker) dissolve();

    // a part is never empty: a marker opens only before a sign that is not a space, and that sign
    // (or a link) is the first thing in it
    const frame = stack.pop()!;
    open[marker] -= 1;

    top().children.push({
      type: marker === '**' ? 'bold' : 'italic',
      children: frame.children,
    });
  };

  const dissolve = () => {
    // the root is never dissolved, so the frame has a marker
    const frame = stack.pop()!;
    open[frame.marker as '**' | '*'] -= 1;

    const parent = top();
    parent.children.push({ type: 'text', text: frame.marker }, ...frame.children);
  };

  const push = (marker: '**' | '*') => {
    // a part inside too many others is not worth its tag: the sign stays a sign
    if (stack.length > MARKUP_MAX_NESTING) {
      pending += marker;
      return;
    }

    flush();
    stack.push({ marker, children: [] });
    open[marker] += 1;
  };

  let i = 0;
  while (i < length) {
    const sign = line[i]!;

    if (sign === '[') {
      const link = linkAt(i);
      if (link) {
        flush();
        top().children.push(link.node);
        i = link.end;
        continue;
      }
    }

    if (sign !== '*') {
      pending += sign;
      i += 1;
      continue;
    }

    let end = i;
    while (end < length && line[end] === '*') end += 1;
    const run = end - i;

    // a run of more than three stars is no marker
    if (run > 3) {
      pending += line.slice(i, end);
      i = end;
      continue;
    }

    const canOpen = end < length && !isSpace(line[end]!);
    const canClose = i > 0 && !isSpace(line[i - 1]!);
    const closes = (marker: '**' | '*') => open[marker] > 0;
    // the parts a run of stars stands for, in the order they are closed or opened: three stars
    // close an italic and then the bold around it, and open a bold and then the italic in it
    const markers: ('**' | '*')[] = run === 1 ? ['*'] : run === 2 ? ['**'] : [];
    const opening: ('**' | '*')[] = run === 3 ? ['**', '*'] : markers;
    const closing: ('**' | '*')[] = run === 3 ? ['*', '**'] : markers;

    if (canClose && closing.some(closes)) {
      for (const marker of closing) {
        if (closes(marker)) {
          flush();
          close(marker);
        } else {
          pending += marker;
        }
      }
    } else if (canOpen) {
      for (const marker of opening) push(marker);
    } else {
      pending += line.slice(i, end);
    }

    i = end;
  }

  flush();
  while (stack.length > 1) dissolve();

  return mergeTexts(root.children).map(finish);
}

// a line that is not blank for the rules of the blocks
const isBlank = (line: string): boolean => line.trim() === '';

// Reads the text of a block into paragraphs, headings and lists. A text longer than
// MARKUP_MAX_LENGTH characters is refused with MarkupTooLongError, before anything is read
export function parseMarkup(source: string): MarkupBlock[] {
  // a text of more than twice the longest size has too many characters even when each is a pair
  if (source.length > MARKUP_MAX_LENGTH * 2 || characterCount(source) > MARKUP_MAX_LENGTH) {
    throw new MarkupTooLongError();
  }

  const lines = source.replace(/\r\n?/g, '\n').replace(STRIPPED, '').split('\n');
  const blocks: MarkupBlock[] = [];
  let paragraph: MarkupInline[] | null = null;
  let list: MarkupInline[][] | null = null;

  const endParagraph = () => {
    if (paragraph) blocks.push({ type: 'paragraph', children: mergeTexts(paragraph) });
    paragraph = null;
  };
  const endList = () => {
    if (list) blocks.push({ type: 'list', items: list });
    list = null;
  };

  for (const line of lines) {
    if (line.startsWith('# ')) {
      endParagraph();
      endList();
      const content = line.slice(2).trim();
      if (content) blocks.push({ type: 'heading', children: parseInline(content) });
    } else if (line.startsWith('- ')) {
      endParagraph();
      const content = line.slice(2).trim();
      if (content) {
        list ??= [];
        list.push(parseInline(content));
      } else {
        endList();
      }
    } else if (isBlank(line)) {
      endParagraph();
      endList();
    } else {
      endList();
      const inline = parseInline(line.trim());
      if (paragraph) paragraph.push({ type: 'break' }, ...inline);
      else paragraph = inline;
    }
  }

  endParagraph();
  endList();

  return blocks;
}

// ---- the links ----

function linksOfInline(nodes: MarkupInline[], found: string[]): void {
  for (const node of nodes) {
    if (node.type === 'link') found.push(node.url);
    else if (node.type === 'bold' || node.type === 'italic') linksOfInline(node.children, found);
  }
}

// every address of a link in the text, in the order they stand, whatever they lead to: the caller
// refuses the ones that are neither of the shop nor of a site root trusts (isLinkAllowed)
export function linksOfMarkup(blocks: MarkupBlock[]): string[] {
  const found: string[] = [];

  for (const block of blocks) {
    if (block.type === 'list') for (const item of block.items) linksOfInline(item, found);
    else linksOfInline(block.children, found);
  }

  return found;
}

// the address a link is written with, or null for a link that does not lead to the shop or to a site
// root trusts. The marks of the campaign go on a link to the shop only
function hrefOf(url: string, options: MarkupRenderOptions): string | null {
  const href = shopLinkOf(url, options.origin);
  if (href === null) return trustedLinkOf(url, options.trusted ?? []);

  return options.campaignId === undefined ? href : markedLink(href, options.campaignId);
}

// ---- writing ----

function inlineHtml(nodes: MarkupInline[], options: MarkupRenderOptions): string {
  let out = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += escapeHtml(node.text);
        break;
      case 'bold':
        out += `<strong>${inlineHtml(node.children, options)}</strong>`;
        break;
      case 'italic':
        out += `<em>${inlineHtml(node.children, options)}</em>`;
        break;
      case 'break':
        out += '<br>';
        break;
      case 'link': {
        const href = hrefOf(node.url, options);
        out +=
          href === null
            ? escapeHtml(node.label)
            : `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(node.label)}</a>`;
        break;
      }
    }
  }

  return out;
}

// The html of the text: paragraphs (p), headings (h2), lists (ul, li), bold (strong), italic (em),
// links (a with rel="noopener noreferrer") and line breaks (br), and no other tag. The layout of a
// mail (colors, sizes, spacing) is for the template to give these tags
export function renderMarkupHtml(blocks: MarkupBlock[], options: MarkupRenderOptions): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'paragraph':
          return `<p>${inlineHtml(block.children, options)}</p>`;
        case 'heading':
          return `<h2>${inlineHtml(block.children, options)}</h2>`;
        case 'list':
          return `<ul>${block.items.map((item) => `<li>${inlineHtml(item, options)}</li>`).join('')}</ul>`;
      }
    })
    .join('\n');
}

function inlineText(nodes: MarkupInline[], options: MarkupRenderOptions): string {
  let out = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.text;
        break;
      case 'bold':
      case 'italic':
        out += inlineText(node.children, options);
        break;
      case 'break':
        out += '\n';
        break;
      case 'link': {
        const href = hrefOf(node.url, options);
        out += href === null ? node.label : `${node.label} (${href})`;
        break;
      }
    }
  }

  return out;
}

// The plain text of the text: a heading is a line, a list is lines that start with "- ", a link is
// its label and its address in parentheses, and the parts are apart by an empty line
export function renderMarkupText(blocks: MarkupBlock[], options: MarkupRenderOptions): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'paragraph':
        case 'heading':
          return inlineText(block.children, options);
        case 'list':
          return block.items.map((item) => `- ${inlineText(item, options)}`).join('\n');
      }
    })
    .join('\n\n');
}
