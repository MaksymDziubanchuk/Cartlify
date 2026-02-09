export function toNumberSafe(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;

  const s =
    typeof v === 'string'
      ? v
      : typeof v === 'object' && v !== null && 'value' in v && typeof (v as any).value === 'string'
        ? (v as any).value
        : undefined;

  if (!s) return undefined;

  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : undefined;
}

export function toStringSafe(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'value' in v && typeof (v as any).value === 'string') {
    return (v as any).value;
  }
  return undefined;
}

export function decimalToNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;

  if (typeof v === 'object' && v !== null) {
    if (typeof (v as any).toNumber === 'function') return (v as any).toNumber();
    if (typeof (v as any).toString === 'function') {
      const n = Number((v as any).toString());
      if (Number.isFinite(n)) return n;
    }
  }

  const n = Number(v as any);
  return Number.isFinite(n) ? n : 0;
}
