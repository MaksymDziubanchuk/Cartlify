import { AppError, isAppError } from '@utils/errors.js';

// a change of many products is all or nothing: a refusal names in details.products every product
// refused the same way, each with the details PATCH of one product gives; the first product
// refused names the code, a product refused another way shows once the request is fixed

const productOf = (productId: number, err: AppError) => ({
  productId,
  ...(err.details && typeof err.details === 'object' && !Array.isArray(err.details)
    ? err.details
    : {}),
});

const refusalOf = (err: AppError, products: Array<Record<string, unknown>>) =>
  new AppError({
    statusCode: err.statusCode,
    errorCode: err.errorCode,
    message: err.message,
    details: { products },
    cause: err,
  });

// the refusal of one product, with its status and its code
export const refusalOfProduct = (productId: number, err: AppError): AppError =>
  refusalOf(err, [productOf(productId, err)]);

// a check of each item in its order, every item checked: the results in the order of the items,
// or the refusal of the code of the first item refused with every item refused with it. An error
// that is no refusal of the app goes through as it is
export async function refuseTogether<T, R>(
  items: readonly T[],
  productIdOf: (item: T) => number,
  check: (item: T, index: number) => R | Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const refused: Array<{ productId: number; err: AppError }> = [];

  for (const [index, item] of items.entries()) {
    try {
      results.push(await check(item, index));
    } catch (err) {
      if (!isAppError(err)) throw err;
      refused.push({ productId: productIdOf(item), err });
    }
  }

  const first = refused[0];
  if (first) {
    throw refusalOf(
      first.err,
      refused
        .filter(({ err }) => err.errorCode === first.err.errorCode)
        .map(({ productId, err }) => productOf(productId, err)),
    );
  }

  return results;
}

// the products given more than once, each once, in the order they first come back
export function repeatedProductIds(ids: readonly number[]): number[] {
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}

// the products of the catalog that take an article number another product of the catalog holds
// after the change, or that another product of the request takes too; the numbers are lowered
// the way the unique index of db/06 lowers them. Null takes a number away and clashes with none
export function clashingSkus(
  changing: ReadonlyArray<{ productId: number; lowered: string | null }>,
  held: ReadonlySet<string>,
): number[] {
  const taking = new Map<string, number>();
  for (const { lowered } of changing) {
    if (lowered !== null) taking.set(lowered, (taking.get(lowered) ?? 0) + 1);
  }

  return changing
    .filter(({ lowered }) => lowered !== null && (held.has(lowered) || taking.get(lowered)! > 1))
    .map(({ productId }) => productId);
}
