import { Prisma } from '@prisma/client';

import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { BadRequestError } from '@utils/errors.js';

import type { ProductSaleDiscountDto } from 'types/dto/products.dto.js';

// the sale price of a discount: a percent of the price, or an amount of money off it. The schema
// lets through a percent above 0 up to 100 and an amount above 0; the sale price is counted in
// decimals and rounded to cents, a half cent up. It has to stay below the price, the way the
// database wants it (products_sale_chk): 0 is a product given away
export function computeSalePrice(
  price: Prisma.Decimal,
  discount: ProductSaleDiscountDto,
): { salePrice: Prisma.Decimal; discount: Prisma.Decimal } {
  let salePrice: Prisma.Decimal;

  if ('percent' in discount) {
    salePrice = price
      .mul(new Prisma.Decimal(100).minus(discount.percent))
      .div(100)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  } else {
    const amount = new Prisma.Decimal(discount.amount);
    if (amount.greaterThan(price)) {
      throw new BadRequestError('PRODUCT_SALE_AMOUNT_TOO_HIGH', { price: decimalToNumber(price) });
    }
    salePrice = price.minus(amount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  // a discount that rounds to nothing makes no sale, a free product has nothing to take off
  if (!salePrice.lessThan(price)) throw new BadRequestError('PRODUCT_SALE_TOO_SMALL');

  return { salePrice, discount: price.minus(salePrice) };
}

// the end of a sale, in the future: a sale starts right away and has no start of its own
export function normalizeSaleEnd(endsAt: string, now = Date.now()): Date {
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime()) || end.getTime() <= now) {
    throw new BadRequestError('PRODUCT_SALE_ENDS_AT_INVALID');
  }
  return end;
}

// how many days before a sale its lowest price is looked for (the EU rule of a price reduction)
export const SALE_PRIOR_PRICE_DAYS = 30;

// a line of the log of prices, the oldest first
export type PriceLogLine = {
  oldPrice: Prisma.Decimal;
  newPrice: Prisma.Decimal;
  // a line with an end starts a sale: from the price down to the sale price
  endsAt: Date | null;
  createdAt: Date;
};

// the lowest price the product sold at from `from` to `to`, replayed from its log of prices: the
// price `from` began with, every price after a line of the time, and `current`, the price it sells
// at right before the new sale. A line with an end starts a sale; a line from the sale price back
// up takes it off; any other line changes the price, and a price down to the sale price or below
// ends the sale (db/05). A sale also ends by its end, with no line; its price stays only for the
// time it lasted, and the price after it is not lower than it
export function lowestPriceOf(args: {
  lines: PriceLogLine[];
  current: Prisma.Decimal;
  from: Date;
  to: Date;
}): Prisma.Decimal {
  const { lines, current, from, to } = args;

  let price: Prisma.Decimal | null = lines.length ? lines[0]!.oldPrice : null;
  let sale: { price: Prisma.Decimal; endsAt: Date } | null = null;
  const appliedAt = (time: Date) =>
    sale && sale.endsAt.getTime() > time.getTime() ? sale.price : price;

  let lowest = current;
  const take = (value: Prisma.Decimal | null) => {
    if (value && value.lessThan(lowest)) lowest = value;
  };

  let began = false;
  for (const line of lines) {
    if (line.createdAt.getTime() >= to.getTime()) break;

    // the price the time began with, once the lines before it are replayed
    if (!began && line.createdAt.getTime() >= from.getTime()) {
      take(appliedAt(from));
      began = true;
    }

    if (line.endsAt) {
      price = line.oldPrice;
      sale = { price: line.newPrice, endsAt: line.endsAt };
    } else if (sale && line.oldPrice.equals(sale.price)) {
      sale = null;
      price = line.newPrice;
    } else {
      price = line.newPrice;
      if (sale && line.newPrice.lessThanOrEqualTo(sale.price)) sale = null;
    }

    if (began) take(appliedAt(line.createdAt));
  }

  if (!began) take(appliedAt(from));

  return lowest;
}
