import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import {
  removeNewsletterFixtures,
  setupNewsletterFixtures,
  type NewsletterFixtures,
} from '../../helpers/newsletterDb.js';
import { inReadonlyTx } from '../../helpers/ownerDb.js';

// what the roles of the app may do in the database at all, before any rls policy: the app
// connects as cartlify_app, cartlify_readonly is the role for reading by hand. The tests read
// the catalog and try the forbidden statements as cartlify_app, inside a transaction that is
// rolled back

const APP = 'cartlify_app';
const READONLY = 'cartlify_readonly';

// the functions db/schema/01 opens for the app (section 5a), besides the extension functions
const APP_FUNCTIONS = [
  'cartlify.set_current_context(cartlify."Role", integer, uuid)',
  'cartlify.current_actor_id()',
  'cartlify.current_guest_id()',
  'cartlify.current_actor_role()',
  'cartlify.is_admin()',
  'cartlify.is_root()',
  'cartlify.is_system()',
  'cartlify.is_owner(integer)',
  'cartlify.is_owner_or_admin(integer)',
  // the policies of the newsletter tables ask it: root, or an admin root allowed
  'cartlify.newsletter_manager()',
  'cartlify.immutable_unaccent(text)',
  'cartlify.auth_get_user_for_login(text)',
  'cartlify.auth_resend_verify(text, text, timestamp with time zone)',
  'cartlify.auth_verify_email(text)',
  'cartlify.users_get_public_profile(integer)',
  'cartlify.remove_user_avatar(integer)',
  'cartlify.migrate_guest_data_to_user(uuid, integer)',
  // the subscription to the newsletters: for a guest by the link of a mail, for an account on its
  // own address; each checks the actor itself
  'cartlify.newsletter_request(text, text, text, text, text, text, text, text, text)',
  // the mail of the form the provider refused: the day of the address is given back
  'cartlify.newsletter_request_mail_failed(text, text)',
  'cartlify.newsletter_confirm(text, text, text)',
  'cartlify.newsletter_not_me(text, text, text)',
  'cartlify.newsletter_manage_get(text)',
  'cartlify.newsletter_manage_set_locale(text, text, text, text)',
  'cartlify.newsletter_manage_unsubscribe(text, integer, text, text, text)',
  'cartlify.newsletter_manage_resume(text, text, text)',
  // the button of the mail client: its own token, its own function
  'cartlify.newsletter_unsubscribe_one_click(text, integer, text, text)',
  'cartlify.newsletter_manage_export(text)',
  'cartlify.newsletter_subscribe_account(integer, text, text, text, text, text, text, text)',
  'cartlify.newsletter_profile_get(integer)',
  'cartlify.newsletter_profile_unsubscribe(integer, text, text)',
  'cartlify.newsletter_profile_set_locale(integer, text, text, text)',
  'cartlify.newsletter_profile_resume(integer, text, text)',
  'cartlify.newsletter_profile_export(integer)',
  'cartlify.newsletter_end_for_account(integer)',
  // the work of the system (a bounce, a spam report), of the people who run the newsletters (a
  // address erased, an address blocked) and of root (the right of an admin, the languages)
  'cartlify.newsletter_apply_event(integer, text, text)',
  'cartlify.newsletter_admin_erase_address(integer)',
  'cartlify.newsletter_block_add(text, text)',
  'cartlify.newsletter_set_manager(integer, boolean)',
  'cartlify.newsletter_locale_counts()',
  'cartlify.newsletter_reset_locale(text)',
  // the sending of the newsletters: the system starts a campaign, takes a portion of the mails and
  // gives back the ones it did not try
  'cartlify.newsletter_start_campaign(integer, jsonb, text)',
  'cartlify.newsletter_claim_recipients(integer, integer[], integer, integer)',
  'cartlify.newsletter_release_recipients(integer[])',
  'cartlify.confirm_order(integer, interval, numeric, numeric, numeric)',
  'cartlify.unconfirm_order(integer)',
  'cartlify.cancel_order_payment(integer)',
  'cartlify.pay_order(integer, cartlify."PaymentProvider", text, numeric)',
  'cartlify.expire_order_reservation(integer)',
  'cartlify.anonymize_login_logs(integer)',
  // maintenance the periodic tasks run as the system
  'cartlify.cleanup_user_tokens(integer)',
  'cartlify.cleanup_login_log_addresses()',
  'cartlify.cleanup_guest_data()',
  'cartlify.cleanup_deleted_accounts_chats()',
  'cartlify.cleanup_return_addresses()',
  'cartlify.cleanup_return_personal()',
  'cartlify.cleanup_deleted_accounts_recipients()',
  'cartlify.cleanup_newsletter_pending()',
  'cartlify.cleanup_newsletter_consent()',
  'cartlify.cleanup_newsletter_recipients()',
  'cartlify.refresh_order_prices(integer)',
  'cartlify.product_current_price(numeric, numeric, timestamp without time zone)',
  'cartlify.log_admin_action(integer, cartlify."Role", cartlify."AdminAuditEntityType", integer, cartlify."AdminAuditAction", text, jsonb)',
  // the shape of the value of a setting of the data of the shop (db/06, shop_settings_value_chk:
  // a CHECK constraint cannot hold a subquery, these run as the role that writes the row)
  'cartlify.shop_setting_value_valid(text, jsonb)',
  'cartlify.shop_setting_list_valid(jsonb, text)',
  'cartlify.log_variant_price_change(integer, numeric, numeric, cartlify."PriceChangeMode", numeric, text, timestamp without time zone)',
  'cartlify.receive_variant_batch(uuid, integer, cartlify."StockSource", integer, numeric, date, text, text, text, text)',
  'cartlify.write_off_variant_stock(uuid, integer, integer, integer, text, text)',
  'cartlify.shop_today()',
  'cartlify.withdrawal_ends_at(timestamp without time zone, integer, integer, text)',
  'cartlify.product_withdrawals(integer[])',
  'cartlify.create_return(integer, jsonb, cartlify."ReturnSource", cartlify."ReturnBasis", cartlify."ReturnReason", text, text, text, timestamp without time zone, integer, integer, text)',
  'cartlify.receive_return_items(integer, jsonb)',
  'cartlify.confirm_return_proof(integer)',
  'cartlify.provide_return_proof(integer, text, text, text)',
  'cartlify.record_return_shipment(integer, text, text, text, numeric, timestamp without time zone)',
  'cartlify.set_return_shipment_cost(integer, numeric)',
  'cartlify.begin_return_refund(integer, integer[], jsonb, numeric)',
  'cartlify.finish_return_refund(uuid, text, text, cartlify."ReturnRefundFailure", text)',
  'cartlify.mark_return_refunded_outside(integer, integer[], cartlify."ReturnOutsideMethod", text, timestamp without time zone)',
  'cartlify.close_return_without_refund(integer, integer[], cartlify."ReturnCloseCode", text)',
  'cartlify.record_return_reimbursement(integer, numeric, cartlify."ReturnOutsideMethod", text, timestamp without time zone)',
  'cartlify.settle_return_dispute(integer, boolean, text, timestamp without time zone)',
  'cartlify.accept_return(integer)',
  'cartlify.variant_display_name(integer)',
  'cartlify.variant_names(integer[])',
  'cartlify.variant_expired_units(integer)',
  'cartlify.units_sold_in_period(timestamp without time zone, timestamp without time zone)',
];

// the context readers rls policies call and the search helpers, all readonly may run
const READONLY_FUNCTIONS = [
  'cartlify.current_actor_id()',
  'cartlify.current_guest_id()',
  'cartlify.current_actor_role()',
  'cartlify.is_admin()',
  'cartlify.is_root()',
  'cartlify.is_system()',
  'cartlify.is_owner(integer)',
  'cartlify.is_owner_or_admin(integer)',
  // the policies of the newsletter tables ask these two; with no context both answer false
  'cartlify.newsletter_manager()',
  'cartlify.unaccent(text)',
  'cartlify.unaccent(regdictionary, text)',
  'cartlify.immutable_unaccent(text)',
];

// the tables of the shop; the prisma migration history is the owner's alone
const TABLES_SQL = `
  select c.oid, c.relname
  from pg_class c
  where c.relnamespace = 'cartlify'::regnamespace
    and c.relkind in ('r', 'p')
    and c.relname <> '_prisma_migrations'
`;

// a function that belongs to an extension (pg_trgm, unaccent) and not to the shop
const IS_EXTENSION_FUNCTION = `exists (
  select 1 from pg_depend d
  where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
)`;

const names = (rows: { name: string }[]) => rows.map((row) => row.name).sort();

// the listed functions the way the catalog names them, null for one that does not exist
const listed = async (db: DbSession, functions: string[]) =>
  (
    await db.rows<{ name: string | null }>(
      'select to_regprocedure(fn)::text as name from unnest($1::text[]) as f(fn)',
      functions,
    )
  ).map((row) => row.name);

const executable = (db: DbSession, role: string, opts: { extensions: boolean }) =>
  db.rows<{ name: string }>(
    `select p.oid::regprocedure::text as name
     from pg_proc p
     where p.pronamespace = 'cartlify'::regnamespace
       and has_function_privilege($1, p.oid, 'EXECUTE')
       ${opts.extensions ? '' : `and not ${IS_EXTENSION_FUNCTION}`}`,
    role,
  );

const tablePrivileges = (db: DbSession, role: string, privileges: string[]) =>
  db.rows<{ name: string }>(
    `select t.relname || ' ' || p.privilege as name
     from (${TABLES_SQL}) t
     cross join unnest($2::text[]) as p(privilege)
     where has_table_privilege($1, t.oid, p.privilege)`,
    role,
    privileges,
  );

const sequencePrivilege = (db: DbSession, role: string, privilege: string) =>
  db.rows<{ name: string }>(
    `select c.relname as name
     from pg_class c
     where c.relnamespace = 'cartlify'::regnamespace
       and c.relkind = 'S'
       and case when c.relkind = 'S' then has_sequence_privilege($1, c.oid, $2) else false end`,
    role,
    privilege,
  );

// rows in the five tables of the newsletters, committed (the functions of the database write them,
// a test makes them as the owner), so that "sees none" means the rows are there and hidden
let newsletters: NewsletterFixtures;

beforeAll(async () => {
  newsletters = await setupNewsletterFixtures();
});

afterAll(async () => {
  try {
    if (newsletters) await removeNewsletterFixtures(newsletters);
  } finally {
    await prisma.$disconnect();
  }
});

describe.each([APP, READONLY])('role %s', (role) => {
  it('is an ordinary role: no superuser, no bypass of rls, no roles or databases of its own', async () => {
    const [attributes] = await inRolledBackTx((db) =>
      db.rows(
        `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
         from pg_roles where rolname = $1`,
        role,
      ),
    );

    expect(attributes).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
    });
  });

  // a member of another role takes its rights with set role, the owner's would skip every policy
  it('is a member of no other role', async () => {
    const memberOf = await inRolledBackTx((db) =>
      db.rows<{ name: string }>(
        `select pg_get_userbyid(m.roleid) as name
         from pg_auth_members m
         where m.member = (select oid from pg_roles where rolname = $1)`,
        role,
      ),
    );

    expect(names(memberOf)).toEqual([]);
  });

  // the owner of a table is not held by its rls unless the table forces it, and may change it
  it('owns no schema, table, sequence, view or function', async () => {
    const owned = await inRolledBackTx((db) =>
      db.rows<{ name: string }>(
        `select 'schema ' || nspname as name from pg_namespace where pg_get_userbyid(nspowner) = $1
         union all
         select 'relation ' || relname from pg_class where pg_get_userbyid(relowner) = $1
         union all
         select 'function ' || proname from pg_proc where pg_get_userbyid(proowner) = $1`,
        role,
      ),
    );

    expect(names(owned)).toEqual([]);
  });

  it('may create nothing: no schema, and nothing in the schemas cartlify and public', async () => {
    const rights = await inRolledBackTx((db) =>
      db.rows(
        `select has_database_privilege($1, current_database(), 'CREATE') as database,
                has_schema_privilege($1, 'cartlify', 'CREATE') as cartlify,
                has_schema_privilege($1, 'public', 'CREATE') as public`,
        role,
      ),
    );

    expect(rights).toEqual([{ database: false, cartlify: false, public: false }]);
  });

  // truncate empties a table past its rls, references and trigger let a role hang its own
  // checks on the rows, maintain locks and rebuilds a table
  it('has no truncate, references, trigger or maintain right on a table', async () => {
    const extra = await inRolledBackTx((db) =>
      tablePrivileges(db, role, ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']),
    );

    expect(names(extra)).toEqual([]);
  });

  it('cannot read the prisma migration history', async () => {
    const [history] = await inRolledBackTx((db) =>
      db.rows(
        `select has_table_privilege($1, 'cartlify._prisma_migrations', 'SELECT') as can_read`,
        role,
      ),
    );

    expect(history).toEqual({ can_read: false });
  });
});

describe(`role ${APP}`, () => {
  // the timeout of a prisma transaction only stops the waiting of the app, the statement went on
  // in the database; a statement or an open transaction left behind ends on its own
  it('stops a statement after 15 s and a transaction left idle after 30 s', async () => {
    const settings = await inRolledBackTx((db) =>
      db.rows<{ statement: string; idle: string }>(
        `select current_setting('statement_timeout') as statement,
                current_setting('idle_in_transaction_session_timeout') as idle`,
      ),
    );

    expect(settings).toEqual([{ statement: '15s', idle: '30s' }]);
  });

  // the reports with many ctes got a high cost from their estimates and were compiled on every
  // call, which took far longer than running them
  it('runs its queries without jit', async () => {
    const settings = await inRolledBackTx((db) =>
      db.rows<{ jit: string }>(`select current_setting('jit') as jit`),
    );

    expect(settings).toEqual([{ jit: 'off' }]);
  });

  it('runs only the functions db/schema/01 opens for it, besides the extension functions', async () => {
    const { expected, actual } = await inRolledBackTx(async (db) => ({
      expected: await listed(db, APP_FUNCTIONS),
      actual: names(await executable(db, APP, { extensions: false })),
    }));

    expect(expected).not.toContain(null);
    expect(actual).toEqual([...(expected as string[])].sort());
  });

  // they run from triggers and system functions only, as the owner and past the policies
  it('cannot run a trigger function', async () => {
    const triggers = await inRolledBackTx((db) =>
      db.rows<{ name: string }>(
        `select p.oid::regprocedure::text as name
         from pg_proc p
         where p.pronamespace = 'cartlify'::regnamespace
           and p.prorettype = 'trigger'::regtype
           and has_function_privilege($1, p.oid, 'EXECUTE')`,
        APP,
      ),
    );

    expect(names(triggers)).toEqual([]);
  });

  it.each([
    ['take_from_batches', 'select * from cartlify.take_from_batches(1, 1, true)'],
    [
      'log_stock_change',
      `select cartlify.log_stock_change(1, 'stock.delivery', 1, 1, null, null, null, null)`,
    ],
    ['lock_return_order', 'select cartlify.lock_return_order(1)'],
    ['apply_return_results', `select cartlify.apply_return_results(1, '[]'::jsonb, 1)`],
    ['refresh_return_state', 'select cartlify.refresh_return_state(1)'],
    ['order_goods_on_shelf', `select cartlify.order_goods_on_shelf(1, 'paid')`],
    ['take_back_manual_units', 'select cartlify.take_back_manual_units(1, 1, 1, 1)'],
    ['assert_return_accepted', 'select cartlify.assert_return_accepted(1)'],
    ['return_units_to_batches', `select cartlify.return_units_to_batches(1, 1, 1, 1, 'to_stock')`],
    ['consume_variant_stock', 'select cartlify.consume_variant_stock(1, 1, 1)'],
    ['reserve_variant_stock', 'select cartlify.reserve_variant_stock(1, 1)'],
    ['release_variant_stock', 'select cartlify.release_variant_stock(1, 1)'],
    ['recalc_order_total', 'select cartlify.recalc_order_total(1)'],
    ['recalc_product_rating', 'select cartlify.recalc_product_rating(1)'],
    ['recalc_product_popularity', 'select cartlify.recalc_product_popularity(1)'],
    ['recalc_all_products_popularity', 'select cartlify.recalc_all_products_popularity()'],
    ['recalc_review_votes', 'select cartlify.recalc_review_votes(1)'],
  ])('is refused the internal function %s', async (_name, statement) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ROOT', userId: 1 });
      return db.attempt(statement);
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  it.each([
    ['a table', 'create table cartlify.db_rules_probe (id int)'],
    [
      'a function',
      `create function cartlify.db_rules_probe() returns int language sql as 'select 1'`,
    ],
    ['a schema', 'create schema db_rules_probe'],
    ['a table in public', 'create table public.db_rules_probe (id int)'],
  ])('is refused creating %s', async (_what, statement) => {
    const outcome = await inRolledBackTx((db) => db.attempt(statement));

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  it('is refused emptying a table with truncate', async () => {
    const outcome = await inRolledBackTx((db) => db.attempt('truncate cartlify.login_logs'));

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  it('is refused turning row level security off for itself', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.rows('set local row_security = off');
      return db.attempt('select count(*)::int as n from cartlify.users');
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  it.each([
    ['set role cartlify_owner'],
    ['set role postgres'],
    ['set session authorization cartlify_owner'],
  ])('is refused taking another role: %s', async (statement) => {
    const outcome = await inRolledBackTx((db) => db.attempt(statement));

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  // inserts take the next id with usage; setval needs update, and a sequence moved back makes
  // every insert of the table fail on a taken id
  it('takes ids from the sequences but cannot move them', async () => {
    const { taking, moving } = await inRolledBackTx(async (db) => ({
      taking: names(await sequencePrivilege(db, APP, 'USAGE')),
      moving: names(await sequencePrivilege(db, APP, 'UPDATE')),
    }));

    expect(taking.length).toBeGreaterThan(0);
    expect(moving).toEqual([]);
  });

  it('is refused moving a sequence back with setval', async () => {
    const outcome = await inRolledBackTx((db) =>
      db.attempt(`select setval('cartlify.orders_id_seq', 1)`),
    );

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });
});

// the tables of the newsletters are the owner's: a guest is shown no row of them and may write none
const NEWSLETTER_TABLES = [
  'newsletter_subscriptions',
  'newsletter_subscription_events',
  'newsletter_campaigns',
  'newsletter_recipients',
  'newsletter_form_blocklist',
];

describe(`role ${APP} as a guest`, () => {
  it.each(NEWSLETTER_TABLES)('sees none of the rows of %s, which hold some', async (table) => {
    const { held, seen } = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ROOT', userId: newsletters.root.id });
      const held = await db.rows<{ n: number }>(`select count(*)::int as n from cartlify.${table}`);

      await db.as({ role: 'GUEST', guestId: randomUUID() });
      const seen = await db.rows<{ n: number }>(`select count(*)::int as n from cartlify.${table}`);

      await db.as(null);
      const noContext = await db.rows<{ n: number }>(
        `select count(*)::int as n from cartlify.${table}`,
      );
      return { held, seen: [seen[0], noContext[0]] };
    });

    expect(held[0]!.n).toBeGreaterThan(0);
    expect(seen).toEqual([{ n: 0 }, { n: 0 }]);
  });
});

describe(`role ${READONLY}`, () => {
  it('runs only the context readers and the search helpers', async () => {
    const { expected, actual } = await inRolledBackTx(async (db) => ({
      expected: await listed(db, READONLY_FUNCTIONS),
      actual: names(await executable(db, READONLY, { extensions: true })),
    }));

    expect(expected).not.toContain(null);
    expect(actual).toEqual([...(expected as string[])].sort());
  });

  it('only reads the tables: no insert, update or delete', async () => {
    const { writes, reads } = await inRolledBackTx(async (db) => ({
      writes: names(await tablePrivileges(db, READONLY, ['INSERT', 'UPDATE', 'DELETE'])),
      reads: names(await tablePrivileges(db, READONLY, ['SELECT'])),
    }));

    expect(writes).toEqual([]);
    expect(reads.length).toBeGreaterThan(0);
  });

  // nextval changes the sequence, a role that only reads has no business there
  it('reads the sequences but takes no id from them', async () => {
    const { reading, taking, moving } = await inRolledBackTx(async (db) => ({
      reading: names(await sequencePrivilege(db, READONLY, 'SELECT')),
      taking: names(await sequencePrivilege(db, READONLY, 'USAGE')),
      moving: names(await sequencePrivilege(db, READONLY, 'UPDATE')),
    }));

    expect(reading.length).toBeGreaterThan(0);
    expect(taking).toEqual([]);
    expect(moving).toEqual([]);
  });

  // the policies of the newsletter tables ask who the actor is (root, the system, an owner of a
  // row, a manager of the newsletters); the role has no context, so every answer is false and it
  // reads the tables without opening a row
  // the tables hold committed rows (root counts them), and the role without a context is shown none
  it.each(NEWSLETTER_TABLES)(
    'reads %s without an error, and sees none of its rows',
    async (table) => {
      const held = await inRolledBackTx(async (db) => {
        await db.as({ role: 'ROOT', userId: newsletters.root.id });
        return db.rows<{ n: number }>(`select count(*)::int as n from cartlify.${table}`);
      });
      const seen = await inReadonlyTx((db) =>
        db.rows<{ n: number }>(`select count(*)::int as n from cartlify.${table}`),
      );

      expect(held[0]!.n).toBeGreaterThan(0);
      expect(seen).toEqual([{ n: 0 }]);
    },
  );
});

describe('every role the database does not name (public)', () => {
  it('has no right on the schema, a table, a sequence or a function of cartlify', async () => {
    const rights = await inRolledBackTx((db) =>
      db.rows<{ name: string }>(
        `select 'schema cartlify ' || a.privilege_type as name
         from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
         where n.nspname = 'cartlify' and a.grantee = 0
         union all
         select c.relname || ' ' || a.privilege_type
         from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         where c.relnamespace = 'cartlify'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S')
           and a.grantee = 0
         union all
         select p.oid::regprocedure::text || ' ' || a.privilege_type
         from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         where p.pronamespace = 'cartlify'::regnamespace and a.grantee = 0`,
      ),
    );

    expect(names(rights)).toEqual([]);
  });
});

describe('the tables, views and functions of cartlify', () => {
  // without force the owner, and so every system function, would skip the policies
  it('hold every table to row level security, the owner included', async () => {
    const loose = await inRolledBackTx((db) =>
      db.rows<{ name: string }>(
        `select t.relname as name
         from (${TABLES_SQL}) t
         join pg_class c on c.oid = t.oid
         where not (c.relrowsecurity and c.relforcerowsecurity)`,
      ),
    );

    expect(names(loose)).toEqual([]);
  });

  // a view reads with the rights of its owner unless it runs as the caller
  it('run every view as its caller, so the policies of the caller apply', async () => {
    const asOwner = await inRolledBackTx((db) =>
      db.rows<{ name: string }>(
        `select c.relname as name
         from pg_class c
         where c.relnamespace = 'cartlify'::regnamespace and c.relkind = 'v'
           and not coalesce('security_invoker=true' = any (c.reloptions), false)`,
      ),
    );

    expect(names(asOwner)).toEqual([]);
  });

  // a materialized view keeps a copy of the rows that no policy holds
  it('have no materialized view', async () => {
    const views = await inRolledBackTx((db) =>
      db.rows<{ name: string }>(
        `select relname as name from pg_class
         where relnamespace = 'cartlify'::regnamespace and relkind = 'm'`,
      ),
    );

    expect(names(views)).toEqual([]);
  });

  it('belong to cartlify_owner, besides the functions of the extensions', async () => {
    const foreign = await inRolledBackTx((db) =>
      db.rows<{ name: string }>(
        `select 'relation ' || c.relname || ' of ' || pg_get_userbyid(c.relowner) as name
         from pg_class c
         where c.relnamespace = 'cartlify'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S')
           and pg_get_userbyid(c.relowner) <> 'cartlify_owner'
         union all
         select 'function ' || p.oid::regprocedure::text || ' of ' || pg_get_userbyid(p.proowner)
         from pg_proc p
         where p.pronamespace = 'cartlify'::regnamespace and not ${IS_EXTENSION_FUNCTION}
           and pg_get_userbyid(p.proowner) <> 'cartlify_owner'`,
      ),
    );

    expect(names(foreign)).toEqual([]);
  });

  // the steps of the newsletters the app runs are the only way it reaches the tables of the
  // newsletters: each acts as the owner (security definer) and fixes its search path. A test that
  // calls one as the owner of the database would pass without either
  it('make every function of the newsletters the app may run act as the owner', async () => {
    const { runnable, loose } = await inRolledBackTx(async (db) => {
      const runnable = await db.rows<{ name: string }>(
        `select p.oid::regprocedure::text as name
         from pg_proc p
         where p.pronamespace = 'cartlify'::regnamespace
           and p.proname ~ '(^|_)newsletter\\_'
           and has_function_privilege('cartlify_app', p.oid, 'EXECUTE')`,
      );
      const loose = await db.rows<{ name: string }>(
        `select p.oid::regprocedure::text as name
         from pg_proc p
         where p.pronamespace = 'cartlify'::regnamespace
           and p.proname ~ '(^|_)newsletter\\_'
           and has_function_privilege('cartlify_app', p.oid, 'EXECUTE')
           and not (p.prosecdef and coalesce('search_path=cartlify, pg_temp' = any (p.proconfig), false))`,
      );
      return { runnable, loose };
    });

    // the 25 steps and the 3 cleanups of the list above, no fewer (the later steps add to them)
    expect(runnable.length).toBeGreaterThanOrEqual(28);
    expect(names(loose)).toEqual([]);
  });

  // a function that acts as the owner must not find a table or function of the caller first:
  // pg_temp goes last, after the schema of the shop
  it('fix the search path of every function that acts as its owner', async () => {
    const loose = await inRolledBackTx((db) =>
      db.rows<{ name: string }>(
        `select p.oid::regprocedure::text || ' ' || coalesce(array_to_string(p.proconfig, ';'), '-') as name
         from pg_proc p
         where p.pronamespace = 'cartlify'::regnamespace and p.prosecdef
           and not coalesce('search_path=cartlify, pg_temp' = any (p.proconfig), false)`,
      ),
    );

    expect(names(loose)).toEqual([]);
  });
});
