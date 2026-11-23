import { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import { utcTime } from './helpers/accountingSql.helper.js';

import type { GetAdminVatReportResponseDto, AdminVatRowDto } from 'types/dto/admin.dto.js';
import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

// The report of the tax of the sales for the declarations (docs/taxes.md): the money of a period
// [from, to) from the money journal, each line with the tax it holds share by share of the copy of
// its order (money_log.taxShares, db/05), by the rule of the tax, the country it is taxed in and the
// rate: the sales (the payments), the money that went back to the buyers (a refund when it was sent,
// money sent outside the app, money given back by hand or taken by a bank by the decision of what it
// was for, in its moment) and the money that came back to the shop after it (a refund that failed
// after it was sent, money the buyer gave back), and all of them together. Every event
// is in the period it happened in: the journal only grows, a period that is over never changes. The
// country taxed by the rule recipient names the tax number root wrote for it. The tax of the
// purchases is not kept

type Section = 'sales' | 'returns' | 'failures';

type Row = {
  section: Section;
  rule: AdminVatRowDto['rule'];
  country: string | null;
  rate: Prisma.Decimal | null;
  net: Prisma.Decimal;
  tax: Prisma.Decimal;
  gross: Prisma.Decimal;
};

const RULES: AdminVatRowDto['rule'][] = ['seller', 'recipient', 'none', 'buyer_at_receipt', null];

const keyOf = (row: Pick<AdminVatRowDto, 'rule' | 'country' | 'rate'>) =>
  `${row.rule}|${row.country}|${row.rate}`;

// the rows in their order: the rule, the country, the rate (the part without a tax first)
const ordered = (rows: AdminVatRowDto[]) =>
  [...rows].sort(
    (a, b) =>
      RULES.indexOf(a.rule) - RULES.indexOf(b.rule) ||
      (a.country ?? '').localeCompare(b.country ?? '') ||
      (a.rate ?? -1) - (b.rate ?? -1),
  );

const cents = (value: Prisma.Decimal | number) => Math.round(Number(value) * 100) / 100;

export async function buildVatReport(args: {
  from: Date;
  to: Date;
  actorId: UserId;
  actorRole: Role;
}): Promise<GetAdminVatReportResponseDto> {
  const { rows, numbers } = await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    // the moment a share counts: the decision it came with (money given back by hand, what a bank
    // took: at), else its line: a refund when it was sent, the rest when it was written. The section
    // is the event: a decision made again turns its old shares round within the returns
    const rows = await db.$queryRaw<Row[]>`
      with counted as (
        select m.event, m.amount, m."taxShares",
               case when m.event = 'money.refund' then m."stateAt" else m."createdAt" end as at
        from cartlify.money_log as m
        where m."taxShares" is not null
      )
      select case
               when c.event = 'money.payment' then 'sales'
               when c.event in ('money.refund_failed', 'money.received') then 'failures'
               else 'returns'
             end as section,
             s ->> 'rule' as rule,
             s ->> 'country' as country,
             (s ->> 'rate')::numeric as rate,
             sum((s ->> 'net')::numeric) as net,
             sum((s ->> 'tax')::numeric) as tax,
             sum((s ->> 'gross')::numeric) as gross
      from counted as c
      cross join lateral jsonb_array_elements(c."taxShares") as s
      where coalesce((s ->> 'at')::timestamp, c.at) >= ${utcTime(args.from)}
        and coalesce((s ->> 'at')::timestamp, c.at) < ${utcTime(args.to)}
      group by 1, 2, 3, 4
    `;
    // the tax numbers of the countries a sale is taxed in by the rule recipient
    const numbers = await db.shopCountry.findMany({
      where: { taxNumber: { not: null } },
      select: { country: true, taxNumber: true },
    });
    return { rows, numbers };
  });

  const taxNumberOf = new Map(numbers.map((n) => [n.country, n.taxNumber]));
  const dtoOf = (row: Omit<Row, 'section'>): AdminVatRowDto => ({
    rule: row.rule,
    country: row.country,
    taxNumber:
      row.rule === 'recipient' && row.country ? (taxNumberOf.get(row.country) ?? null) : null,
    rate: row.rate === null ? null : Number(row.rate),
    net: cents(row.net),
    tax: cents(row.tax),
    gross: cents(row.gross),
  });

  const section = (name: Section) => ordered(rows.filter((r) => r.section === name).map(dtoOf));

  // all of them together, by the rule, the country and the rate
  const total = new Map<string, AdminVatRowDto>();
  for (const row of rows.map(dtoOf)) {
    const key = keyOf(row);
    const sum = total.get(key);
    if (!sum) total.set(key, { ...row });
    else {
      sum.net = cents(sum.net + row.net);
      sum.tax = cents(sum.tax + row.tax);
      sum.gross = cents(sum.gross + row.gross);
    }
  }

  return {
    from: args.from.toISOString(),
    to: args.to.toISOString(),
    currency: env.SHOP_CURRENCY.toUpperCase(),
    sales: section('sales'),
    returns: section('returns'),
    failures: section('failures'),
    total: ordered([...total.values()]),
  };
}
