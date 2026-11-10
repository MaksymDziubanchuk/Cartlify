import { Prisma } from '@prisma/client';

import { BadRequestError, ForbiddenError } from '@utils/errors.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import {
  cursorDate,
  cursorNumber,
  cursorString,
  decodeCursor,
  encodeCursor,
} from '@helpers/codeCursor.js';
import { assertLimit } from '@helpers/assertLimit.js';
import { isDbYear } from '@helpers/dbDate.js';
import {
  characteristicFilterSql,
  parseCharacteristicFilter,
  type CharacteristicFilterEntry,
} from '@helpers/characteristicFilter.js';

import type { ProductsSortField, SortOrder, ReadProductsDto } from 'types/dto/products.dto.js';

import { productViewOf, type ProductView } from './productMapper.helper.js';

// A row of the catalog list is a product or a variant.
// - A PRODUCT row (mode 'product'): the query asks nothing about the variants (a category, a
//   search, the rating, the news, the popularity, the sales): one row per product, with its main
//   variant, the lowest and the highest price of its variants, and the free units of them all.
// - A VARIANT row (mode 'variant'): the query asks something of a variant (a price in the sort or
//   in the filter, the sale, the stock of a variant, the shipping data): one row per variant that
//   fits, with that variant.
// The variants a list holds are the ones a buyer sees (alive, with a picture); an admin lists the
// variants that are alive, or every variant of the products that were taken out of the catalog.
// The rows of variants are GROUPS: the variants of one product that have the same value of every
// MAIN characteristic (a colour) are one row, and only the variants that fit the query take part.
// The row has the lowest and the highest price of the group, the free units of its variants and the
// first of them by its place. An admin who sends group=false gets every variant on a row of its own.
export type ListMode = 'product' | 'variant';

// the sorts of a buyer; saleEndsAt and discount give the variants on sale first, the rest by
// popularity; sales counts the units sold in a period
export const BUYER_SORTS: ProductsSortField[] = [
  'createdAt',
  'price',
  'popularity',
  'avgRating',
  'name',
  'saleEndsAt',
  'discount',
  'sales',
  'relevance',
];

// the sorts that are about a variant: they make the rows variants
const VARIANT_SORTS = new Set<ProductsSortField>([
  'price',
  'salePrice',
  'discount',
  'saleEndsAt',
  'stock',
  'totalStock',
  'reservedStock',
  'expiredStock',
]);

// how close a word of the search is to a word of a name for the product to be found: a typo or
// two in a word of a usual length (pg_trgm, word_similarity)
const SEARCH_SIMILARITY = 0.45;

// ---- the pieces of sql, by the alias of the variant (v) and of the product (p) ----

// the price a variant sells at now (db/05): the sale price while the sale lasts. It depends on the
// time, so no index holds it and Prisma cannot order or filter by it: every list goes through one
// raw query of ids (buildProductIdsQuery), Prisma reads the rows of the page
const currentPriceSql = (a: string) =>
  Prisma.raw(`cartlify.product_current_price(${a}."price", ${a}."salePrice", ${a}."saleEndsAt")`);

// a sale that is on: a sale price while the end is ahead, in utc as prisma keeps dates (db/05)
const saleOnSql = (a: string) =>
  Prisma.raw(`(${a}."salePrice" IS NOT NULL AND ${a}."saleEndsAt" > (now() AT TIME ZONE 'UTC'))`);

// the part of the price a sale takes off, from 0 to 1 (a variant on sale has a price above the sale
// price, so the price is never 0 there)
const discountSql = (a: string) =>
  Prisma.raw(`round((${a}."price" - ${a}."salePrice") / NULLIF(${a}."price", 0), 6)::float8`);

// the free units of a variant: the stock less the reserve and the units of batches that are over
// (not sold), never below 0. The list shows the same number, and the alerts of the stock count it
export const freeStockSql = (a: string) =>
  Prisma.raw(
    `GREATEST(${a}."stock" - ${a}."reservedStock" - cartlify.variant_expired_units(${a}.id), 0)`,
  );

export const FREE_STOCK_SQL = freeStockSql('v');

// a variant a buyer sees: alive, with at least one picture
export const visibleSql = (a: string) =>
  Prisma.raw(
    `(${a}."deletedAt" IS NULL AND EXISTS ` +
      `(SELECT 1 FROM "variant_images" ${a}img WHERE ${a}img."variantId" = ${a}."id"))`,
  );

// the days the sort by sales counts when no period is asked for, up to the end of today (UTC)
const SALES_DEFAULT_DAYS = 30;

// the period of the sort by sales, [from, to): what is asked for, else the last days up to the end
// of today; a period that is no period is a bad request
function salesPeriodOf(from: Date | undefined, to: Date | undefined) {
  const broken = (date: Date | undefined) =>
    date !== undefined && (Number.isNaN(date.getTime()) || !isDbYear(date));
  if (broken(from) || broken(to)) throw new BadRequestError('SALES_PERIOD_INVALID');

  const endOfToday = new Date();
  endOfToday.setUTCHours(24, 0, 0, 0);
  const end = to ?? endOfToday;
  const start = from ?? new Date(end.getTime() - SALES_DEFAULT_DAYS * 86_400_000);
  if (start.getTime() >= end.getTime()) throw new BadRequestError('SALES_PERIOD_INVALID');

  return { salesFrom: start, salesTo: end };
}

// a moment as the database reads a time without a zone (UTC)
const utcStamp = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');

// an override of the popularity that is on: the database takes it while its end is ahead, an
// override without an end or past it does nothing (recalc_product_popularity, db/05). The end is
// checked for null first, so the condition is never null and NOT of it keeps such a product
const OVERRIDE_ON_SQL = Prisma.raw(
  `(p."popularityOverride" IS NOT NULL AND p."popularityOverrideUntil" IS NOT NULL ` +
    `AND p."popularityOverrideUntil" > (now() AT TIME ZONE 'UTC'))`,
);

export type ProductListQuery = {
  view: ProductView;
  mode: ListMode;
  limit: number;
  sort: ProductsSortField;
  order: SortOrder;
  search?: string | undefined;
  categoryIds?: number[] | undefined;
  // the categories with their whole branch (the default), or only the products of each itself
  branch: boolean;
  // only these products (no route takes it: the newsletters read a block of products by hand)
  productIds?: number[] | undefined;
  // the price of a variant: what a buyer pays now, the usual price for an admin
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  // every role: true lists only deleted products, false only the products that are not deleted
  deleted: boolean;
  // some free units (a product row: some variant of it has them)
  inStock?: boolean | undefined;
  // an admin, a flag: at most this many free units of a variant
  maxStock?: number | undefined;
  // an admin, a flag: the variants that lack the weight or the sizes
  withoutShippingData?: boolean | undefined;
  // an admin, the flags that find the gaps of the catalog. By a property of a variant (the rows are
  // variants): a characteristic its category requires is missing, no weight, one of the three sizes
  // missing, no barcode, no picture bound
  missingRequired?: boolean | undefined;
  withoutWeight?: boolean | undefined;
  withoutDimensions?: boolean | undefined;
  withoutBarcode?: boolean | undefined;
  withoutImages?: boolean | undefined;
  // by a property of a product (the rows stay products): true the products a buyer does not see,
  // false the ones he sees; the products that have a variant taken out of sale
  hiddenFromBuyers?: boolean | undefined;
  hasDeletedVariants?: boolean | undefined;
  // an admin: the products of a manufacturer, of a person responsible in the EU, and the products
  // that hold a document of the directory
  manufacturerId?: number | undefined;
  euResponsibleId?: number | undefined;
  documentId?: number | undefined;
  // the sort by sales counts the orders paid in [salesFrom, salesTo)
  salesFrom?: Date | undefined;
  salesTo?: Date | undefined;
  // an admin: true lists only the variants with a sale that is on, false only the products or
  // variants without one, undefined does not filter; a buyer: undefined, the sale does not filter
  onSale?: boolean | undefined;
  popularityOverridden?: boolean | undefined;
  // the entries of the filter by characteristics (`f`); a filter makes the rows variants
  characteristics?: CharacteristicFilterEntry[] | undefined;
  // an admin, a flag: false lists every variant on a row of its own (the rows are variants)
  group?: boolean | undefined;
  // the rows are variants and the variants of a product with the same main characteristics are
  // merged into one row (a buyer always, an admin unless group is false)
  grouped?: boolean | undefined;
  cursor?: string | undefined;
};

// a field only the products of a flag have: a sort by it comes with the flag
const SORT_FLAGS: Partial<
  Record<ProductsSortField, { flag: 'deleted' | 'onSale' | 'popularityOverridden'; code: string }>
> = {
  deletedAt: { flag: 'deleted', code: 'SORT_DELETED_AT_REQUIRES_DELETED' },
  saleEndsAt: { flag: 'onSale', code: 'SORT_SALE_ENDS_AT_REQUIRES_ON_SALE' },
  salePrice: { flag: 'onSale', code: 'SORT_SALE_PRICE_REQUIRES_ON_SALE' },
  discount: { flag: 'onSale', code: 'SORT_DISCOUNT_REQUIRES_ON_SALE' },
  popularityOverride: {
    flag: 'popularityOverridden',
    code: 'SORT_POPULARITY_OVERRIDE_REQUIRES_OVERRIDDEN',
  },
  popularityOverrideUntil: {
    flag: 'popularityOverridden',
    code: 'SORT_POPULARITY_OVERRIDE_REQUIRES_OVERRIDDEN',
  },
};

// the flags of an admin that find the gaps of the catalog, by what they are about. A flag about a
// variant makes the rows variants, one about a product leaves them products. Each is a flag in the
// sense of the others (the sale and the override do not filter next to it), and a buyer may not use
// it: FILTER_FORBIDDEN, as for group=false
const VARIANT_GAP_FLAGS = [
  'missingRequired',
  'withoutWeight',
  'withoutDimensions',
  'withoutBarcode',
  'withoutImages',
] as const;
type VariantGapFlag = (typeof VARIANT_GAP_FLAGS)[number];

const PRODUCT_GAP_FLAGS = ['hiddenFromBuyers', 'hasDeletedVariants'] as const;
const PARTY_FILTERS = ['manufacturerId', 'euResponsibleId', 'documentId'] as const;

// a row is a variant when the query asks anything of a variant (a sort, a filter of the price, the
// sale, the stock of a variant, its shipping data or its characteristics, the wish of an admin to
// see every variant); otherwise a row is a product
export function listModeOf(
  q: Pick<
    ProductListQuery,
    | 'sort'
    | 'minPrice'
    | 'maxPrice'
    | 'onSale'
    | 'maxStock'
    | 'withoutShippingData'
    | 'characteristics'
    | 'group'
    | VariantGapFlag
  >,
): ListMode {
  const aboutVariant =
    VARIANT_SORTS.has(q.sort) ||
    q.minPrice !== undefined ||
    q.maxPrice !== undefined ||
    q.onSale === true ||
    q.maxStock !== undefined ||
    q.withoutShippingData === true ||
    VARIANT_GAP_FLAGS.some((flag) => q[flag] === true) ||
    (q.characteristics?.length ?? 0) > 0 ||
    q.group === false;

  return aboutVariant ? 'variant' : 'product';
}

// normalize dto for findAll: a buyer sorts by BUYER_SORTS and uses no flag of an admin; an admin
// sorts by anything, a field only some products have with their flag
export function normalizeFindAllProductsInput(dto: ReadProductsDto): ProductListQuery {
  const view = productViewOf(dto.actorRole);
  const limit = assertLimit(dto.limit ?? 20);

  // the syntax of the filter by characteristics; the database tells the rest (the service)
  const entries = parseCharacteristicFilter(dto.f);
  const characteristics = entries.length ? entries : undefined;

  const search =
    typeof dto.search === 'string' && dto.search.trim() ? dto.search.trim() : undefined;

  // a search puts the best match first unless another sort is asked for
  const sort: ProductsSortField = (dto.sort ??
    (search ? 'relevance' : 'popularity')) as ProductsSortField;
  const order: SortOrder = dto.order === 'asc' ? 'asc' : 'desc';
  if (sort === 'relevance' && !search) throw new BadRequestError('SORT_RELEVANCE_REQUIRES_SEARCH');

  // a sent category filter with no valid id must not turn into "every product";
  // the controller drops invalid ids, so ?categoryIds=0 arrives here as an empty list
  const categoryIds = Array.isArray(dto.categoryIds)
    ? dto.categoryIds.filter((n) => Number.isInteger(n) && n > 0)
    : undefined;
  if (categoryIds && !categoryIds.length) throw new BadRequestError('CATEGORY_IDS_INVALID');

  // the same for the products named: ids that are no ids must not turn into "every product"
  const productIds = Array.isArray(dto.productIds)
    ? dto.productIds.filter((n) => Number.isInteger(n) && n > 0)
    : undefined;
  if (productIds && !productIds.length) throw new BadRequestError('PRODUCT_IDS_INVALID');

  const minPrice = dto.minPrice != null ? Number(dto.minPrice) : undefined;
  const maxPrice = dto.maxPrice != null ? Number(dto.maxPrice) : undefined;

  // validate price range
  if (minPrice != null && (!Number.isFinite(minPrice) || minPrice < 0)) {
    throw new BadRequestError('MIN_PRICE_INVALID');
  }
  if (maxPrice != null && (!Number.isFinite(maxPrice) || maxPrice < 0)) {
    throw new BadRequestError('MAX_PRICE_INVALID');
  }
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    throw new BadRequestError('PRICE_RANGE_INVALID');
  }

  const inStock = typeof dto.inStock === 'boolean' ? dto.inStock : undefined;
  const maxStock =
    typeof dto.maxStock === 'number' && Number.isInteger(dto.maxStock) && dto.maxStock >= 0
      ? dto.maxStock
      : undefined;

  // a flag is on only when it is true: false, or anything else, is no flag
  const deleted = dto.deleted === true;
  const onSale = dto.onSale === true;
  const popularityOverridden = dto.popularityOverridden === true;
  const withoutShippingData = dto.withoutShippingData === true;
  // group is a flag of an admin only when it is false: the default is the groups of a buyer
  const group = dto.group === false ? false : undefined;

  // the flags of the gaps are on only when they are true (hiddenFromBuyers answers false too: the
  // products a buyer sees); the filters by a party or a document are ids
  const flagOn = (value: unknown) => (value === true ? true : undefined);
  const idOf = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
  const gaps = {
    missingRequired: flagOn(dto.missingRequired),
    withoutWeight: flagOn(dto.withoutWeight),
    withoutDimensions: flagOn(dto.withoutDimensions),
    withoutBarcode: flagOn(dto.withoutBarcode),
    withoutImages: flagOn(dto.withoutImages),
    hasDeletedVariants: flagOn(dto.hasDeletedVariants),
    hiddenFromBuyers: typeof dto.hiddenFromBuyers === 'boolean' ? dto.hiddenFromBuyers : undefined,
    manufacturerId: idOf(dto.manufacturerId),
    euResponsibleId: idOf(dto.euResponsibleId),
    documentId: idOf(dto.documentId),
  };

  // normalize cursor
  const cursor = typeof dto.cursor === 'string' && dto.cursor ? dto.cursor : undefined;

  const branch = dto.branch !== false;

  const base = {
    view,
    limit,
    sort,
    order,
    search,
    categoryIds,
    branch,
    productIds,
    minPrice,
    maxPrice,
    inStock,
    characteristics,
    ...(sort === 'sales' ? salesPeriodOf(dto.salesFrom, dto.salesTo) : {}),
  };

  if (view === 'buyer') {
    // deleted products are for admin and root only
    if (deleted) throw new ForbiddenError('DELETED_PRODUCTS_FORBIDDEN');
    if (onSale) throw new ForbiddenError('FILTER_FORBIDDEN', { filter: 'onSale' });
    if (popularityOverridden) {
      throw new ForbiddenError('FILTER_FORBIDDEN', { filter: 'popularityOverridden' });
    }
    if (maxStock !== undefined)
      throw new ForbiddenError('FILTER_FORBIDDEN', { filter: 'maxStock' });
    if (withoutShippingData) {
      throw new ForbiddenError('FILTER_FORBIDDEN', { filter: 'withoutShippingData' });
    }
    if (group === false) throw new ForbiddenError('FILTER_FORBIDDEN', { filter: 'group' });
    // a buyer sees what he sees: hiddenFromBuyers=false is his list, true is a filter of an admin
    for (const flag of [...VARIANT_GAP_FLAGS, ...PRODUCT_GAP_FLAGS]) {
      if (gaps[flag] === true) throw new ForbiddenError('FILTER_FORBIDDEN', { filter: flag });
    }
    for (const filter of PARTY_FILTERS) {
      if (gaps[filter] !== undefined) throw new ForbiddenError('FILTER_FORBIDDEN', { filter });
    }
    if (!BUYER_SORTS.includes(sort)) throw new ForbiddenError('SORT_FORBIDDEN', { sort });

    // a buyer sees every variant of the catalog, on sale or not
    const mode = listModeOf(base);
    return { ...base, mode, grouped: mode === 'variant', deleted: false, cursor };
  }

  // only the products of a flag have the field, the list of a flag sorts by it
  const needed = SORT_FLAGS[sort];
  if (needed && !{ deleted, onSale, popularityOverridden }[needed.flag]) {
    throw new BadRequestError(needed.code);
  }

  // without any flag an admin gets the plain products: not deleted, without a sale and without an
  // override that are on (a product has a sale when a variant of it has one). With a flag only its
  // condition counts, the other marks do not filter; the deleted products stay out without their
  // flag. Few free units are a flag too: the stock of every variant of the catalog
  const anyFlag =
    deleted ||
    onSale ||
    popularityOverridden ||
    maxStock !== undefined ||
    withoutShippingData ||
    Object.values(gaps).some((value) => value !== undefined);

  const query = {
    ...base,
    maxStock,
    withoutShippingData: withoutShippingData || undefined,
    ...gaps,
    deleted,
    onSale: anyFlag ? onSale || undefined : false,
    popularityOverridden: anyFlag ? popularityOverridden || undefined : false,
    group,
    cursor,
  };

  const mode = listModeOf(query);
  return { ...query, mode, grouped: mode === 'variant' && group !== false };
}

type SortKind = 'string' | 'date' | 'number';

// the variants a list holds, by the alias of the variant: the ones a buyer sees; for an admin the
// ones that are alive, or every variant of the products that were taken out
function eligibleSql(q: Pick<ProductListQuery, 'view' | 'deleted'>, a: string): Prisma.Sql {
  if (q.view === 'buyer') return visibleSql(a);

  return q.deleted ? Prisma.sql`TRUE` : Prisma.raw(`${a}."deletedAt" IS NULL`);
}

// whether a product has a variant of the list that fits the condition, any when none is given (the
// product rows)
const someVariantSql = (q: Pick<ProductListQuery, 'view' | 'deleted'>, condition?: Prisma.Sql) =>
  Prisma.sql`EXISTS (SELECT 1 FROM "product_variants" sv WHERE sv."productId" = p."id" AND ${eligibleSql(q, 'sv')}${condition ? Prisma.sql` AND ${condition}` : Prisma.empty})`;

// the price of the sort and the filters: a buyer pays the price a variant sells at now, an admin
// sees the usual price in the field, the sale price has a sort of its own
const priceSqlOf = (view: ProductView) =>
  view === 'admin' ? Prisma.raw(`v."price"`) : currentPriceSql('v');

// the id of a row of the list: a variant or a product
const rowIdSql = (q: Pick<ProductListQuery, 'mode'>) =>
  Prisma.raw(q.mode === 'variant' ? 'v."id"' : 'p."id"');

// the text of a search, without its accents, as the names are compared
const unaccented = (text: string) => Prisma.sql`cartlify.immutable_unaccent(${text})`;
const NAME_SQL = Prisma.raw(`cartlify.immutable_unaccent(p."name")`);
const CATEGORY_NAME_SQL = Prisma.raw(
  `(SELECT cartlify.immutable_unaccent(c."name") FROM "categories" c WHERE c."id" = p."categoryId")`,
);

// the code of a variant the text is: its article number (letter case ignored), for an admin its
// barcode too
function codeMatchSql(a: string, text: string, view: ProductView): Prisma.Sql {
  const sku = Prisma.sql`lower(${Prisma.raw(a)}."sku") = lower(${text})`;

  return view === 'admin' ? Prisma.sql`(${sku} OR ${Prisma.raw(a)}."barcode" = ${text})` : sku;
}

// whether a row of the list has the code: a variant row is the variant itself, a product row has it
// when one of its variants of the list does
function hasCodeSql(
  q: Pick<ProductListQuery, 'view' | 'mode' | 'deleted'>,
  text: string,
): Prisma.Sql {
  if (q.mode === 'variant') return codeMatchSql('v', text, q.view);

  return Prisma.sql`EXISTS (SELECT 1 FROM "product_variants" cv WHERE cv."productId" = p."id" AND ${eligibleSql(q, 'cv')} AND ${codeMatchSql('cv', text, q.view)})`;
}

// a row the search finds: its product has a name that holds the text as it is (% and _ are wildcards
// of ILIKE and \ is its escape, so each of them gets a \ in front), a word of which is close to a
// word of the text (a typo, another order of the words), or its category has such a name; or the
// text is the article number of the variant (a product row: of one of its variants)
function searchSqlOf(
  q: Pick<ProductListQuery, 'view' | 'mode' | 'deleted'>,
  search: string,
): Prisma.Sql {
  const text = search.trim();
  const literal = text.replace(/[\\%_]/g, '\\$&');

  return Prisma.sql`(
    ${NAME_SQL} ILIKE '%' || ${unaccented(literal)} || '%'
    OR cartlify.word_similarity(${unaccented(text)}, ${NAME_SQL}) >= ${SEARCH_SIMILARITY}
    OR ${CATEGORY_NAME_SQL} ILIKE '%' || ${unaccented(literal)} || '%'
    OR cartlify.word_similarity(${unaccented(text)}, ${CATEGORY_NAME_SQL}) >= ${SEARCH_SIMILARITY}
    OR ${hasCodeSql(q, text)}
  )`;
}

// how well a row matches the search, from 0 to 1: the words of the text in the name of the product,
// and the whole name close to the text (a short name of just these words ranks above a long one),
// the code of the variant, the name of the category a little lower. Rounded, so the cursor keeps
// the value
function relevanceSqlOf(search: string, hasCode: Prisma.Sql): Prisma.Sql {
  const text = search.trim();

  return Prisma.sql`round((GREATEST(
    cartlify.word_similarity(${unaccented(text)}, ${NAME_SQL}) * 0.8
      + cartlify.similarity(${unaccented(text)}, ${NAME_SQL}) * 0.2,
    CASE WHEN ${hasCode} THEN 1 ELSE 0 END,
    COALESCE(cartlify.word_similarity(${unaccented(text)}, ${CATEGORY_NAME_SQL}), 0) * 0.7
  ))::numeric, 6)`;
}

// the expression a sort orders by and the kind of its cursor value; a field only some products
// have is sorted in the list of its flag, where every row has it
function sortExpressionOf(
  q: Pick<ProductListQuery, 'sort' | 'view' | 'mode' | 'deleted' | 'search'>,
): { sql: Prisma.Sql; kind: SortKind } {
  const sort = q.sort;

  switch (sort) {
    case 'relevance':
      return {
        sql: relevanceSqlOf(q.search ?? '', hasCodeSql(q, (q.search ?? '').trim())),
        kind: 'number',
      };
    case 'name':
      return { sql: Prisma.raw(`p."name"`), kind: 'string' };
    // the sorts of a variant
    case 'price':
      return { sql: priceSqlOf(q.view), kind: 'number' };
    case 'salePrice':
      return { sql: Prisma.raw(`v."salePrice"`), kind: 'number' };
    case 'discount':
      return { sql: discountSql('v'), kind: 'number' };
    case 'saleEndsAt':
      return { sql: Prisma.raw(`v."saleEndsAt"`), kind: 'date' };
    case 'stock':
      return { sql: freeStockSql('v'), kind: 'number' };
    case 'totalStock':
      return { sql: Prisma.raw(`v."stock"`), kind: 'number' };
    case 'reservedStock':
      return { sql: Prisma.raw(`v."reservedStock"`), kind: 'number' };
    case 'expiredStock':
      return { sql: Prisma.raw(`cartlify.variant_expired_units(v.id)`), kind: 'number' };
    case 'sales':
      // the units of the product sold in the period of the query (the list joins them)
      return { sql: Prisma.raw(`COALESCE(s.units, 0)::float8`), kind: 'number' };
    case 'popularity':
    case 'views':
    case 'avgRating':
    case 'reviewsCount':
    case 'popularityOverride':
      return { sql: Prisma.raw(`p."${sort}"`), kind: 'number' };
    case 'createdAt':
    case 'updatedAt':
    case 'deletedAt':
    case 'popularityOverrideUntil':
      return { sql: Prisma.raw(`p."${sort}"`), kind: 'date' };
    default: {
      const _exhaustive: never = sort;
      return _exhaustive;
    }
  }
}

// the cursor of the sort: its value as the kind of the sort wants it, a changed one is a bad request
function cursorValueOf(kind: SortKind, v: unknown): string | number | Date {
  const value = v as string | number | null;
  if (kind === 'string') return cursorString(value);
  if (kind === 'date') return cursorDate(value);
  return cursorNumber(value);
}

// the variants on sale first, then the rest by popularity: the sale sorts of a buyer, by the end of
// the sale or by the discount (they are about variants, so the rows are variants)
const isBuyerSaleSort = (q: Pick<ProductListQuery, 'view' | 'sort'>) =>
  q.view === 'buyer' && (q.sort === 'saleEndsAt' || q.sort === 'discount');

// what the variants on sale are ordered by in the sale sorts of a buyer
const saleKeyOf = (sort: ProductsSortField) =>
  sort === 'discount' ? discountSql('v') : Prisma.raw(`v."saleEndsAt"`);

// the kind of the rows is part of the key: a cursor of a list of products does not continue a list
// of variants, nor does a list of groups continue a list of single variants (or the other way round)
const rowKindOf = (q: Pick<ProductListQuery, 'mode' | 'grouped'>) =>
  q.mode === 'variant' && q.grouped ? 'group' : q.mode;

const sortKeyOf = (q: Pick<ProductListQuery, 'mode' | 'grouped' | 'sort' | 'order'>) =>
  `${rowKindOf(q)}:${q.sort}:${q.order}`;

type DecodedCursor = { id: number; v: unknown; g?: unknown };

// a cursor of the same rows, sort and direction; a cursor of another one, or without one, is invalid
function decodeListCursor(q: ProductListQuery): DecodedCursor | undefined {
  if (!q.cursor) return undefined;

  const payload = decodeCursor(q.cursor) as DecodedCursor & { s?: unknown };
  if (payload.s !== sortKeyOf(q)) throw new BadRequestError('CURSOR_INVALID');

  return payload;
}

// the columns a cursor compares: those of a row of the list. In a list of single rows they are the
// expressions over the tables (v, p); in a list of groups they are the columns of the groups
type CursorColumns = {
  // the id of the row, which breaks the ties
  id: Prisma.Sql;
  // the value of the sort
  sort: Prisma.Sql;
  // the sale sorts of a buyer: whether the row is on sale, the end or the discount, the popularity
  saleOn: Prisma.Sql;
  saleKey: Prisma.Sql;
  popularity: Prisma.Sql;
};

const singleColumns = (q: ProductListQuery): CursorColumns => ({
  id: rowIdSql(q),
  sort: sortExpressionOf(q).sql,
  saleOn: saleOnSql('v'),
  saleKey: saleKeyOf(q.sort),
  popularity: Prisma.raw(`p."popularity"`),
});

// the units a product sold in a period are the shop's own numbers: the list shows a buyer their
// order, not the count, so a cursor of the sales sort holds no value (makeNextCursor) and a value
// sent in one is not read. The units are read again for the product of the row the cursor names (the
// id of a product, or of a variant: the first of a group)
function salesOfCursorRow(q: ProductListQuery, rowId: number): Prisma.Sql {
  if (!q.salesFrom || !q.salesTo) return Prisma.sql`0::float8`;

  const product =
    q.mode === 'variant'
      ? Prisma.sql`(SELECT cv."productId" FROM "product_variants" cv WHERE cv."id" = ${rowId}::int)`
      : Prisma.sql`${rowId}::int`;

  return Prisma.sql`COALESCE((
    SELECT cs.units
    FROM cartlify.units_sold_in_period(${utcStamp(q.salesFrom)}::timestamp, ${utcStamp(q.salesTo)}::timestamp) cs
    WHERE cs.product_id = ${product}
  ), 0)::float8`;
}

// build keyset cursor sql for the raw query of ids: the id of the row (a variant, a group or a
// product) breaks the ties, so the pages neither skip nor repeat a row
function buildCursorSql(q: ProductListQuery, columns: CursorColumns): Prisma.Sql {
  const cursor = decodeListCursor(q);
  if (!cursor) return Prisma.empty;

  const op = Prisma.raw(q.order === 'asc' ? '>' : '<');
  const id = columns.id;

  // the sale sort of a buyer: after a variant on sale come the later ones and every variant
  // without a sale; after a variant without a sale only the less popular ones
  if (isBuyerSaleSort(q)) {
    const saleOn = columns.saleOn;

    if (cursor.g === 1) {
      const key = columns.saleKey;
      const value =
        q.sort === 'discount' ? cursorNumber(cursor.v as number) : cursorDate(cursor.v as string);
      return Prisma.sql`
        AND (
          (${saleOn} AND (${key} ${op} ${value} OR (${key} = ${value} AND ${id} ${op} ${cursor.id})))
          OR NOT ${saleOn}
        )
      `;
    }
    if (cursor.g === 0) {
      const popularity = cursorNumber(cursor.v as number);
      return Prisma.sql`
        AND (
          NOT ${saleOn} AND (${columns.popularity} < ${popularity} OR (${columns.popularity} = ${popularity} AND ${id} < ${cursor.id}))
        )
      `;
    }
    throw new BadRequestError('CURSOR_INVALID');
  }

  const { kind } = sortExpressionOf(q);
  const col = columns.sort;
  const value = q.sort === 'sales' ? salesOfCursorRow(q, cursor.id) : cursorValueOf(kind, cursor.v);

  return Prisma.sql`
    AND (
      ${col} ${op} ${value}
      OR (${col} = ${value} AND ${id} ${op} ${cursor.id})
    )
  `;
}

// the ids of the categories and of everything below them: the products of a branch, as the catalog
// lists them and the panel of the filter reads them
export const categoryBranchSql = (categoryIds: readonly number[]) =>
  Prisma.sql`
            WITH RECURSIVE branch AS (
              SELECT c."id" FROM "categories" c WHERE c."id" IN (${Prisma.join(categoryIds)})
              UNION
              SELECT c."id" FROM "categories" c JOIN branch b ON c."parentId" = b."id"
            )
            SELECT "id" FROM branch
          `;

// the conditions of the flags that find the gaps of the catalog (an admin). The ones about a
// variant are conditions of the row, which is a variant then; the ones about a product, of the
// product of the row. A product is hidden from the buyers when it is removed or none of its variants
// is one a buyer sees (visibleSql: alive, with a picture), the rule of the buyer's own list. The
// rule of the characteristics a category requires is the view the database keeps, which the alert
// of the variants that lack them reads too
function gapConditionsOf(q: ProductListQuery): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];

  if (q.missingRequired) {
    parts.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "variants_missing_required" mr WHERE mr."variant_id" = v."id")`,
    );
  }
  if (q.withoutWeight) parts.push(Prisma.sql`v."weightGrams" IS NULL`);
  if (q.withoutDimensions) {
    parts.push(Prisma.sql`(v."lengthMm" IS NULL OR v."widthMm" IS NULL OR v."heightMm" IS NULL)`);
  }
  if (q.withoutBarcode) parts.push(Prisma.sql`v."barcode" IS NULL`);
  if (q.withoutImages) {
    parts.push(
      Prisma.sql`NOT EXISTS (SELECT 1 FROM "variant_images" wi WHERE wi."variantId" = v."id")`,
    );
  }

  if (q.hiddenFromBuyers !== undefined) {
    const hidden = Prisma.sql`(p."deletedAt" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM "product_variants" hv WHERE hv."productId" = p."id" AND ${visibleSql('hv')}))`;
    parts.push(q.hiddenFromBuyers ? hidden : Prisma.sql`NOT ${hidden}`);
  }
  if (q.hasDeletedVariants) {
    parts.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "product_variants" dv WHERE dv."productId" = p."id" AND dv."deletedAt" IS NOT NULL)`,
    );
  }

  if (q.manufacturerId !== undefined)
    parts.push(Prisma.sql`p."manufacturerId" = ${q.manufacturerId}`);
  if (q.euResponsibleId !== undefined) {
    parts.push(Prisma.sql`p."euResponsibleId" = ${q.euResponsibleId}`);
  }
  if (q.documentId !== undefined) {
    parts.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "product_documents" pd WHERE pd."productId" = p."id" AND pd."documentId" = ${q.documentId})`,
    );
  }

  return parts;
}

// the conditions of the filters, joined with AND
function buildWhereSql(q: ProductListQuery): Prisma.Sql {
  const whereParts: Prisma.Sql[] = [];
  const variantRows = q.mode === 'variant';

  // deleted filter, every role
  whereParts.push(
    q.deleted ? Prisma.sql`p."deletedAt" IS NOT NULL` : Prisma.sql`p."deletedAt" IS NULL`,
  );

  if (variantRows) {
    // the variants of the list
    whereParts.push(eligibleSql(q, 'v'));
  } else if (q.view === 'buyer') {
    // a buyer lists only the products that have a variant he sees
    whereParts.push(someVariantSql(q));
  }

  // the sale: only the variants with a sale that is on, or (a flag of an admin) only the products
  // and variants without one. A product has a sale when a variant of it has one
  if (q.onSale === true) {
    whereParts.push(variantRows ? saleOnSql('v') : someVariantSql(q, saleOnSql('sv')));
  }
  if (q.onSale === false) {
    whereParts.push(
      variantRows
        ? Prisma.sql`NOT ${saleOnSql('v')}`
        : Prisma.sql`NOT ${someVariantSql(q, saleOnSql('sv'))}`,
    );
  }

  if (q.popularityOverridden === true) whereParts.push(OVERRIDE_ON_SQL);
  if (q.popularityOverridden === false) whereParts.push(Prisma.sql`NOT ${OVERRIDE_ON_SQL}`);

  // the variants that lack the weight or the sizes (the sizes come all three or none)
  if (q.withoutShippingData === true) {
    whereParts.push(Prisma.sql`(v."weightGrams" IS NULL OR v."lengthMm" IS NULL)`);
  }

  whereParts.push(...gapConditionsOf(q));

  // stock filter by free units, the same number the list shows as stock: a variant row has them, a
  // product row has some variant that has them
  if (q.inStock !== undefined) {
    if (variantRows) {
      const free = freeStockSql('v');
      whereParts.push(q.inStock ? Prisma.sql`${free} > 0` : Prisma.sql`${free} = 0`);
    } else {
      const some = someVariantSql(q, Prisma.sql`${freeStockSql('sv')} > 0`);
      whereParts.push(q.inStock ? some : Prisma.sql`NOT ${some}`);
    }
  }
  if (q.maxStock !== undefined) whereParts.push(Prisma.sql`${freeStockSql('v')} <= ${q.maxStock}`);

  // category filter: each category with its whole branch, a parent category shows the products
  // of its children; branch=false takes only the products of each category itself
  if (q.categoryIds?.length) {
    whereParts.push(
      q.branch
        ? Prisma.sql`p."categoryId" IN (${categoryBranchSql(q.categoryIds)})`
        : Prisma.sql`p."categoryId" IN (${Prisma.join(q.categoryIds)})`,
    );
  }

  // only the products named
  if (q.productIds?.length) whereParts.push(Prisma.sql`p."id" IN (${Prisma.join(q.productIds)})`);

  // price range of a variant: the price a buyer pays now, the usual price for an admin
  const price = priceSqlOf(q.view);
  if (q.minPrice != null) whereParts.push(Prisma.sql`${price} >= ${q.minPrice}`);
  if (q.maxPrice != null) whereParts.push(Prisma.sql`${price} <= ${q.maxPrice}`);

  if (q.search) whereParts.push(searchSqlOf(q, q.search));

  // the characteristics of a variant: every entry holds (the variants of the list, see eligibleSql)
  if (variantRows && q.characteristics?.length) {
    whereParts.push(...characteristicFilterSql(q.characteristics, 'v'));
  }

  return Prisma.join(whereParts, ' AND ');
}

// the rows of the list: variants of their products, or products. The units sold in the period come
// from a function of the database: a buyer reads no order of another buyer
function buildFromSql(q: ProductListQuery, withSales: boolean): Prisma.Sql {
  const salesJoin =
    withSales && q.sort === 'sales' && q.salesFrom && q.salesTo
      ? Prisma.sql`LEFT JOIN cartlify.units_sold_in_period(${utcStamp(q.salesFrom)}::timestamp, ${utcStamp(q.salesTo)}::timestamp) s ON s.product_id = p."id"`
      : Prisma.empty;

  return q.mode === 'variant'
    ? Prisma.sql`FROM "product_variants" v JOIN "products" p ON p."id" = v."productId" ${salesJoin}`
    : Prisma.sql`FROM "products" p ${salesJoin}`;
}

// up to 8 names of the catalog for what a person types, the best match first. A buyer is told of the
// products a list shows: the ones that have a variant he sees
export function buildSuggestionsQuery(text: string, view: ProductView): Prisma.Sql {
  const listed =
    view === 'buyer'
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "product_variants" sv WHERE sv."productId" = p."id" AND ${visibleSql('sv')})`
      : Prisma.empty;

  return Prisma.sql`
    SELECT p."id" AS id, p."name" AS name
    FROM "products" p
    WHERE p."deletedAt" IS NULL
      ${listed}
      AND (
        ${NAME_SQL} ILIKE '%' || ${unaccented(text.replace(/[\\%_]/g, '\\$&'))} || '%'
        OR cartlify.word_similarity(${unaccented(text)}, ${NAME_SQL}) >= ${SEARCH_SIMILARITY}
      )
    ORDER BY ${relevanceSqlOf(text, Prisma.sql`FALSE`)} DESC, p."id" DESC
    LIMIT 8
  `;
}

// What a variant is by its main characteristics, as a text: the characteristic and its value (the
// id of the value of a list, the number, yes or no) of each main characteristic it has a value of,
// by the characteristic. Two variants of a product with the same text have the same main
// characteristics and are one row of a list of groups. A variant without a value of a main
// characteristic has no part for it, so the variants without it are equal to each other and not to
// the ones with it; a product with no main characteristic has the empty text for every variant. A
// main characteristic is a choice of one value, a number or yes/no, so a variant has one value of it.
// The values are joined to the variants of the CTE `base` (they are not asked for variant by variant:
// that costs a probe of a subquery for each variant, 30 microseconds, 0.7 s for a list of 24 000
// variants), so the planner joins them in one pass when the list is wide and by the index when it is
// narrow. `columns` are the columns of `base` the rows keep
const signedSql = (columns: readonly string[]) => {
  const kept = columns.map((column) => `b.${column}`).join(', ');

  return Prisma.raw(
    `SELECT ${kept}, COALESCE(string_agg(mv."attributeId"::text || ':' || ` +
      `COALESCE(mv."optionId"::text, mv."numberValue"::text, mv."boolValue"::text), ',' ` +
      `ORDER BY mv."attributeId", mv."optionId"), '') AS sig ` +
      `FROM base b LEFT JOIN "variant_attribute_values" mv ON mv."variantId" = b.id ` +
      `AND mv."attributeId" IN (SELECT ma."id" FROM "attributes" ma WHERE ma."isMain") ` +
      `GROUP BY ${kept}`,
  );
};

// The raw query of ids for the rows that are groups: the variants that fit the query (the filters,
// not the cursor) are taken together by their product and their main characteristics, and each
// group is a row: the id of its first variant by its place, the value of the sort (the lowest of the
// variants going up, the highest going down: a group stands where its best variant stands), the
// lowest and the highest price the variants sell at now, and their free units. The cursor and the
// page come after the groups are made. The sale sorts of a buyer take the variants on sale of a
// group for the sale part
function buildGroupedIdsQuery(q: ProductListQuery): Prisma.Sql {
  const dir = Prisma.raw(q.order === 'asc' ? 'ASC' : 'DESC');
  const best = Prisma.raw(q.order === 'asc' ? 'min' : 'max');
  const from = buildFromSql(q, true);

  if (isBuyerSaleSort(q)) {
    const saleOn = saleOnSql('v');
    // the end of the sale or the discount: the column the cursor reads
    const key = Prisma.raw(q.sort === 'discount' ? 'discount' : '"endsAt"');
    const columns: CursorColumns = {
      id: Prisma.raw('grp.id'),
      sort: Prisma.raw('grp.g'),
      saleOn: Prisma.raw('(grp.g = 1)'),
      saleKey: Prisma.sql`grp.${key}`,
      popularity: Prisma.raw('grp.popularity'),
    };

    const signed = signedSql([
      'id',
      '"productId"',
      'place',
      'price',
      'free',
      'on_sale',
      'sale_key',
      'popularity',
    ]);

    return Prisma.sql`
      WITH base AS (
        SELECT v."id" AS id,
               v."productId" AS "productId",
               v."position" AS place,
               ${currentPriceSql('v')} AS price,
               ${freeStockSql('v')} AS free,
               CASE WHEN ${saleOn} THEN 1 ELSE 0 END AS on_sale,
               CASE WHEN ${saleOn} THEN ${saleKeyOf(q.sort)} END AS sale_key,
               p."popularity" AS popularity
        ${from}
        WHERE ${buildWhereSql(q)}
      ),
      m AS (
        ${signed}
      ),
      grp AS (
        SELECT (array_agg(m.id ORDER BY m.place, m.id))[1] AS id,
               m."productId" AS "productId",
               max(m.on_sale) AS g,
               ${best}(m.sale_key) FILTER (WHERE m.on_sale = 1) AS ${key},
               max(m.popularity) AS popularity,
               min(m.price) AS "minPrice",
               max(m.price) AS "maxPrice",
               sum(m.free)::int AS stock
        FROM m
        GROUP BY m."productId", m.sig
      )
      SELECT grp.*
      FROM grp
      WHERE TRUE
      ${buildCursorSql(q, columns)}
      ORDER BY grp.g DESC,
               CASE WHEN grp.g = 1 THEN grp.${key} END ${dir},
               CASE WHEN grp.g = 1 THEN grp.id END ${dir},
               grp.popularity DESC, grp.id DESC
      LIMIT ${q.limit + 1}
    `;
  }

  const columns: CursorColumns = {
    id: Prisma.raw('grp.id'),
    sort: Prisma.raw('grp.v'),
    // only the sale sorts of a buyer compare these
    saleOn: Prisma.raw('FALSE'),
    saleKey: Prisma.raw('NULL'),
    popularity: Prisma.raw('NULL'),
  };

  const signed = signedSql(['id', '"productId"', 'place', 'price', 'free', 'sk']);

  return Prisma.sql`
    WITH base AS (
      SELECT v."id" AS id,
             v."productId" AS "productId",
             v."position" AS place,
             ${currentPriceSql('v')} AS price,
             ${freeStockSql('v')} AS free,
             ${sortExpressionOf(q).sql} AS sk
      ${from}
      WHERE ${buildWhereSql(q)}
    ),
    m AS (
      ${signed}
    ),
    grp AS (
      SELECT (array_agg(m.id ORDER BY m.place, m.id))[1] AS id,
             m."productId" AS "productId",
             ${best}(m.sk) AS v,
             min(m.price) AS "minPrice",
             max(m.price) AS "maxPrice",
             sum(m.free)::int AS stock
      FROM m
      GROUP BY m."productId", m.sig
    )
    SELECT grp.*
    FROM grp
    WHERE TRUE
    ${buildCursorSql(q, columns)}
    ORDER BY grp.v ${dir}, grp.id ${dir}
    LIMIT ${q.limit + 1}
  `;
}

// build raw query that returns the ids of a page (variants or products) and the values of their
// sort, for the cursor; one id more than the page tells there is a next page
export function buildProductIdsQuery(q: ProductListQuery): Prisma.Sql {
  if (q.mode === 'variant' && q.grouped) return buildGroupedIdsQuery(q);

  const whereSql = buildWhereSql(q);
  const cursorSql = buildCursorSql(q, singleColumns(q));
  const dir = Prisma.raw(q.order === 'asc' ? 'ASC' : 'DESC');
  const from = buildFromSql(q, true);
  const id = rowIdSql(q);
  const productId =
    q.mode === 'variant' ? Prisma.sql`, v."productId" AS "productId"` : Prisma.empty;

  // the variants on sale first by the end of the sale or by the discount in the direction asked
  // for, then every other variant by the popularity of its product, the most popular first
  if (isBuyerSaleSort(q)) {
    const saleOn = saleOnSql('v');

    return Prisma.sql`
      SELECT ${id} AS id ${productId},
             CASE WHEN ${saleOn} THEN 1 ELSE 0 END AS g,
             v."saleEndsAt" AS "endsAt",
             ${discountSql('v')} AS discount,
             p."popularity" AS popularity
      ${from}
      WHERE ${whereSql}
      ${cursorSql}
      ORDER BY CASE WHEN ${saleOn} THEN 1 ELSE 0 END DESC,
               CASE WHEN ${saleOn} THEN ${saleKeyOf(q.sort)} END ${dir},
               CASE WHEN ${saleOn} THEN ${id} END ${dir},
               p."popularity" DESC, ${id} DESC
      LIMIT ${q.limit + 1}
    `;
  }

  const { sql: col } = sortExpressionOf(q);

  return Prisma.sql`
    SELECT ${id} AS id ${productId}, ${col} AS v
    ${from}
    WHERE ${whereSql}
    ${cursorSql}
    ORDER BY ${col} ${dir}, ${id} ${dir}
    LIMIT ${q.limit + 1}
  `;
}

// the number of the rows the filters find, whatever page the cursor is on. A row of a list of
// groups is a product with a signature of its main characteristics
export function buildTotalQuery(q: ProductListQuery): Prisma.Sql {
  if (q.mode === 'variant' && q.grouped) {
    return Prisma.sql`
      WITH base AS (
        SELECT v."id" AS id, v."productId" AS "productId"
        ${buildFromSql(q, false)}
        WHERE ${buildWhereSql(q)}
      ),
      m AS (
        ${signedSql(['id', '"productId"'])}
      )
      SELECT count(*)::int AS total
      FROM (SELECT DISTINCT m."productId", m.sig FROM m) g
    `;
  }

  return Prisma.sql`
    SELECT count(*)::int AS total
    ${buildFromSql(q, false)}
    WHERE ${buildWhereSql(q)}
  `;
}

// For the products of a page of product rows: the lowest and the highest price they sell at now,
// the free units of their variants of the list, and the main variant. The main variant is the one
// the search named by its code, else the first by its place with free units, the first of all when
// none has; an admin gets the one a buyer would get first (variants that are for sale with a
// picture, then the ones for sale, then the rest), as the card does
export function buildProductAggregatesQuery(
  q: Pick<ProductListQuery, 'view' | 'deleted' | 'search'>,
  productIds: readonly number[],
): Prisma.Sql {
  const search = q.search?.trim();
  // a variant without a code is not named (the comparison with null is null, which DESC puts first)
  const named = search
    ? Prisma.sql`COALESCE(${codeMatchSql('v', search, q.view)}, FALSE)`
    : Prisma.sql`FALSE`;

  return Prisma.sql`
    WITH w AS (
      SELECT v."id" AS id,
             v."productId" AS "productId",
             v."position" AS place,
             ${eligibleSql(q, 'v')} AS listed,
             ${freeStockSql('v')} AS free,
             ${currentPriceSql('v')} AS price,
             ${named} AS named,
             CASE
               WHEN v."deletedAt" IS NULL AND EXISTS
                 (SELECT 1 FROM "variant_images" wi WHERE wi."variantId" = v."id") THEN 0
               WHEN v."deletedAt" IS NULL THEN 1
               ELSE 2
             END AS tier
      FROM "product_variants" v
      WHERE v."productId" = ANY(${productIds as number[]}::int[])
    )
    SELECT w."productId" AS "productId",
           min(w.price) FILTER (WHERE w.listed) AS "minPrice",
           max(w.price) FILTER (WHERE w.listed) AS "maxPrice",
           COALESCE(sum(w.free) FILTER (WHERE w.listed), 0)::int AS stock,
           (array_agg(w.id ORDER BY (w.listed AND w.named) DESC, w.tier, (w.free > 0) DESC, w.place, w.id))[1] AS "variantId"
    FROM w
    GROUP BY w."productId"
  `;
}

// a row of the raw query: the id of the row (a variant or a product), the product of a variant row
// and the value of the sort; the sale sort of a buyer gives the part (g: 1 on sale, 0 not), the end
// of the sale and the popularity
export type ProductKeyRow = {
  id: number;
  productId?: number;
  // a group: the lowest and the highest price of its variants, and their free units
  minPrice?: unknown;
  maxPrice?: unknown;
  stock?: number;
  v?: unknown;
  g?: number;
  endsAt?: Date | null;
  discount?: number | null;
  popularity?: number;
};

// a value of the database as a cursor keeps it: a date as iso, a decimal as a number
function cursorValue(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' || typeof v === 'number') return v;
  return decimalToNumber(v);
}

// the cursor of the next page from the last row, with its rows, sort and direction
export function makeNextCursor(
  q: Pick<ProductListQuery, 'view' | 'mode' | 'grouped' | 'sort' | 'order'>,
  last: ProductKeyRow,
): string {
  const s = sortKeyOf(q);

  if (isBuyerSaleSort(q)) {
    const g = Number(last.g) === 1 ? 1 : 0;
    const onSaleKey = q.sort === 'discount' ? last.discount : last.endsAt;
    const v = g === 1 ? cursorValue(onSaleKey) : cursorValue(last.popularity);
    return encodeCursor({ id: last.id, v, s, g } as never);
  }

  // the units sold stay out of the cursor (salesOfCursorRow reads them again)
  const v = q.sort === 'sales' ? null : cursorValue(last.v);
  return encodeCursor({ id: last.id, v, s } as never);
}
