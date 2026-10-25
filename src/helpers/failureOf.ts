// what a log line tells of a failure of a background step: its kind and code, never its message,
// which may quote the address of the database or of redis (a connection error does). An error of
// our own gives its reason or its errorCode
export function failureOf(err: unknown): { type: string | undefined; code: unknown } {
  const e = err as {
    type?: unknown;
    name?: unknown;
    code?: unknown;
    errorCode?: unknown;
    details?: unknown;
  } | null;
  const reason = (e?.details as { reason?: unknown } | undefined)?.reason;

  return {
    type: typeof e?.type === 'string' ? e.type : typeof e?.name === 'string' ? e.name : undefined,
    code: reason ?? e?.errorCode ?? e?.code,
  };
}
