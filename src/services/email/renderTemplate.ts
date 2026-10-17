import { readFileSync } from 'node:fs';
import path from 'node:path';

import { escapeHtml } from '@helpers/escapeHtml.js';

// the mail templates live as plain files next to their builders, read the way the logo is read
const TEMPLATES_DIR = path.join(process.cwd(), 'src', 'services', 'email', 'templates');

const cache = new Map<string, string>();

// a value is a text, or a list whose items fill a repeated part of the template
export type TemplateValue = string | Record<string, string>[];
export type TemplateValues = Record<string, TemplateValue>;

// a section with its part, or a single mark
const MARK = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}|\{\{(\w+)\}\}/g;

// {{name}} becomes the value, html-escaped when html is true. {{#name}}...{{/name}} stays only
// when the value is not empty and repeats for each item of a list, the marks inside it take the
// fields of the item; {{^name}}...{{/name}} stays only when the value is empty. Sections of the
// same name do not nest. The marks are filled in one pass, so a value is never read as a mark.
// A mark without a value or a broken mark is a mistake in the template, it never reaches a mail
export function renderSource(
  source: string,
  values: TemplateValues,
  opts: { html: boolean; name?: string },
): string {
  return render(source, values, opts).trim();
}

function render(
  source: string,
  values: TemplateValues,
  opts: { html: boolean; name?: string },
): string {
  const where = opts.name ? ` in ${opts.name}` : '';

  if (source.replace(MARK, '').includes('{{'))
    throw new Error(`EMAIL_TEMPLATE_MARK_BROKEN${where}`);

  const valueOf = (key: string): TemplateValue => {
    const value = values[key];
    if (value === undefined) throw new Error(`EMAIL_TEMPLATE_VALUE_MISSING: ${key}${where}`);
    return value;
  };

  return source.replace(
    MARK,
    (_m, kind: string | undefined, key: string | undefined, part: string, mark: string): string => {
      if (!kind || !key) {
        const value = valueOf(mark);
        if (typeof value !== 'string')
          throw new Error(`EMAIL_TEMPLATE_LIST_AS_TEXT: ${mark}${where}`);
        return opts.html ? escapeHtml(value) : value;
      }

      const value = valueOf(key);
      const filled = typeof value === 'string' ? value !== '' : value.length > 0;

      if (kind === '^') return filled ? '' : render(part, values, opts);
      if (!filled) return '';

      return typeof value === 'string'
        ? render(part, values, opts)
        : value.map((item): string => render(part, { ...values, ...item }, opts)).join('');
    },
  );
}

// a template file of src/services/email/templates: .html values are escaped, .txt ones are not
export function renderTemplate(file: string, values: TemplateValues): string {
  let source = cache.get(file);

  if (source === undefined) {
    // the line endings of the checkout do not reach the mail
    source = readFileSync(path.join(TEMPLATES_DIR, file), 'utf8').replace(/\r\n/g, '\n');
    cache.set(file, source);
  }

  return renderSource(source, values, { html: file.endsWith('.html'), name: file });
}
