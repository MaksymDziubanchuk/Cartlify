// run code that must throw and return what it threw, so a test can check class and code
export function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }

  throw new Error('expected the code to throw, it returned normally');
}

// the same for code that must reject
export async function rejectedBy(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }

  throw new Error('expected the promise to reject, it resolved');
}

// the http status of an app error, for checks like "a client error, 400 or 401"
export function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number } | null)?.statusCode;
}
