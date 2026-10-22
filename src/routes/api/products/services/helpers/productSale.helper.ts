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
