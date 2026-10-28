// a small in-memory stand-in for the database side of a prisma query: it applies a where
// object and an orderBy list to plain rows, the way postgres would. Only the parts our
// list helpers build are supported; anything else throws, so a test never passes by accident.
// A one-to-one relation is a nested object of the row: { delivery: { is: {...} } } and
// { delivery: { isNot: null } } filter by it, { delivery: { method: 'asc' } } orders by it

type Row = Record<string, unknown>;
type Plain = number | string | null;

const COMPARE_OPS = new Set(['gt', 'gte', 'lt', 'lte']);

// dates, decimals and numbers become values that compare with < and ===
function plain(value: unknown): Plain {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (
    typeof value === 'object' &&
    typeof (value as { toNumber?: unknown }).toNumber === 'function'
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }

  throw new Error(`unsupported value in a filter: ${String(value)}`);
}

// prisma refuses null, an invalid date and NaN as an operand of gt, lt and the rest
function operand(op: string, value: unknown): number | string {
  if (value === null || value === undefined) {
    throw new Error(`invalid filter: argument ${op} must not be null`);
  }
  if (value instanceof Date && Number.isNaN(value.getTime())) {
    throw new Error(`invalid filter: argument ${op} is an invalid date`);
  }
  if (typeof value === 'number' && Number.isNaN(value)) {
    throw new Error(`invalid filter: argument ${op} is NaN`);
  }

  return plain(value) as number | string;
}

function compare(op: string, left: Plain, right: number | string): boolean {
  // sql: a comparison with null is never true
  if (left === null) return false;
  if (op === 'gt') return left > right;
  if (op === 'gte') return left >= right;
  if (op === 'lt') return left < right;
  return left <= right;
}

function isFilterObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    typeof (value as { toNumber?: unknown }).toNumber !== 'function'
  );
}

function matchesField(rowValue: unknown, condition: unknown): boolean {
  const left = plain(rowValue);

  // { field: null } is IS NULL, { field: value } is equality
  if (!isFilterObject(condition)) {
    if (condition === null) return left === null;
    return left !== null && left === operand('equals', condition);
  }

  return Object.entries(condition).every(([op, value]) => {
    if (COMPARE_OPS.has(op)) return compare(op, left, operand(op, value));
    if (op === 'equals') return matchesField(rowValue, value);
    if (op === 'not') {
      if (value === null) return left !== null;
      return left !== null && left !== operand('not', value);
    }
    if (op === 'in') return left !== null && (value as unknown[]).map(plain).includes(left);

    throw new Error(`unsupported filter operator: ${op}`);
  });
}

export function matchesWhere(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;

  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') {
      const parts = Array.isArray(condition) ? condition : [condition];
      return parts.every((part) => matchesWhere(row, part as Record<string, unknown>));
    }
    if (key === 'OR') {
      return (condition as Record<string, unknown>[]).some((part) => matchesWhere(row, part));
    }
    if (key === 'NOT') return !matchesWhere(row, condition as Record<string, unknown>);

    // a relation of one row: is (it is there and matches), isNot (it is not there, or does not match)
    if (isFilterObject(condition) && ('is' in condition || 'isNot' in condition)) {
      const related = row[key] as Row | null | undefined;
      const missing = related === null || related === undefined;
      return Object.entries(condition).every(([op, inner]) => {
        if (op === 'is') {
          return inner === null ? missing : !missing && matchesWhere(related, inner as Row);
        }
        if (op === 'isNot') {
          return inner === null ? !missing : missing || !matchesWhere(related, inner as Row);
        }
        throw new Error(`unsupported relation filter: ${op}`);
      });
    }

    return matchesField(row[key], condition);
  });
}

type Direction = 'asc' | 'desc';
// a field and its direction, or a field of a relation of one row and its direction
export type OrderItem = Record<string, Direction | Record<string, Direction>>;

// the field an order item sorts by, with its direction
function orderOf(row: Row, item: OrderItem): { value: Plain; dir: Direction } {
  const [field, spec] = Object.entries(item)[0]!;
  if (typeof spec === 'string') return { value: plain(row[field]), dir: spec };

  const [inner, dir] = Object.entries(spec)[0]!;
  const related = row[field] as Row | null | undefined;
  return { value: related ? plain(related[inner]) : null, dir };
}

// postgres default: ascending puts nulls last, descending puts them first
export function sortRows<T extends Row>(rows: T[], orderBy: OrderItem[]): T[] {
  return [...rows].sort((a, b) => {
    for (const item of orderBy) {
      const { value: left, dir } = orderOf(a, item);
      const { value: right } = orderOf(b, item);

      if (left === right) continue;
      if (left === null) return dir === 'asc' ? 1 : -1;
      if (right === null) return dir === 'asc' ? -1 : 1;

      const order = left < right ? -1 : 1;
      return dir === 'asc' ? order : -order;
    }

    return 0;
  });
}

// keyset pagination the way a list service runs it: one page per cursor, a page has one
// row more than the limit when another page follows. Returns the ids in the order they came
export function walkPages<T extends Row & { id: number }>(args: {
  rows: T[];
  where?: Record<string, unknown>;
  orderBy: OrderItem[];
  limit: number;
  cursorWhere: (cursor: string | undefined) => Record<string, unknown> | undefined;
  nextCursor: (last: T) => string;
}): number[] {
  const seen: number[] = [];
  let cursor: string | undefined;

  // more pages than rows means the cursor does not move forward
  for (let page = 0; page <= args.rows.length + 1; page += 1) {
    const cursorWhere = args.cursorWhere(cursor);
    const where = cursorWhere ? { AND: [args.where ?? {}, cursorWhere] } : args.where;

    const matching = sortRows(
      args.rows.filter((row) => matchesWhere(row, where)),
      args.orderBy,
    );
    const pageRows = matching.slice(0, args.limit);

    seen.push(...pageRows.map((row) => row.id));
    if (matching.length <= args.limit) return seen;

    cursor = args.nextCursor(pageRows[pageRows.length - 1]!);
  }

  throw new Error('pagination did not finish: the cursor keeps returning the same rows');
}
