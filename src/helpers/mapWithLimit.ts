// Runs `work` on every item with at most `limit` calls at once (one at a time for a limit below one)
// and gives the results in the order of the items. For calls to a provider that may refuse a burst.
// When a call fails, no new call starts; the ones running are let finish, then the first failure is
// thrown, so nothing is left running behind the caller
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;

  const worker = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const index = next;
      next += 1;

      try {
        results[index] = await work(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };

  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));

  if (failure !== null) throw (failure as { error: unknown }).error;

  return results;
}
