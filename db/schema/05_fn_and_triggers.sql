BEGIN;

-- on a live database a busy table makes the script wait for its lock, and every request of the
-- app waits behind the script: 5 s, then the script stops and is run again (db-run-sql.yml)
SET LOCAL lock_timeout = '5s';

-- everything below is created and owned by cartlify_owner, whoever runs the script
SET LOCAL ROLE cartlify_owner;

------------------------------------------------------------
-- CONTEXT HELPERS
------------------------------------------------------------
-- CONTEXT HELPERS === user actions ===
-- CONTEXT HELPERS set current actor context for rls checks
CREATE OR REPLACE FUNCTION cartlify.set_current_context (
  p_role cartlify."Role",
  p_user_id integer DEFAULT NULL,
  p_guest_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('cartlify.role', COALESCE(p_role::text, ''), true);

  PERFORM set_config('cartlify.user_id',  '', true);
  PERFORM set_config('cartlify.guest_id', '', true);

  IF p_role = 'GUEST' THEN
    PERFORM set_config('cartlify.guest_id', COALESCE(p_guest_id::text, ''), true);
  ELSE
    PERFORM set_config('cartlify.user_id', COALESCE(p_user_id::text, ''), true);
  END IF;
END;
$$;

-- CONTEXT HELPERS === system functions === 
-- CONTEXT HELPERS read current actor id from session context
CREATE OR REPLACE FUNCTION cartlify.current_actor_id () RETURNS integer LANGUAGE plpgsql STABLE AS $$
DECLARE
  uid_text text;
BEGIN
  uid_text := btrim(current_setting('cartlify.user_id', true));

  IF uid_text IS NULL OR uid_text = '' THEN
    RETURN NULL;
  END IF;

  IF uid_text ~ '^[0-9]+$' THEN
    RETURN uid_text::integer;
  END IF;

  RETURN NULL;
END;
$$;

-- CONTEXT HELPERS read current guest id from session context
CREATE OR REPLACE FUNCTION cartlify.current_guest_id () RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE gid_text text;
BEGIN
  gid_text := btrim(current_setting('cartlify.guest_id', true));
  IF gid_text IS NULL OR gid_text = '' THEN RETURN NULL; END IF;
  RETURN gid_text::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;

-- CONTEXT HELPERS read current actor role from session context
CREATE OR REPLACE FUNCTION cartlify.current_actor_role () RETURNS cartlify."Role" LANGUAGE plpgsql STABLE AS $$
DECLARE
  role_text text;
BEGIN
  role_text := btrim(current_setting('cartlify.role', true));

  IF role_text IS NULL OR role_text = '' THEN
    RETURN NULL;
  END IF;

  IF role_text IN ('GUEST', 'USER', 'ADMIN', 'ROOT') THEN
    RETURN role_text::cartlify."Role";
  END IF;

  RETURN NULL;
END;
$$;

-- CONTEXT HELPERS check whether current actor is admin or root
CREATE OR REPLACE FUNCTION cartlify.is_admin () RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  a_role cartlify."Role";
BEGIN
  a_role := cartlify.current_actor_role();

  IF a_role IS NULL THEN
    RETURN false;
  END IF;

  RETURN a_role IN ('ADMIN', 'ROOT');
END;
$$;

-- CONTEXT HELPERS check whether current actor is root
CREATE OR REPLACE FUNCTION cartlify.is_root () RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  a_role cartlify."Role";
BEGIN
  a_role := cartlify.current_actor_role();

  IF a_role IS NULL THEN
    RETURN false;
  END IF;

  RETURN a_role = 'ROOT';
END;
$$;

-- CONTEXT HELPERS check whether the server acts as the system: the admin role without a user id,
-- the way setAdminContext sets it (the payment webhook, the reservation worker, the password
-- reset); a signed-in admin always comes with an id
CREATE OR REPLACE FUNCTION cartlify.is_system () RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN cartlify.current_actor_role() IS NOT DISTINCT FROM 'ADMIN'
    AND cartlify.current_actor_id() IS NULL;
END;
$$;

-- CONTEXT HELPERS check whether current actor owns the target row
CREATE OR REPLACE FUNCTION cartlify.is_owner (p_user_id integer) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  a_id integer;
BEGIN
  a_id := cartlify.current_actor_id();

  IF a_id IS NULL OR p_user_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN a_id = p_user_id;
END;
$$;

-- CONTEXT HELPERS check whether current actor owns the target row or has admin access
CREATE OR REPLACE FUNCTION cartlify.is_owner_or_admin (p_user_id integer) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN cartlify.is_admin() OR cartlify.is_owner(p_user_id);
END;
$$;

------------------------------------------------------------
-- AUTH AND USERS
------------------------------------------------------------
-- AUTH AND USERS === user actions ===
-- AUTH AND USERS fetch user credentials by email for login flow
-- system function: runs as the owner, a guest cannot read users;
-- callable only by a guest, a login always starts from the guest context
CREATE OR REPLACE FUNCTION cartlify.auth_get_user_for_login (p_email text) RETURNS TABLE (
  id int,
  password_hash text,
  role cartlify."Role",
  is_verified boolean,
  auth_provider cartlify."AuthProvider"
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  IF cartlify.current_actor_role() IS DISTINCT FROM 'GUEST' THEN
    RAISE EXCEPTION 'LOGIN_LOOKUP_FORBIDDEN';
  END IF;

  RETURN QUERY
  SELECT u.id, u."passwordHash", u.role, u."isVerified", u."authProvider"
  FROM cartlify.users u
  WHERE u.email = lower(btrim(p_email))
  LIMIT 1;

END;
$$;

-- temporary: the result of users_get_public_profile changed (20.10.2026, the fields of an admin),
-- create or replace cannot change a result, so the old version goes first; it takes the rights
-- with it until db/01 runs again. Remove once dev and prod match the structure snapshot
DO $$
BEGIN
  IF to_regprocedure('cartlify.users_get_public_profile(integer)') IS NOT NULL
     AND position('deleted_at' IN pg_get_function_result(
       to_regprocedure('cartlify.users_get_public_profile(integer)'))) = 0
  THEN
    DROP FUNCTION cartlify.users_get_public_profile (integer);
  END IF;
END
$$;

-- AUTH AND USERS fetch the profile of a user by user id
-- system function: runs as the owner, rls shows a user only their own row;
-- callable only by a signed-in user, admin or root, never by a guest.
-- A user gets the name, the avatar and the dates, the other fields are null, the own email too
-- (a user reads it in /users/me). An admin or root gets the whole profile. The password hash, the
-- provider id and the id of the avatar file are no field of it. A deleted account is no row for
-- anybody but an admin or root
CREATE OR REPLACE FUNCTION cartlify.users_get_public_profile (p_user_id int) RETURNS TABLE (
  id int,
  created_at timestamptz,
  updated_at timestamptz,
  name text,
  avatar_url text,
  -- admin or root only
  email text,
  role cartlify."Role",
  auth_provider cartlify."AuthProvider",
  is_verified boolean,
  locale text,
  phone text,
  deleted_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_admin boolean;
BEGIN
  IF cartlify.current_actor_role() IS NULL
     OR cartlify.current_actor_role() NOT IN ('USER', 'ADMIN', 'ROOT')
     OR cartlify.current_actor_id() IS NULL
  THEN
    RAISE EXCEPTION 'USER_PROFILE_READ_FORBIDDEN';
  END IF;

  v_admin := cartlify.is_admin();

  -- prisma keeps dates as utc in columns without a time zone, the result type wants
  -- timestamptz, so they are read as utc
  RETURN QUERY
  SELECT
    u.id,
    u."createdAt" AT TIME ZONE 'UTC',
    u."updatedAt" AT TIME ZONE 'UTC',
    u.name,
    u."avatarUrl",
    CASE WHEN v_admin THEN u.email END,
    CASE WHEN v_admin THEN u.role END,
    CASE WHEN v_admin THEN u."authProvider" END,
    CASE WHEN v_admin THEN u."isVerified" END,
    CASE WHEN v_admin THEN u.locale END,
    CASE WHEN v_admin THEN u.phone END,
    CASE WHEN v_admin THEN u."deletedAt" AT TIME ZONE 'UTC' END
  FROM cartlify.users u
  WHERE u.id = p_user_id
    AND (v_admin OR u."deletedAt" IS NULL)
  LIMIT 1;

END;
$$;

-- temporary: the result of remove_user_avatar changed (23.10.2026, whether it took an avatar), create
-- or replace cannot change a result, so the old version goes first; it takes the rights with it
-- until db/01 runs again. Remove once dev and prod match the structure snapshot
DO $$
BEGIN
  IF to_regprocedure('cartlify.remove_user_avatar(integer)') IS NOT NULL
     AND position('removed' IN pg_get_function_result(
       to_regprocedure('cartlify.remove_user_avatar(integer)'))) = 0
  THEN
    DROP FUNCTION cartlify.remove_user_avatar (integer);
  END IF;
END
$$;

-- AUTH AND USERS take the avatar of another account away (moderation)
-- system function: runs as the owner, db/03 lets only root change the row of another account;
-- callable by a signed-in admin or root, with an id, never by the system. An admin takes the
-- avatar of a USER account only, root of any account; the own avatar goes through PATCH
-- /api/users/me. Only the avatar fields of the row change. The result says whether it took an
-- avatar, read under the lock of the row, with the id of its file (the server deletes it after
-- the commit) and its address; removed false when the account had none
CREATE OR REPLACE FUNCTION cartlify.remove_user_avatar (p_user_id integer) RETURNS TABLE (
  removed boolean,
  public_id text,
  avatar_url text
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_role cartlify."Role";
  v_avatar_url text;
  v_public_id text;
BEGIN
  IF NOT cartlify.is_admin() OR cartlify.current_actor_id() IS NULL THEN
    RAISE EXCEPTION 'USER_AVATAR_REMOVE_FORBIDDEN';
  END IF;

  SELECT u.role, u."avatarUrl", u."publicId"
  INTO v_role, v_avatar_url, v_public_id
  FROM cartlify.users AS u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  IF v_role <> 'USER' AND NOT cartlify.is_root() THEN
    RAISE EXCEPTION 'USER_AVATAR_REMOVE_FORBIDDEN';
  END IF;

  -- read under the lock: of two moderators at once the second finds no avatar and takes nothing
  IF v_avatar_url IS NULL AND v_public_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- prisma keeps dates as utc in columns without a time zone
  UPDATE cartlify.users AS u
  SET
    "avatarUrl" = NULL,
    "publicId" = NULL,
    "updatedAt" = now() AT TIME ZONE 'UTC'
  WHERE u.id = p_user_id;

  RETURN QUERY SELECT true, v_public_id, v_avatar_url;
END;
$$;

------------------------------------------------------------
-- AUTH AND USER TOKENS
------------------------------------------------------------
-- AUTH AND USER TOKENS === system functions === 
-- AUTH AND USER TOKENS issue a new email verification link
-- system function: runs as the owner, a guest cannot read users or write tokens;
-- callable only by a guest, a user asks for a new link before the first login.
-- p_token is the hash of the new link, the database never keeps the link itself, so an earlier
-- link cannot be mailed again: every call closes the open links and stores the new one
CREATE OR REPLACE FUNCTION cartlify.auth_resend_verify (
  p_email text,
  p_token text,
  p_expires_at timestamptz
) RETURNS TABLE (user_id int, token text, expires_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_user_id int;
  v_is_verified boolean;
BEGIN
  IF cartlify.current_actor_role() IS DISTINCT FROM 'GUEST' THEN
    RAISE EXCEPTION 'VERIFY_RESEND_FORBIDDEN';
  END IF;

  -- normalize + validate inputs
  p_email := lower(btrim(p_email));
  p_token := btrim(p_token);

  IF p_email IS NULL OR p_email = '' THEN RETURN; END IF;
  IF p_token IS NULL OR p_token = '' THEN RETURN; END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN RETURN; END IF;

  -- find user
  SELECT u.id, u."isVerified"
    INTO v_user_id, v_is_verified
  FROM cartlify.users u
  WHERE u.email = p_email
  LIMIT 1;

  IF v_user_id IS NULL OR v_is_verified IS TRUE THEN
    RETURN;
  END IF;

  -- only the newest link works: the open ones are closed
  UPDATE cartlify.user_tokens ut
  SET "usedAt" = now()
  WHERE ut."userId" = v_user_id
    AND ut.type = 'VERIFY_EMAIL'::cartlify."UserTokenType"
    AND ut."usedAt" IS NULL;

  INSERT INTO cartlify.user_tokens ("userId", type, token, "expiresAt", "usedAt")
  VALUES (v_user_id, 'VERIFY_EMAIL'::cartlify."UserTokenType", p_token, p_expires_at, NULL);

  user_id := v_user_id;
  token := p_token;
  expires_at := p_expires_at;
  RETURN NEXT;
END;
$$;

-- AUTH AND USER TOKENS consume email verification token and mark user as verified
-- system function: runs as the owner, a guest cannot read tokens or verify a user;
-- callable only by a guest, the link from the email is opened before the first login;
-- p_token is the hash of the link, the same value the registration and the resend store
CREATE OR REPLACE FUNCTION cartlify.auth_verify_email (p_token text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_user_id int;
BEGIN
  IF cartlify.current_actor_role() IS DISTINCT FROM 'GUEST' THEN
    RAISE EXCEPTION 'VERIFY_EMAIL_FORBIDDEN';
  END IF;

  p_token := btrim(p_token);
  IF p_token IS NULL OR p_token = '' THEN
    RETURN false;
  END IF;

  BEGIN

    SELECT ut."userId"
      INTO v_user_id
    FROM cartlify.user_tokens ut
    WHERE ut.token = p_token
      AND ut.type = 'VERIFY_EMAIL'::cartlify."UserTokenType"
      AND ut."usedAt" IS NULL
      AND ut."expiresAt" > now()
    LIMIT 1;

    IF v_user_id IS NULL THEN

      RETURN false;
    END IF;

    UPDATE cartlify.user_tokens
    SET "usedAt" = now()
    WHERE token = p_token
      AND type = 'VERIFY_EMAIL'::cartlify."UserTokenType"
      AND "usedAt" IS NULL;

    UPDATE cartlify.users
    SET "isVerified" = true,
        "updatedAt" = now()
    WHERE id = v_user_id
      AND "isVerified" = false;

    RETURN true;

  EXCEPTION WHEN OTHERS THEN

    RAISE;
  END;
END;
$$;

-- AUTH AND USERS === triggers ===
-- AUTH AND USERS keep the email in small letters without spaces around: the login and the
-- password reset look an account up in that form, and the unique email then holds one account
-- per address. An email that stays as it is is not touched, older rows keep theirs
CREATE OR REPLACE FUNCTION cartlify.users_before_write_email () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email := lower(btrim(NEW.email));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_before_write_email ON cartlify.users;

CREATE TRIGGER trg_users_before_write_email
BEFORE INSERT OR UPDATE OF email ON cartlify.users FOR EACH ROW
EXECUTE FUNCTION cartlify.users_before_write_email ();

------------------------------------------------------------
-- CATEGORIES
------------------------------------------------------------
-- CATEGORIES === triggers ===
-- CATEGORIES the tree goes one way, from the top down: a category never goes inside its own
-- branch (under itself or under one of its subcategories), that would make a loop with no top.
-- The changes of the tree wait for each other (a lock for the transaction), so two moves at the
-- same time cannot make a loop that neither of them makes alone. The walk up stops at a row it
-- has seen, so a loop written before this rule cannot hold it forever
CREATE OR REPLACE FUNCTION cartlify.categories_before_parent_change () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."parentId" IS NULL THEN
    RETURN NEW;
  END IF;

  -- a new row is not in the table yet, the walk up would not find it
  IF NEW."parentId" = NEW.id THEN
    RAISE EXCEPTION 'CATEGORY_PARENT_CYCLE';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cartlify.categories.tree'));

  IF EXISTS (
    WITH RECURSIVE up AS (
      SELECT c.id, c."parentId"
      FROM cartlify.categories AS c
      WHERE c.id = NEW."parentId"
      UNION
      SELECT c.id, c."parentId"
      FROM cartlify.categories AS c
      JOIN up ON c.id = up."parentId"
    )
    SELECT 1
    FROM up
    WHERE up.id = NEW.id
  ) THEN
    RAISE EXCEPTION 'CATEGORY_PARENT_CYCLE';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_categories_before_parent_change ON cartlify.categories;

CREATE TRIGGER trg_categories_before_parent_change
BEFORE INSERT OR UPDATE OF "parentId" ON cartlify.categories FOR EACH ROW
EXECUTE FUNCTION cartlify.categories_before_parent_change ();

------------------------------------------------------------
-- PRODUCTS
------------------------------------------------------------
-- PRODUCTS === prices ===
-- PRODUCTS the price a product sells at now: the sale price while the sale is ahead of its end,
-- the price otherwise. A sale that is over keeps its fields until the next sale writes over them
-- or the price goes down to them (products_before_price_change), it is no price any more. The
-- order items, the reservation check of a confirm and the catalog (sort, filter) take this price.
-- Prisma keeps dates as utc in columns without a time zone, so the end is compared in utc
CREATE OR REPLACE FUNCTION cartlify.product_current_price (
  p_price numeric,
  p_sale_price numeric,
  p_sale_ends_at timestamp
) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_sale_price IS NOT NULL AND p_sale_ends_at > (now() AT TIME ZONE 'UTC') THEN p_sale_price
    ELSE p_price
  END
$$;

-- PRODUCTS === system functions ===
-- PRODUCTS recalc product rating from reviews
-- internal: only the reviews rating trigger calls it, the app has no execute right (db/01)
CREATE OR REPLACE FUNCTION cartlify.recalc_product_rating (p_product_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_avg   numeric(3, 2);
  v_count integer;
BEGIN
  SELECT
    COALESCE((AVG(r.rating) FILTER (WHERE r."rating" IS NOT NULL))::numeric(3, 2), 0),
    (COUNT(*) FILTER (WHERE r."comment" IS NOT NULL AND btrim(r."comment") <> ''))::integer
  INTO v_avg, v_count
  FROM cartlify.reviews AS r
  WHERE r."productId" = p_product_id;

  UPDATE cartlify.products AS p
  SET
    "avgRating"    = v_avg,
    "reviewsCount" = v_count
  WHERE p.id = p_product_id;
END;
$$;

-- PRODUCTS the stock of a product is what its batches have left; every step that changes one
-- changes the other in the same transaction: a batch taken in, a sale, a write-off, a cancel.
-- Only the functions below change them, the batches and the stock are closed for plain changes
-- (db/03). Costs go into the admin log as the app writes them (trim_scale, 1.50 is 1.5)

-- the version that put units back without a batch; a temporary line, it goes once dev and prod
-- match the reference
DROP FUNCTION IF EXISTS cartlify.add_product_stock (integer, integer);

-- PRODUCTS the day of the shop: the server sets it with the context of every transaction
-- (cartlify.shop_today, yyyy-mm-dd, by the time zone of the shop); without it the day of utc.
-- It says which batches are over, it is no right of anybody: the policies never read it
CREATE OR REPLACE FUNCTION cartlify.shop_today () RETURNS date LANGUAGE sql STABLE
SET
  search_path = cartlify,
  pg_temp AS $$
  SELECT COALESCE(
    NULLIF(current_setting('cartlify.shop_today', true), '')::date,
    (now() AT TIME ZONE 'UTC')::date
  );
$$;

-- PRODUCTS the units of a product in batches whose last good day is over: they are not sold, so
-- they are no free units; an admin writes them off. Runs as the owner: a buyer sees no batch
CREATE OR REPLACE FUNCTION cartlify.product_expired_units (p_product_id integer) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
  SELECT COALESCE(SUM(b.remaining), 0)::integer
  FROM cartlify.product_batches AS b
  WHERE b."productId" = p_product_id
    AND b.remaining > 0
    AND b."expiresAt" < cartlify.shop_today();
$$;

-- PRODUCTS take units out of the batches of a product: the batch that ends first, then the ones
-- without an end, the oldest first; returns what each batch gave and its cost of a unit. A sale
-- skips the batches that are over (p_skip_expired), a write-off takes them first
-- internal step: runs with caller rights, only the system functions reach the batches (db/03);
-- the app has no execute right (db/01). The caller holds the lock of the product row

-- the version that took the batches that are over in a sale too; a temporary line, it goes once
-- dev and prod match the reference
DROP FUNCTION IF EXISTS cartlify.take_from_batches (integer, integer);

CREATE OR REPLACE FUNCTION cartlify.take_from_batches (
  p_product_id integer,
  p_qty integer,
  p_skip_expired boolean
) RETURNS TABLE (
  taken_batch_id integer,
  taken_quantity integer,
  taken_unit_cost numeric
) LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_left integer := p_qty;
  v_take integer;
  v_today date := cartlify.shop_today();

  r record;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'STOCK_QTY_INVALID';
  END IF;

  FOR r IN
    SELECT b.id, b.remaining, b."unitCost"
    FROM cartlify.product_batches AS b
    WHERE b."productId" = p_product_id
      AND b.remaining > 0
      AND (NOT p_skip_expired OR b."expiresAt" IS NULL OR b."expiresAt" >= v_today)
    ORDER BY b."expiresAt" ASC NULLS LAST, b."createdAt" ASC, b.id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_left = 0;

    v_take := LEAST(v_left, r.remaining);

    UPDATE cartlify.product_batches AS b
    SET remaining = b.remaining - v_take
    WHERE b.id = r.id;

    taken_batch_id := r.id;
    taken_quantity := v_take;
    taken_unit_cost := r."unitCost";
    RETURN NEXT;

    v_left := v_left - v_take;
  END LOOP;

  -- the stock is the sum of the batches: less in them than the stock says is a broken state
  IF v_left > 0 THEN
    RAISE EXCEPTION 'PRODUCT_BATCHES_SHORT';
  END IF;
END;
$$;

-- PRODUCTS put the units of a cancelled paid order back into the batches they came from
-- internal step: runs with caller rights; cancel_paid_order calls it as the owner. The lines of
-- the allocations stay: the reports take the cost back from the time of the cancel
CREATE OR REPLACE FUNCTION cartlify.return_order_stock (p_order_id integer) RETURNS void LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  r record;
BEGIN
  -- every unit a paid order sold came from a batch; an order paid before the batches has none
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT oi."productId" AS product_id, SUM(oi.quantity) AS qty
      FROM cartlify.order_items AS oi
      WHERE oi."orderId" = p_order_id
      GROUP BY oi."productId"
    ) AS i
    LEFT JOIN (
      SELECT a."productId" AS product_id, SUM(a.quantity) AS qty
      FROM cartlify.order_batch_allocations AS a
      WHERE a."orderId" = p_order_id
      GROUP BY a."productId"
    ) AS a ON a.product_id = i.product_id
    WHERE a.qty IS DISTINCT FROM i.qty
  ) THEN
    RAISE EXCEPTION 'ORDER_ALLOCATIONS_MISSING';
  END IF;

  -- the products in a deterministic lock order by id, then their batches
  FOR r IN
    SELECT a."productId" AS product_id,
           SUM(a.quantity)::integer AS qty
    FROM cartlify.order_batch_allocations AS a
    WHERE a."orderId" = p_order_id
    GROUP BY a."productId"
    ORDER BY a."productId"
  LOOP
    UPDATE cartlify.products AS p
    SET "stock" = p."stock" + r.qty
    WHERE p.id = r.product_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;
  END LOOP;

  UPDATE cartlify.product_batches AS b
  SET remaining = b.remaining + a.quantity
  FROM cartlify.order_batch_allocations AS a
  WHERE a."orderId" = p_order_id
    AND b.id = a."batchId";
END;
$$;

-- PRODUCTS take in a batch of a product: the stock grows by it, the admin log keeps the line
-- (STOCK_DELIVERY) with the delivery it came with, the supplier, the invoice and the note
-- system function: runs as the owner, the batches and the stock are closed for plain changes
-- (db/03); callable only by a signed-in admin or root, the line of the log is in their name.
-- A product removed from the catalog takes in nothing
CREATE OR REPLACE FUNCTION cartlify.receive_product_batch (
  p_delivery_id uuid,
  p_product_id integer,
  p_source cartlify."StockSource",
  p_quantity integer,
  p_unit_cost numeric,
  p_expires_at date,
  p_supplier_batch_number text,
  p_supplier text,
  p_document text,
  p_note text
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor_id integer := cartlify.current_actor_id();
  v_number   text := NULLIF(btrim(p_supplier_batch_number), '');
  v_supplier text := NULLIF(btrim(p_supplier), '');
  v_document text := NULLIF(btrim(p_document), '');
  v_note     text := NULLIF(btrim(p_note), '');
  v_stock    integer;
  v_batch_id integer;
BEGIN
  IF v_actor_id IS NULL OR NOT cartlify.is_admin() THEN
    RAISE EXCEPTION 'STOCK_RECEIVE_FORBIDDEN';
  END IF;

  IF p_delivery_id IS NULL OR p_source IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_INVALID';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'BATCH_QUANTITY_INVALID';
  END IF;

  -- a cost in cents, of the currency of the shop; a gift or a sample costs 0
  IF p_unit_cost IS NULL OR p_unit_cost < 0 OR p_unit_cost <> round(p_unit_cost, 2) THEN
    RAISE EXCEPTION 'BATCH_UNIT_COST_INVALID';
  END IF;

  -- the last good day is today or later, by the calendar of the shop
  IF p_expires_at IS NOT NULL AND p_expires_at < cartlify.shop_today() THEN
    RAISE EXCEPTION 'BATCH_EXPIRES_AT_INVALID';
  END IF;

  IF char_length(v_supplier) > 200
     OR char_length(v_document) > 100
     OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'STOCK_TEXT_TOO_LONG';
  END IF;

  -- lock product row
  SELECT p."stock"
  INTO v_stock
  FROM cartlify.products AS p
  WHERE p.id = p_product_id
    AND p."deletedAt" IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  INSERT INTO cartlify.product_batches (
    "productId",
    "deliveryId",
    source,
    "supplierBatchNumber",
    "unitCost",
    quantity,
    remaining,
    "expiresAt"
  )
  VALUES (
    p_product_id,
    p_delivery_id,
    p_source,
    v_number,
    p_unit_cost,
    p_quantity,
    p_quantity,
    p_expires_at
  )
  RETURNING id INTO v_batch_id;

  UPDATE cartlify.products AS p
  SET "stock" = v_stock + p_quantity
  WHERE p.id = p_product_id;

  PERFORM cartlify.log_admin_action(
    v_actor_id,
    cartlify.current_actor_role(),
    'product',
    p_product_id,
    'STOCK_DELIVERY',
    jsonb_build_array(
      jsonb_build_object('field', 'stock', 'old', v_stock, 'new', v_stock + p_quantity),
      jsonb_build_object(
        'field', 'batch',
        'old', NULL,
        'new', jsonb_build_object(
          'id', v_batch_id,
          'source', p_source,
          'quantity', p_quantity,
          'unitCost', trim_scale(p_unit_cost)::text,
          'expiresAt', to_char(p_expires_at, 'YYYY-MM-DD'),
          'supplierBatchNumber', v_number
        )
      ),
      jsonb_build_object('field', 'delivery', 'old', NULL, 'new', p_delivery_id)
    )
    || CASE WHEN v_supplier IS NULL THEN '[]'::jsonb
         ELSE jsonb_build_array(jsonb_build_object('field', 'supplier', 'old', NULL, 'new', v_supplier))
       END
    || CASE WHEN v_document IS NULL THEN '[]'::jsonb
         ELSE jsonb_build_array(jsonb_build_object('field', 'document', 'old', NULL, 'new', v_document))
       END
    || CASE WHEN v_note IS NULL THEN '[]'::jsonb
         ELSE jsonb_build_array(jsonb_build_object('field', 'note', 'old', NULL, 'new', v_note))
       END
  );

  RETURN v_batch_id;
END;
$$;

-- PRODUCTS write off free units of a product: from the batch an admin names, or from the batches
-- in the order a sale takes them (the one that ends first, then the oldest). The admin log keeps
-- the line (STOCK_WRITE_OFF) with the reason, the batches and their costs. A product removed
-- from the catalog keeps its units until they are written off, so it is written off too; the
-- units the waiting orders hold are not
-- system function: runs as the owner; callable only by a signed-in admin or root
CREATE OR REPLACE FUNCTION cartlify.write_off_product_stock (
  p_write_off_id uuid,
  p_product_id integer,
  p_batch_id integer,
  p_quantity integer,
  p_reason text,
  p_note text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor_id  integer := cartlify.current_actor_id();
  v_note      text := NULLIF(btrim(p_note), '');
  v_stock     integer;
  v_reserved  integer;
  v_remaining integer;
  v_cost      numeric;
  v_expires   date;
  v_taken     jsonb;
BEGIN
  IF v_actor_id IS NULL OR NOT cartlify.is_admin() THEN
    RAISE EXCEPTION 'STOCK_WRITE_OFF_FORBIDDEN';
  END IF;

  IF p_write_off_id IS NULL THEN
    RAISE EXCEPTION 'WRITE_OFF_INVALID';
  END IF;

  -- shortage: what an inventory did not find; returned_to_supplier: goods sent back
  IF p_reason IS NULL
     OR p_reason NOT IN ('damaged', 'defective', 'expired', 'shortage', 'returned_to_supplier', 'other') THEN
    RAISE EXCEPTION 'WRITE_OFF_REASON_INVALID';
  END IF;

  IF p_reason = 'other' AND v_note IS NULL THEN
    RAISE EXCEPTION 'WRITE_OFF_NOTE_REQUIRED';
  END IF;

  IF char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'STOCK_TEXT_TOO_LONG';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'WRITE_OFF_QUANTITY_INVALID';
  END IF;

  -- lock product row
  SELECT p."stock", p."reservedStock"
  INTO v_stock, v_reserved
  FROM cartlify.products AS p
  WHERE p.id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  IF v_stock - v_reserved < p_quantity THEN
    RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_STOCK';
  END IF;

  IF p_batch_id IS NOT NULL THEN
    SELECT b.remaining, b."unitCost", b."expiresAt"
    INTO v_remaining, v_cost, v_expires
    FROM cartlify.product_batches AS b
    WHERE b.id = p_batch_id
      AND b."productId" = p_product_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'BATCH_NOT_FOUND';
    END IF;

    IF v_remaining < p_quantity THEN
      RAISE EXCEPTION 'BATCH_INSUFFICIENT';
    END IF;

    -- the reserve of the waiting orders is of good units: a good batch named here gives only
    -- the good units no order holds. A batch that is over, or units without a batch (those
    -- that are over go first), leave the good units the reserve needs
    IF (v_expires IS NULL OR v_expires >= cartlify.shop_today())
       AND v_stock - cartlify.product_expired_units(p_product_id) - v_reserved < p_quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_STOCK';
    END IF;

    UPDATE cartlify.product_batches AS b
    SET remaining = b.remaining - p_quantity
    WHERE b.id = p_batch_id;

    v_taken := jsonb_build_array(
      jsonb_build_object(
        'batchId', p_batch_id,
        'quantity', p_quantity,
        'unitCost', trim_scale(v_cost)::text
      )
    );
  ELSE
    SELECT jsonb_agg(
             jsonb_build_object(
               'batchId', t.taken_batch_id,
               'quantity', t.taken_quantity,
               'unitCost', trim_scale(t.taken_unit_cost)::text
             )
             ORDER BY t.n
           )
    INTO v_taken
    FROM cartlify.take_from_batches(p_product_id, p_quantity, false)
      WITH ORDINALITY AS t(taken_batch_id, taken_quantity, taken_unit_cost, n);
  END IF;

  UPDATE cartlify.products AS p
  SET "stock" = v_stock - p_quantity
  WHERE p.id = p_product_id;

  PERFORM cartlify.log_admin_action(
    v_actor_id,
    cartlify.current_actor_role(),
    'product',
    p_product_id,
    'STOCK_WRITE_OFF',
    jsonb_build_array(
      jsonb_build_object('field', 'stock', 'old', v_stock, 'new', v_stock - p_quantity),
      jsonb_build_object('field', 'reason', 'old', NULL, 'new', p_reason),
      jsonb_build_object('field', 'batches', 'old', NULL, 'new', v_taken),
      jsonb_build_object('field', 'writeOff', 'old', NULL, 'new', p_write_off_id)
    )
    || CASE WHEN v_note IS NULL THEN '[]'::jsonb
         ELSE jsonb_build_array(jsonb_build_object('field', 'note', 'old', NULL, 'new', v_note))
       END
  );

  RETURN v_taken;
END;
$$;

-- PRODUCTS the stock is what the batches have left: checked at the end of the transaction, a step
-- changes the stock and the batches one after the other. Rows copied in without batches (dev
-- restored from a copy of prod, reseed) stop at their next change; their data are wiped
CREATE OR REPLACE FUNCTION cartlify.check_product_stock_batches () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_product_id integer;
  v_stock      integer;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    v_product_id := NEW.id;
  ELSE
    v_product_id := NEW."productId";
  END IF;

  SELECT p."stock"
  INTO v_stock
  FROM cartlify.products AS p
  WHERE p.id = v_product_id;

  -- a product removed for good in the same transaction takes its batches with it
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_stock <> (
    SELECT COALESCE(SUM(b.remaining), 0)
    FROM cartlify.product_batches AS b
    WHERE b."productId" = v_product_id
  ) THEN
    RAISE EXCEPTION 'PRODUCT_STOCK_BATCHES_MISMATCH'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_stock_batches ON cartlify.products;

CREATE CONSTRAINT TRIGGER trg_products_stock_batches
AFTER INSERT OR UPDATE OF "stock" ON cartlify.products
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION cartlify.check_product_stock_batches ();

DROP TRIGGER IF EXISTS trg_product_batches_stock ON cartlify.product_batches;

CREATE CONSTRAINT TRIGGER trg_product_batches_stock
AFTER INSERT OR UPDATE OF remaining ON cartlify.product_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION cartlify.check_product_stock_batches ();

-- PRODUCTS reserve product stock for order confirmation
-- internal step: runs with caller rights, so only system functions pass rls on stock columns;
-- the app has no execute right (db/01), confirm_order and pay_order call it as the owner
CREATE OR REPLACE FUNCTION cartlify.reserve_product_stock (p_product_id int, p_qty int) RETURNS void LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  -- validate input
  IF p_product_id IS NULL OR p_product_id <= 0 THEN
    RAISE EXCEPTION 'PRODUCT_ID_INVALID';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'RESERVE_QTY_INVALID';
  END IF;

  -- reserve only available stock: the units of batches that are over are not sold
  UPDATE cartlify.products p
  SET "reservedStock" = p."reservedStock" + p_qty
  WHERE p.id = p_product_id
    AND p."deletedAt" IS NULL
    AND (p.stock - p."reservedStock" - cartlify.product_expired_units(p.id)) >= p_qty;

  -- nothing updated
  IF NOT FOUND THEN
    -- distinguish not found from insufficient stock
    IF NOT EXISTS (
      SELECT 1
      FROM cartlify.products p
      WHERE p.id = p_product_id
        AND p."deletedAt" IS NULL
    ) THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_STOCK';
  END IF;
END;
$$;

-- PRODUCTS release stock after unconfirm or expiration
-- internal step: runs with caller rights, so only system functions pass rls on stock columns;
-- the app has no execute right (db/01), unconfirm_order and expire_order_reservation call it
CREATE OR REPLACE FUNCTION cartlify.release_product_stock (p_product_id int, p_qty int) RETURNS integer LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_reserved_stock integer;
BEGIN
  -- validate input
  IF p_product_id IS NULL OR p_product_id <= 0 THEN
    RAISE EXCEPTION 'PRODUCT_ID_INVALID';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'RELEASE_QTY_INVALID';
  END IF;

  -- lock product row
  SELECT p."reservedStock"
  INTO v_reserved_stock
  FROM cartlify.products AS p
  WHERE p.id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  IF v_reserved_stock < p_qty THEN
    RAISE EXCEPTION 'INSUFFICIENT_RESERVED_STOCK';
  END IF;

  v_reserved_stock := v_reserved_stock - p_qty;

  UPDATE cartlify.products AS p
  SET "reservedStock" = v_reserved_stock
  WHERE p.id = p_product_id;

  RETURN v_reserved_stock;
END;
$$;

-- PRODUCTS consume reserved stock after payment, out of the batches: the order keeps which batch
-- gave how many (order_batch_allocations), its cost of goods
-- internal step: runs with caller rights, so only system functions pass rls on stock columns;
-- the app has no execute right (db/01), pay_order calls it as the owner

-- the version before the batches (product, quantity); a temporary line, it goes once dev and prod
-- match the reference
DROP FUNCTION IF EXISTS cartlify.consume_product_stock (integer, integer);

CREATE OR REPLACE FUNCTION cartlify.consume_product_stock (p_order_id integer, p_product_id integer, p_qty integer) RETURNS integer LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_role           text;
  v_stock          integer;
  v_reserved_stock integer;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'STOCK_QTY_INVALID';
  END IF;

  v_role := cartlify.current_actor_role();

  IF v_role IS NULL OR v_role NOT IN ('ADMIN', 'ROOT') THEN
    RAISE EXCEPTION 'STOCK_CONSUME_FORBIDDEN';
  END IF;

  -- lock product row
  SELECT p."stock", p."reservedStock"
  INTO v_stock, v_reserved_stock
  FROM cartlify.products AS p
  WHERE p.id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- reserved units must exist before final consume
  IF v_reserved_stock < p_qty THEN
    RAISE EXCEPTION 'INSUFFICIENT_RESERVED_STOCK';
  END IF;

  -- defensive check for broken state
  IF v_stock < p_qty THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK';
  END IF;

  v_stock := v_stock - p_qty;
  v_reserved_stock := v_reserved_stock - p_qty;

  UPDATE cartlify.products AS p
  SET
    "stock" = v_stock,
    "reservedStock" = v_reserved_stock
  WHERE p.id = p_product_id;

  INSERT INTO cartlify.order_batch_allocations ("orderId", "productId", "batchId", quantity)
  SELECT p_order_id, p_product_id, t.taken_batch_id, t.taken_quantity
  FROM cartlify.take_from_batches(p_product_id, p_qty, true) AS t;

  RETURN v_stock;
END;
$$;

-- PRODUCTS recalc product popularity score
-- internal: only the popularity triggers and recalc_all_products_popularity call it,
-- the app has no execute right (db/01)
CREATE OR REPLACE FUNCTION cartlify.recalc_product_popularity (p_product_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_views           integer;
  v_favs_30d        integer;
  v_cart_adds_30d   integer;
  v_purchases_30d   integer;
  v_reviews_30d     integer;

  v_score           numeric;
  v_override        integer;
  v_override_until  timestamptz;
  v_now             timestamptz := now();
BEGIN
  SELECT
    p."views",
    p."popularityOverride",
    p."popularityOverrideUntil"
  INTO
    v_views,
    v_override,
    v_override_until
  FROM cartlify.products AS p
  WHERE p.id = p_product_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- the row is written only when the value changes: a write locks the row of the product to the
  -- end of the transaction, and every cart of a busy product would wait for it
  IF v_override IS NOT NULL
     AND v_override_until IS NOT NULL
     AND v_now < v_override_until THEN
    UPDATE cartlify.products AS p
    SET "popularity" = v_override
    WHERE p.id = p_product_id
      AND p."popularity" IS DISTINCT FROM v_override;

    RETURN;
  END IF;

  SELECT COUNT(*)::integer
  INTO v_favs_30d
  FROM cartlify.favorites AS f
  WHERE f."productId" = p_product_id
    AND f."createdAt" >= v_now - INTERVAL '30 days';

  SELECT COUNT(*)::integer
  INTO v_cart_adds_30d
  FROM cartlify.order_items AS oi
  JOIN cartlify.orders      AS o ON o.id = oi."orderId"
  WHERE oi."productId" = p_product_id
    AND o."confirmed" = false
    AND oi."createdAt" >= v_now - INTERVAL '30 days';

  SELECT COUNT(*)::integer
  INTO v_purchases_30d
  FROM cartlify.order_items AS oi
  JOIN cartlify.orders      AS o ON o.id = oi."orderId"
  WHERE oi."productId" = p_product_id
    AND o."confirmed" = true
    AND o."updatedAt" >= v_now - INTERVAL '30 days';

  SELECT COUNT(*)::integer
  INTO v_reviews_30d
  FROM cartlify.reviews AS r
  WHERE r."productId" = p_product_id
    AND r."createdAt" >= v_now - INTERVAL '30 days';

  v_views          := COALESCE(v_views, 0);
  v_favs_30d       := COALESCE(v_favs_30d, 0);
  v_cart_adds_30d  := COALESCE(v_cart_adds_30d, 0);
  v_purchases_30d  := COALESCE(v_purchases_30d, 0);
  v_reviews_30d    := COALESCE(v_reviews_30d, 0);

  v_score :=
        1  * LN(1 + v_views)
      + 4  * LN(1 + v_favs_30d)
      + 6  * LN(1 + v_cart_adds_30d)
      + 12 * LN(1 + v_purchases_30d)
      + 3  * LN(1 + v_reviews_30d);

  UPDATE cartlify.products AS p
  SET "popularity" = COALESCE(round(v_score)::integer, 0)
  WHERE p.id = p_product_id
    AND p."popularity" IS DISTINCT FROM COALESCE(round(v_score)::integer, 0);
END;
$$;

-- ADD TO RAILWAY ONCE A WEEK!!!
--psql "$MIGRATION_DATABASE_URL" \
-- -c 'SELECT cartlify.recalc_all_products_popularity();'
-- PRODUCTS recalc popularity for all products
-- maintenance: run by hand as the owner (see above), the app has no execute right (db/01)
CREATE OR REPLACE FUNCTION cartlify.recalc_all_products_popularity () RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_product_id integer;
BEGIN
  FOR v_product_id IN
    SELECT id
    FROM cartlify.products
  LOOP
    PERFORM cartlify.recalc_product_popularity(v_product_id);
  END LOOP;
END;
$$;

-- PRODUCTS === triggers & functions ===
-- PRODUCTS sync product rating and review count after review rating or comment change
-- trigger: runs as the owner, the recalc function it calls is internal and closed for the app;
-- a trigger function cannot be called directly, only the trigger fires it
CREATE OR REPLACE FUNCTION cartlify.reviews_after_mod_rating () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_product_id integer;
BEGIN
  -- avgRating comes from ratings and reviewsCount from comments, skip only when neither changed
  IF TG_OP = 'UPDATE'
    AND NEW."rating" IS NOT DISTINCT FROM OLD."rating"
    AND NEW."comment" IS NOT DISTINCT FROM OLD."comment"
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    v_product_id := NEW."productId";
  ELSE
    v_product_id := OLD."productId";
  END IF;

  PERFORM cartlify.recalc_product_rating(v_product_id);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_reviews_after_mod_rating ON cartlify.reviews;

CREATE TRIGGER trg_reviews_after_mod_rating
AFTER INSERT OR DELETE OR UPDATE OF "rating", "comment" ON cartlify.reviews FOR EACH ROW
EXECUTE FUNCTION cartlify.reviews_after_mod_rating ();

-- PRODUCTS guard product views before update: guest and user can add only one view
CREATE OR REPLACE FUNCTION cartlify.products_before_views_change () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."views" IS DISTINCT FROM OLD."views"
     AND cartlify.current_actor_role() IN ('GUEST', 'USER')
     AND NEW."views" IS DISTINCT FROM OLD."views" + 1
  THEN
    RAISE EXCEPTION 'PRODUCT_VIEWS_UPDATE_FORBIDDEN';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_before_views_change ON cartlify.products;

CREATE TRIGGER trg_products_before_views_change
BEFORE UPDATE ON cartlify.products FOR EACH ROW
EXECUTE FUNCTION cartlify.products_before_views_change ();

-- PRODUCTS the sale of a product, whatever way the row changes: a sale set or changed ends in the
-- future; a price down to the sale price or below ends the sale and its fields go empty, the
-- lowest price of the 30 days before it too. A sale
-- that was still on gets the line of its end in the admin log (PRODUCT_SALE, event
-- ended_by_price) in the name of the admin who changed the price, the system has no id; the log
-- of prices has the change of the price itself. Prices go as the app writes them (trim_scale,
-- 15.50 is 15.5), dates as iso utc. Only an update: rows copied in (dev restored from a copy of
-- prod) keep their sales, ended ones too. Prisma keeps dates as utc in columns without a time zone
CREATE OR REPLACE FUNCTION cartlify.products_before_price_change () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_now timestamp := now() AT TIME ZONE 'UTC';
  v_actor_id integer := cartlify.current_actor_id();
BEGIN
  IF NEW."salePrice" IS NOT NULL
     AND (
       NEW."salePrice" IS DISTINCT FROM OLD."salePrice"
       OR NEW."saleEndsAt" IS DISTINCT FROM OLD."saleEndsAt"
     )
     AND (NEW."saleEndsAt" IS NULL OR NEW."saleEndsAt" <= v_now)
  THEN
    RAISE EXCEPTION 'PRODUCT_SALE_ENDS_AT_INVALID';
  END IF;

  IF NEW."price" IS DISTINCT FROM OLD."price"
     AND NEW."salePrice" IS NOT NULL
     AND NEW."price" <= NEW."salePrice"
  THEN
    IF NEW."saleEndsAt" > v_now THEN
      IF v_actor_id IS NULL OR NOT cartlify.is_admin() THEN
        RAISE EXCEPTION 'PRODUCT_SALE_ACTOR_REQUIRED';
      END IF;

      PERFORM cartlify.log_admin_action(
        v_actor_id,
        cartlify.current_actor_role(),
        'product',
        NEW.id,
        'PRODUCT_SALE',
        jsonb_build_array(
          jsonb_build_object('field', 'event', 'old', NULL, 'new', 'ended_by_price'),
          jsonb_build_object(
            'field', 'price',
            'old', trim_scale(OLD."price")::text,
            'new', trim_scale(NEW."price")::text
          ),
          jsonb_build_object(
            'field', 'salePrice',
            'old', trim_scale(NEW."salePrice")::text,
            'new', NULL
          ),
          jsonb_build_object(
            'field', 'saleEndsAt',
            'old', to_char(NEW."saleEndsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'new', NULL
          )
        )
      );
    END IF;

    NEW."salePrice" := NULL;
    NEW."saleEndsAt" := NULL;
    NEW."salePriorPrice" := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_before_price_change ON cartlify.products;

CREATE TRIGGER trg_products_before_price_change
BEFORE UPDATE OF "price", "salePrice", "saleEndsAt" ON cartlify.products FOR EACH ROW
EXECUTE FUNCTION cartlify.products_before_price_change ();

-- PRODUCTS sync popularity after product views change
-- views enter the score through a logarithm, so one view rarely changes it:
-- recalc while the counter is small, on every tenth view and on any manual change
-- trigger: runs as the owner, the recalc function it calls is internal and closed for the app;
-- a trigger function cannot be called directly, only the trigger fires it
CREATE OR REPLACE FUNCTION cartlify.products_after_views_change () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  IF NEW."views" IS DISTINCT FROM OLD."views"
     AND (
       NEW."views" <= 20
       OR NEW."views" % 10 = 0
       OR NEW."views" IS DISTINCT FROM OLD."views" + 1
     )
  THEN
    PERFORM cartlify.recalc_product_popularity(NEW.id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_after_views_change ON cartlify.products;

CREATE TRIGGER trg_products_after_views_change
AFTER UPDATE ON cartlify.products FOR EACH ROW
EXECUTE FUNCTION cartlify.products_after_views_change ();

-- PRODUCTS sync popularity after favorites change
-- trigger: runs as the owner, the recalc function it calls is internal and closed for the app;
-- a trigger function cannot be called directly, only the trigger fires it
CREATE OR REPLACE FUNCTION cartlify.favorites_after_mod_popularity () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_product_id integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_product_id := NEW."productId";
  ELSE
    v_product_id := OLD."productId";
  END IF;

  PERFORM cartlify.recalc_product_popularity(v_product_id);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_favorites_after_mod_popularity ON cartlify.favorites;

CREATE TRIGGER trg_favorites_after_mod_popularity
AFTER INSERT OR DELETE ON cartlify.favorites FOR EACH ROW
EXECUTE FUNCTION cartlify.favorites_after_mod_popularity ();

-- PRODUCTS sync popularity after order items change
-- the score counts the items, not their quantity or price: only an item that comes, goes or moves
-- to another order or product counts again
-- trigger: runs as the owner, the recalc function it calls is internal and closed for the app;
-- a trigger function cannot be called directly, only the trigger fires it
CREATE OR REPLACE FUNCTION cartlify.order_items_after_mod_popularity () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_product_id integer;
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    v_product_id := NEW."productId";
  ELSE
    v_product_id := OLD."productId";
  END IF;

  PERFORM cartlify.recalc_product_popularity(v_product_id);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_items_after_mod_popularity ON cartlify.order_items;

CREATE TRIGGER trg_order_items_after_mod_popularity
AFTER INSERT OR DELETE OR UPDATE OF "orderId", "productId" ON cartlify.order_items FOR EACH ROW
EXECUTE FUNCTION cartlify.order_items_after_mod_popularity ();

-- PRODUCTS sync popularity after review changes
-- the score counts the reviews, not their votes or texts: only a review that comes or goes counts
-- trigger: runs as the owner, the recalc function it calls is internal and closed for the app;
-- a trigger function cannot be called directly, only the trigger fires it
CREATE OR REPLACE FUNCTION cartlify.reviews_after_mod_popularity () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_product_id integer;
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    v_product_id := NEW."productId";
  ELSE
    v_product_id := OLD."productId";
  END IF;

  PERFORM cartlify.recalc_product_popularity(v_product_id);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_reviews_after_mod_popularity ON cartlify.reviews;

CREATE TRIGGER trg_reviews_after_mod_popularity
AFTER INSERT OR DELETE ON cartlify.reviews FOR EACH ROW
EXECUTE FUNCTION cartlify.reviews_after_mod_popularity ();

-- PRODUCTS sync popularity after order status change
-- trigger: runs as the owner, the recalc function it calls is internal and closed for the app;
-- a trigger function cannot be called directly, only the trigger fires it
CREATE OR REPLACE FUNCTION cartlify.orders_after_update_popularity () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_product_id integer;
BEGIN

  -- an item counts as in a cart or as bought by the confirmed flag of its order: a step of a
  -- confirmed order (paid, shipped, delivered) changes nothing the score counts
  IF NEW."confirmed" IS DISTINCT FROM OLD."confirmed" THEN

    FOR v_product_id IN
      SELECT DISTINCT oi."productId"
      FROM cartlify.order_items AS oi
      WHERE oi."orderId" = NEW.id
    LOOP
      PERFORM cartlify.recalc_product_popularity(v_product_id);
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_after_update_popularity ON cartlify.orders;

CREATE TRIGGER trg_orders_after_update_popularity
AFTER UPDATE ON cartlify.orders FOR EACH ROW
EXECUTE FUNCTION cartlify.orders_after_update_popularity ();

------------------------------------------------------------
-- ORDERS AND ITEMS
------------------------------------------------------------
-- ORDERS AND ITEMS === system functions ===
-- ORDERS AND ITEMS recalc order total from order items
-- internal: only the order items trigger calls it, the app has no execute right (db/01)
CREATE OR REPLACE FUNCTION cartlify.recalc_order_total (p_order_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_total cartlify.orders.total%TYPE;
BEGIN
  SELECT COALESCE(SUM(oi."totalPrice"), 0)
  INTO v_total
  FROM cartlify.order_items AS oi
  WHERE oi."orderId" = p_order_id;

  UPDATE cartlify.orders AS o
  SET "total" = v_total
  WHERE o.id = p_order_id;
END;
$$;

-- ORDERS AND ITEMS === user actions ===
-- ORDERS AND ITEMS refresh item prices of an unconfirmed order from current product prices
-- (product_current_price: the sale price while the sale lasts)
-- runs with caller rights: rls lets only the order owner change items, and only before confirmation
-- returns the number of items whose price changed
CREATE OR REPLACE FUNCTION cartlify.refresh_order_prices (p_order_id integer) RETURNS integer LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_changed integer;
BEGIN
  UPDATE cartlify.order_items AS oi
  SET "unitPrice" = cartlify.product_current_price(p."price", p."salePrice", p."saleEndsAt")
  FROM cartlify.products AS p
  WHERE oi."orderId" = p_order_id
    AND p.id = oi."productId"
    AND oi."unitPrice" IS DISTINCT FROM
      cartlify.product_current_price(p."price", p."salePrice", p."saleEndsAt");

  GET DIAGNOSTICS v_changed = ROW_COUNT;

  RETURN v_changed;
END;
$$;

-- ORDERS AND ITEMS === system functions ===
-- ORDERS AND ITEMS confirm order and reserve product stock
-- system function: acts only for the USER who owns the order
CREATE OR REPLACE FUNCTION cartlify.confirm_order (p_order_id integer, p_reserve_for interval) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor_role text;
  v_actor_id   integer;

  v_user_id    integer;
  v_confirmed  boolean;
  v_status     text;

  r record;
BEGIN
  v_actor_role := cartlify.current_actor_role();
  v_actor_id   := cartlify.current_actor_id();

  -- only real USER
  IF v_actor_role IS DISTINCT FROM 'USER' OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_CONFIRM_FORBIDDEN';
  END IF;

  -- validate reservation duration
  IF p_reserve_for IS NULL OR p_reserve_for <= interval '0 seconds' THEN
    RAISE EXCEPTION 'ORDER_RESERVATION_DURATION_INVALID';
  END IF;

  -- lock order row; orders of other users stay hidden, as they were under rls
  SELECT o."userId", o.confirmed, o.status
  INTO v_user_id, v_confirmed, v_status
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id
    AND o."userId" = v_actor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF v_user_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'ORDER_CONFIRM_FORBIDDEN';
  END IF;

  IF v_confirmed THEN
    RAISE EXCEPTION 'ORDER_ALREADY_CONFIRMED';
  END IF;

IF v_status NOT IN ('pending', 'unconfirmed') THEN
  RAISE EXCEPTION 'ORDER_STATUS_NOT_ALLOWED';
END IF;

  -- lock all order items to freeze the cart at confirm moment
  PERFORM 1
  FROM cartlify.order_items AS oi
  WHERE oi."orderId" = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_ITEMS_REQUIRED';
  END IF;

  -- reserve stock (deterministic lock order by productId)
  FOR r IN
    SELECT oi."productId" AS product_id,
           SUM(oi.quantity)::integer AS qty
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = p_order_id
    GROUP BY oi."productId"
    ORDER BY oi."productId"
  LOOP
    PERFORM cartlify.reserve_product_stock(r.product_id, r.qty);
  END LOOP;

  -- product rows are locked by the reservation above, so prices cannot change until commit:
  -- refuse if any item price differs from the price the product sells at now (a sale that just
  -- ended counts), the user must confirm the amount they see
  IF EXISTS (
    SELECT 1
    FROM cartlify.order_items AS oi
    JOIN cartlify.products AS p ON p.id = oi."productId"
    WHERE oi."orderId" = p_order_id
      AND oi."unitPrice" IS DISTINCT FROM
        cartlify.product_current_price(p."price", p."salePrice", p."saleEndsAt")
  ) THEN
    RAISE EXCEPTION 'ORDER_PRICES_CHANGED';
  END IF;

  -- the items keep the names their products have now, the history shows what was bought; the
  -- update goes through order_items_before_ins_upd while the order is not confirmed yet
  UPDATE cartlify.order_items AS oi
  SET "productName" = p.name
  FROM cartlify.products AS p
  WHERE oi."orderId" = p_order_id
    AND p.id = oi."productId"
    AND oi."productName" IS DISTINCT FROM p.name;

  -- confirm order and set reservation deadline
  UPDATE cartlify.orders AS o
  SET
    confirmed = true,
    status = 'waiting',
    "reservationExpiresAt" = clock_timestamp() + p_reserve_for
  WHERE o.id = p_order_id;
END;
$$;

-- ORDERS AND ITEMS unconfirm order and release reserved stock
CREATE OR REPLACE FUNCTION cartlify.unconfirm_order (p_order_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_confirmed  boolean;
  v_status     text;

  r record;
BEGIN
  -- only the system: the admin context without a user id, a signed-in admin is refused
  IF NOT cartlify.is_system() THEN
    RAISE EXCEPTION 'ORDER_UNCONFIRM_FORBIDDEN';
  END IF;

  -- lock order row
  SELECT o.confirmed, o.status
  INTO v_confirmed, v_status
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF NOT v_confirmed THEN
    RAISE EXCEPTION 'ORDER_NOT_CONFIRMED';
  END IF;

  IF v_status IS DISTINCT FROM 'waiting' THEN
    RAISE EXCEPTION 'ORDER_STATUS_NOT_WAITING';
  END IF;

  -- lock all order items
  PERFORM 1
  FROM cartlify.order_items AS oi
  WHERE oi."orderId" = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_ITEMS_REQUIRED';
  END IF;

  -- release reserved stock (deterministic lock order by productId)
  FOR r IN
    SELECT oi."productId" AS product_id,
           SUM(oi.quantity)::integer AS qty
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = p_order_id
    GROUP BY oi."productId"
    ORDER BY oi."productId"
  LOOP
    PERFORM cartlify.release_product_stock(r.product_id, r.qty);
  END LOOP;

  -- rollback order state
  UPDATE cartlify.orders AS o
  SET
    confirmed = false,
    status = 'unconfirmed',
    "reservationExpiresAt" = NULL
  WHERE o.id = p_order_id;
END;
$$;

-- ORDERS AND ITEMS the owner cancels the payment of an order that waits for it
-- system function: runs as the owner, reserved stock is closed for the app;
-- callable only by the USER who owns the order. The server closes the stripe payment page before
-- the call, so no payment can come for this reservation any more. The order becomes unconfirmed
-- with its items and shipping data, the owner can change them and confirm it again
CREATE OR REPLACE FUNCTION cartlify.cancel_order_payment (p_order_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor_id   integer;
  v_confirmed  boolean;
  v_status     text;

  r record;
BEGIN
  v_actor_id := cartlify.current_actor_id();

  -- only a real USER, and only for an own order
  IF cartlify.current_actor_role() IS DISTINCT FROM 'USER' OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_CANCEL_PAYMENT_FORBIDDEN';
  END IF;

  -- read state without a lock: a paid order is not lockable for system updates of a user;
  -- orders of other users stay hidden, as they are under rls
  SELECT o.confirmed, o.status
  INTO v_confirmed, v_status
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id
    AND o."userId" = v_actor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  -- the payment came first: there is nothing to cancel
  IF v_status = 'paid' THEN
    RAISE EXCEPTION 'ORDER_ALREADY_PAID';
  END IF;

  IF NOT v_confirmed OR v_status IS DISTINCT FROM 'waiting' THEN
    RAISE EXCEPTION 'ORDER_STATUS_NOT_WAITING';
  END IF;

  -- lock order row
  PERFORM 1
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id
    AND o."userId" = v_actor_id
    AND o.confirmed = true
    AND o.status = 'waiting'
  FOR UPDATE;

  IF NOT FOUND THEN
    -- the order changed while waiting for the lock: paid by a payment of this moment,
    -- or unconfirmed by the reservation timer
    SELECT o.status
    INTO v_status
    FROM cartlify.orders AS o
    WHERE o.id = p_order_id;

    IF v_status = 'paid' THEN
      RAISE EXCEPTION 'ORDER_ALREADY_PAID';
    END IF;

    RAISE EXCEPTION 'ORDER_STATUS_NOT_WAITING';
  END IF;

  -- lock all order items
  PERFORM 1
  FROM cartlify.order_items AS oi
  WHERE oi."orderId" = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_ITEMS_REQUIRED';
  END IF;

  -- release reserved stock (deterministic lock order by productId)
  FOR r IN
    SELECT oi."productId" AS product_id,
           SUM(oi.quantity)::integer AS qty
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = p_order_id
    GROUP BY oi."productId"
    ORDER BY oi."productId"
  LOOP
    PERFORM cartlify.release_product_stock(r.product_id, r.qty);
  END LOOP;

  UPDATE cartlify.orders AS o
  SET
    confirmed = false,
    status = 'unconfirmed',
    "reservationExpiresAt" = NULL
  WHERE o.id = p_order_id;
END;
$$;

-- ORDERS AND ITEMS admin cancels a paid or shipped order and returns its stock
-- system function: runs as the owner, stock and the status of a paid order are closed for plain
-- updates (db/03); callable only in the admin context. The server refunds the payment in the same
-- transaction before the commit, so an order is cancelled only together with its refund.
-- A delivered order is not cancelled
CREATE OR REPLACE FUNCTION cartlify.cancel_paid_order (p_order_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT cartlify.is_admin() THEN
    RAISE EXCEPTION 'ORDER_CANCEL_FORBIDDEN';
  END IF;

  -- read state without a lock: a delivered or cancelled order is not lockable for updates
  SELECT o.status
  INTO v_status
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF v_status = 'delivered' THEN
    RAISE EXCEPTION 'ORDER_ALREADY_DELIVERED';
  END IF;

  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'ORDER_ALREADY_CANCELLED';
  END IF;

  IF v_status NOT IN ('paid', 'shipped') THEN
    RAISE EXCEPTION 'ORDER_NOT_PAID';
  END IF;

  -- lock order row
  PERFORM 1
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id
    AND o.status IN ('paid', 'shipped')
  FOR UPDATE;

  IF NOT FOUND THEN
    -- the status changed while waiting for the lock
    RAISE EXCEPTION 'ORDER_STATUS_CHANGED';
  END IF;

  -- items of a confirmed order cannot change (order items trigger); the stock goes back into the
  -- batches the payment took it from
  PERFORM cartlify.return_order_stock(p_order_id);

  -- the reports of a period take the payment back from the time of the cancel
  UPDATE cartlify.orders AS o
  SET
    status = 'cancelled',
    "cancelledAt" = now() AT TIME ZONE 'UTC'
  WHERE o.id = p_order_id;
END;
$$;

-- ORDERS AND ITEMS pay order from a verified payment webhook
-- the version before the payment provider (order, payment intent, amount); a temporary line,
-- it goes once dev and prod match the reference
DROP FUNCTION IF EXISTS cartlify.pay_order (integer, text, numeric);

-- the same payment is the same provider with the same payment id: a repeated delivery
CREATE OR REPLACE FUNCTION cartlify.pay_order (
  p_order_id integer,
  p_payment_provider cartlify."PaymentProvider",
  p_payment_id text,
  p_paid_amount numeric
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_confirmed         boolean;
  v_status            text;
  v_shipping_address  text;
  v_first_name        text;
  v_last_name         text;
  v_phone             text;
  v_recorded_provider cartlify."PaymentProvider";
  v_recorded_payment  text;
  v_items_total       numeric;

  r record;
BEGIN
  -- only the system (the payment webhook): the admin context without a user id, a signed-in
  -- admin is refused, a payment comes only from a provider
  IF NOT cartlify.is_system() THEN
    RAISE EXCEPTION 'ORDER_PAY_FORBIDDEN';
  END IF;

  IF p_payment_provider IS NULL THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_PROVIDER_REQUIRED';
  END IF;

  IF p_payment_id IS NULL OR btrim(p_payment_id) = '' THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_ID_REQUIRED';
  END IF;

  -- read state without a lock: paid orders are not lockable for system updates
  SELECT o.status, o."paymentProvider", o."paymentId"
  INTO v_status, v_recorded_provider, v_recorded_payment
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id;

  IF NOT FOUND THEN
    RETURN 'ORDER_NOT_FOUND';
  END IF;

  -- already paid: same payment is a repeated delivery, another one is a second charge. The
  -- recorded payment decides, not the status: a paid order that was shipped, delivered or
  -- cancelled since keeps its payment, and a provider delivers an event again days later as well
  IF v_recorded_payment IS NOT NULL THEN
    IF v_recorded_provider IS NOT DISTINCT FROM p_payment_provider
       AND v_recorded_payment = p_payment_id THEN
      RETURN 'ALREADY_PAID_SAME_PAYMENT';
    END IF;

    RETURN 'ALREADY_PAID_OTHER_PAYMENT';
  END IF;

  -- lock order row; the payment is read again with it
  SELECT o.confirmed, o.status, o."shippingAddress",
         o."recipientFirstName", o."recipientLastName", o."recipientPhone",
         o."paymentProvider", o."paymentId"
  INTO v_confirmed, v_status, v_shipping_address,
       v_first_name, v_last_name, v_phone,
       v_recorded_provider, v_recorded_payment
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id
  FOR UPDATE;

  -- the first look took no lock: a delivery of the same event at the same moment may have paid
  -- the order while this one waited for the lock, the locked row is the version it committed
  IF FOUND AND v_recorded_payment IS NOT NULL THEN
    IF v_recorded_provider IS NOT DISTINCT FROM p_payment_provider
       AND v_recorded_payment = p_payment_id THEN
      RETURN 'ALREADY_PAID_SAME_PAYMENT';
    END IF;

    RETURN 'ALREADY_PAID_OTHER_PAYMENT';
  END IF;

  IF NOT FOUND THEN
    -- order changed while waiting for the lock and is no longer open for system updates
    SELECT o.status, o."paymentProvider", o."paymentId"
    INTO v_status, v_recorded_provider, v_recorded_payment
    FROM cartlify.orders AS o
    WHERE o.id = p_order_id;

    IF v_recorded_payment IS NOT NULL THEN
      IF v_recorded_provider IS NOT DISTINCT FROM p_payment_provider
         AND v_recorded_payment = p_payment_id THEN
        RETURN 'ALREADY_PAID_SAME_PAYMENT';
      END IF;

      RETURN 'ALREADY_PAID_OTHER_PAYMENT';
    END IF;

    RETURN 'ORDER_NOT_PAYABLE';
  END IF;

  -- lock all order items
  PERFORM 1
  FROM cartlify.order_items AS oi
  WHERE oi."orderId" = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'ORDER_NOT_PAYABLE';
  END IF;

  -- paid amount must match the items being sold
  SELECT COALESCE(SUM(oi."totalPrice"), 0)
  INTO v_items_total
  FROM cartlify.order_items AS oi
  WHERE oi."orderId" = p_order_id;

  IF p_paid_amount IS NULL OR p_paid_amount <> v_items_total THEN
    RETURN 'AMOUNT_MISMATCH';
  END IF;

  IF v_confirmed AND v_status = 'waiting' THEN
    -- regular path: stock is still reserved for this order. A batch may be over since the
    -- reservation: what is over is never sold, the money goes back
    BEGIN
      FOR r IN
        SELECT oi."productId" AS product_id,
               SUM(oi.quantity)::integer AS qty
        FROM cartlify.order_items AS oi
        WHERE oi."orderId" = p_order_id
        GROUP BY oi."productId"
        ORDER BY oi."productId"
      LOOP
        PERFORM cartlify.consume_product_stock(p_order_id, r.product_id, r.qty);
      END LOOP;
    EXCEPTION
      WHEN raise_exception THEN
        -- all or nothing: stock changes made in this block are rolled back
        IF SQLERRM = 'PRODUCT_BATCHES_SHORT' THEN
          RETURN 'OUT_OF_STOCK';
        END IF;

        RAISE;
    END;
  ELSIF NOT v_confirmed AND v_status IN ('pending', 'unconfirmed') THEN
    -- emergency path: reservation is gone, sell only when every item is still available
    -- the order becomes confirmed, so it needs what the confirm trigger requires
    IF v_shipping_address IS NULL OR btrim(v_shipping_address) = ''
       OR v_first_name IS NULL OR btrim(v_first_name) = ''
       OR v_last_name IS NULL OR btrim(v_last_name) = ''
       OR v_phone IS NULL OR btrim(v_phone) = '' THEN
      RETURN 'ORDER_NOT_PAYABLE';
    END IF;

    BEGIN
      FOR r IN
        SELECT oi."productId" AS product_id,
               SUM(oi.quantity)::integer AS qty
        FROM cartlify.order_items AS oi
        WHERE oi."orderId" = p_order_id
        GROUP BY oi."productId"
        ORDER BY oi."productId"
      LOOP
        PERFORM cartlify.reserve_product_stock(r.product_id, r.qty);
        PERFORM cartlify.consume_product_stock(p_order_id, r.product_id, r.qty);
      END LOOP;
    EXCEPTION
      WHEN raise_exception THEN
        -- all or nothing: stock changes made in this block are rolled back
        IF SQLERRM IN ('INSUFFICIENT_AVAILABLE_STOCK', 'PRODUCT_NOT_FOUND', 'PRODUCT_BATCHES_SHORT') THEN
          RETURN 'OUT_OF_STOCK';
        END IF;

        RAISE;
    END;
  ELSE
    RETURN 'ORDER_NOT_PAYABLE';
  END IF;

  -- mark order as paid together with the payment that paid it, who took it and when: the reports
  -- of a period count a sale from this time; utc without a zone, as prisma writes the dates
  UPDATE cartlify.orders AS o
  SET
    confirmed = true,
    status = 'paid',
    "reservationExpiresAt" = NULL,
    "paymentProvider" = p_payment_provider,
    "paymentId" = p_payment_id,
    "paidAt" = now() AT TIME ZONE 'UTC'
  WHERE o.id = p_order_id;

  RETURN 'PAID';
END;
$$;

-- ORDERS AND ITEMS === system actions ===
-- ORDERS AND ITEMS expire order reservation and release reserved stock
-- system function: runs as the owner, it changes orders and stock of any user;
-- callable only by the system (the admin context without a user id), the order timeout worker
-- sets it before the call
CREATE OR REPLACE FUNCTION cartlify.expire_order_reservation (p_order_id integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_confirmed      boolean;
  v_status         text;
  v_reserve_until  timestamptz;

  r record;
BEGIN
  -- only the system (the reservation worker): the admin context without a user id
  IF NOT cartlify.is_system() THEN
    RAISE EXCEPTION 'ORDER_EXPIRE_FORBIDDEN';
  END IF;

  BEGIN
    -- read state without a lock: only waiting orders are lockable for system updates
    SELECT o.confirmed, o.status, o."reservationExpiresAt"
    INTO v_confirmed, v_status, v_reserve_until
    FROM cartlify.orders AS o
    WHERE o.id = p_order_id;

    -- the owner deleted the order: its timer is a stale job like any other
    IF NOT FOUND THEN
      RETURN false;
    END IF;

    -- stale job or nothing to expire
    IF NOT v_confirmed
       OR v_status IS DISTINCT FROM 'waiting'
       OR v_reserve_until IS NULL
       OR v_reserve_until > clock_timestamp() THEN

      RETURN false;
    END IF;

    -- lock order row
    SELECT o.confirmed, o.status, o."reservationExpiresAt"
    INTO v_confirmed, v_status, v_reserve_until
    FROM cartlify.orders AS o
    WHERE o.id = p_order_id
    FOR UPDATE;

    -- order changed while waiting for the lock
    IF NOT FOUND THEN
      RETURN false;
    END IF;

    IF NOT v_confirmed
       OR v_status IS DISTINCT FROM 'waiting'
       OR v_reserve_until IS NULL
       OR v_reserve_until > clock_timestamp() THEN

      RETURN false;
    END IF;

    -- lock all order items
    PERFORM 1
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = p_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ORDER_ITEMS_REQUIRED';
    END IF;

    -- release reserved stock (deterministic lock order by productId)
    FOR r IN
      SELECT oi."productId" AS product_id,
             SUM(oi.quantity)::integer AS qty
      FROM cartlify.order_items AS oi
      WHERE oi."orderId" = p_order_id
      GROUP BY oi."productId"
      ORDER BY oi."productId"
    LOOP
      PERFORM cartlify.release_product_stock(r.product_id, r.qty);
    END LOOP;

    -- rollback expired reservation
    UPDATE cartlify.orders AS o
    SET
      confirmed = false,
      status = 'unconfirmed',
      "reservationExpiresAt" = NULL
    WHERE o.id = p_order_id;

    RETURN true;
  EXCEPTION
    WHEN OTHERS THEN

      RAISE;
  END;
END;
$$;

-- ORDERS AND ITEMS === triggers & functions ===
-- ORDERS AND ITEMS take unit price and name from product and calculate order item total price
-- before insert or update; the name of the product goes with the price, the confirm keeps both
CREATE OR REPLACE FUNCTION cartlify.order_items_before_ins_upd () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_confirmed boolean;
  v_price cartlify.products.price%TYPE;
  v_name cartlify.products.name%TYPE;
  v_deleted_at cartlify.products."deletedAt"%TYPE;
BEGIN

  SELECT o."confirmed"
  INTO v_confirmed
  FROM cartlify.orders AS o
  WHERE o.id = NEW."orderId"
  FOR UPDATE;

  -- rls hides orders the actor cannot change (foreign or confirmed): treat as forbidden
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_EDITABLE'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_confirmed THEN
    RAISE EXCEPTION 'ORDER_ALREADY_CONFIRMED'
      USING ERRCODE = 'check_violation';
  END IF;

  -- unit price always comes from the product, never from the caller: the price it sells at now
  SELECT cartlify.product_current_price(p."price", p."salePrice", p."saleEndsAt"), p.name, p."deletedAt"
  INTO v_price, v_name, v_deleted_at
  FROM cartlify.products AS p
  WHERE p.id = NEW."productId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- a product removed from the catalog goes into no order; an item that holds one since before
  -- the removal keeps it, the app drops such items when it reads the order
  IF v_deleted_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."productId" IS DISTINCT FROM OLD."productId") THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  NEW."unitPrice" := v_price;
  NEW."totalPrice" := NEW."unitPrice" * NEW."quantity";
  NEW."productName" := v_name;

  RETURN NEW;
  
END;
$$;

DROP TRIGGER IF EXISTS trg_order_items_before_ins_upd ON cartlify.order_items;

CREATE TRIGGER trg_order_items_before_ins_upd
BEFORE INSERT OR UPDATE ON cartlify.order_items FOR EACH ROW
EXECUTE FUNCTION cartlify.order_items_before_ins_upd ();

-- ORDERS AND ITEMS recalc order total after order items change
-- trigger: runs as the owner, the recalc function it calls is internal and closed for the app;
-- a trigger function cannot be called directly, only the trigger fires it
CREATE OR REPLACE FUNCTION cartlify.order_items_after_mod () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_order_id integer;
BEGIN

  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    v_order_id := NEW."orderId";
  ELSE
    v_order_id := OLD."orderId";
  END IF;

  PERFORM cartlify.recalc_order_total(v_order_id);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_items_after_mod ON cartlify.order_items;

CREATE TRIGGER trg_order_items_after_mod
AFTER INSERT OR UPDATE OR DELETE ON cartlify.order_items FOR EACH ROW
EXECUTE FUNCTION cartlify.order_items_after_mod ();

-- ORDERS AND ITEMS guard order updates, recalc total before confirmation, stamp the time of the change
CREATE OR REPLACE FUNCTION cartlify.orders_before_update () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_total cartlify.orders.total%TYPE;
BEGIN
  -- prisma stamps updatedAt only in its own queries, db functions (pay, confirm, cancel, expire)
  -- change the order too; the column holds utc time without a zone, as prisma writes it
  NEW."updatedAt" := now() AT TIME ZONE 'UTC';

  IF OLD."confirmed" THEN
    IF NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."total" IS DISTINCT FROM OLD."total"
       OR NEW."shippingAddress" IS DISTINCT FROM OLD."shippingAddress"
       OR NEW."recipientFirstName" IS DISTINCT FROM OLD."recipientFirstName"
       OR NEW."recipientLastName" IS DISTINCT FROM OLD."recipientLastName"
       OR NEW."recipientPhone" IS DISTINCT FROM OLD."recipientPhone"
       OR COALESCE(NEW."note", '') IS DISTINCT FROM COALESCE(OLD."note", '')
    THEN
      RAISE EXCEPTION 'ORDER_CONFIRMED_CHANGE_FORBIDDEN'
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  IF NOT OLD."confirmed" AND NEW."confirmed" THEN
    IF NEW."shippingAddress" IS NULL
       OR btrim(NEW."shippingAddress") = '' THEN
      RAISE EXCEPTION 'ORDER_SHIPPING_ADDRESS_REQUIRED'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."recipientFirstName" IS NULL
       OR btrim(NEW."recipientFirstName") = '' THEN
      RAISE EXCEPTION 'ORDER_RECIPIENT_FIRST_NAME_REQUIRED'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."recipientLastName" IS NULL
       OR btrim(NEW."recipientLastName") = '' THEN
      RAISE EXCEPTION 'ORDER_RECIPIENT_LAST_NAME_REQUIRED'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."recipientPhone" IS NULL
       OR btrim(NEW."recipientPhone") = '' THEN
      RAISE EXCEPTION 'ORDER_RECIPIENT_PHONE_REQUIRED'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(SUM(oi."totalPrice"), 0)
    INTO v_total
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = OLD.id;

    NEW."total" := v_total;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_before_update ON cartlify.orders;

CREATE TRIGGER trg_orders_before_update
BEFORE UPDATE ON cartlify.orders FOR EACH ROW
EXECUTE FUNCTION cartlify.orders_before_update ();

------------------------------------------------------------
-- REVIEWS AND VOTES
------------------------------------------------------------
-- REVIEWS AND VOTES === system functions ===
-- REVIEWS AND VOTES recalc review vote counters
-- internal: only the review votes trigger calls it, the app has no execute right (db/01)
CREATE OR REPLACE FUNCTION cartlify.recalc_review_votes (p_review_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_up integer;
  v_down integer;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE rv."action" = 'UP'),
    COUNT(*) FILTER (WHERE rv."action" = 'DOWN')
  INTO
    v_up,
    v_down
  FROM cartlify.review_votes AS rv
  WHERE rv."reviewId" = p_review_id;

  UPDATE cartlify.reviews AS r
  SET
    "upVotes" = COALESCE(v_up, 0),
    "downVotes" = COALESCE(v_down, 0)
  WHERE r.id = p_review_id;
END;
$$;

-- REVIEWS AND VOTES === triggers & functions ===
-- REVIEWS AND VOTES guard review rating and protected keys before update
CREATE OR REPLACE FUNCTION cartlify.reviews_lock_rating_and_keys () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."rating" IS NOT NULL AND NEW."rating" IS DISTINCT FROM OLD."rating" THEN
    IF NEW."rating" IS NULL THEN
      NEW."rating" := OLD."rating";
    ELSE
      RAISE EXCEPTION 'REVIEW_RATING_UPDATE_FORBIDDEN';
    END IF;
  END IF;

  IF NEW."userId" IS DISTINCT FROM OLD."userId" THEN
    RAISE EXCEPTION 'REVIEW_USER_CHANGE_FORBIDDEN';
  END IF;

  IF NEW."productId" IS DISTINCT FROM OLD."productId" THEN
    RAISE EXCEPTION 'REVIEW_PRODUCT_CHANGE_FORBIDDEN';
  END IF;

  IF (OLD."comment" IS NOT NULL AND btrim(OLD."comment") <> '')
    AND NEW."comment" IS DISTINCT FROM OLD."comment"
  THEN
    IF NEW."comment" IS NULL OR btrim(NEW."comment") = '' THEN
      NEW."comment" := OLD."comment";
    ELSE
      RAISE EXCEPTION 'REVIEW_COMMENT_UPDATE_FORBIDDEN';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reviews_lock_rating_and_keys ON cartlify.reviews;

CREATE TRIGGER trg_reviews_lock_rating_and_keys
BEFORE UPDATE ON cartlify.reviews FOR EACH ROW
EXECUTE FUNCTION cartlify.reviews_lock_rating_and_keys ();

-- REVIEWS AND VOTES a product removed from the catalog gets no new review and goes into no
-- favorites; what it had before the removal stays (the app hides it). The same rule as the items
-- of an order (order_items_before_ins_upd)
CREATE OR REPLACE FUNCTION cartlify.refuse_removed_product () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cartlify.products AS p
    WHERE p.id = NEW."productId"
      AND p."deletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reviews_refuse_removed_product ON cartlify.reviews;

CREATE TRIGGER trg_reviews_refuse_removed_product
BEFORE INSERT ON cartlify.reviews FOR EACH ROW
EXECUTE FUNCTION cartlify.refuse_removed_product ();

DROP TRIGGER IF EXISTS trg_favorites_refuse_removed_product ON cartlify.favorites;

CREATE TRIGGER trg_favorites_refuse_removed_product
BEFORE INSERT ON cartlify.favorites FOR EACH ROW
EXECUTE FUNCTION cartlify.refuse_removed_product ();

-- REVIEWS AND VOTES sync review vote counters after vote changes
-- trigger: runs as the owner, the recalc function it calls is internal and closed for the app;
-- a trigger function cannot be called directly, only the trigger fires it
CREATE OR REPLACE FUNCTION cartlify.review_votes_after_mod () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_review_id integer;
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    v_review_id := NEW."reviewId";
  ELSE
    v_review_id := OLD."reviewId";
  END IF;

  PERFORM cartlify.recalc_review_votes(v_review_id);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_review_votes_after_mod ON cartlify.review_votes;

CREATE TRIGGER trg_review_votes_after_mod
AFTER INSERT OR UPDATE OR DELETE ON cartlify.review_votes FOR EACH ROW
EXECUTE FUNCTION cartlify.review_votes_after_mod ();

------------------------------------------------------------
-- CHAT
------------------------------------------------------------
-- CHAT === triggers & functions ===
-- CHAT guard chat messages before update: only read flag can change
CREATE OR REPLACE FUNCTION cartlify.chat_messages_before_update () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'isRead') IS DISTINCT FROM (to_jsonb(OLD) - 'isRead') THEN
    RAISE EXCEPTION 'CHAT_MESSAGE_UPDATE_FORBIDDEN';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_messages_before_update ON cartlify.chat_messages;

CREATE TRIGGER trg_chat_messages_before_update
BEFORE UPDATE ON cartlify.chat_messages FOR EACH ROW
EXECUTE FUNCTION cartlify.chat_messages_before_update ();

------------------------------------------------------------
-- PRICE CHANGE LOGS
------------------------------------------------------------
-- PRICE CHANGE LOGS === system functions ===
-- PRICE CHANGE LOGS the version that took the actor as a parameter: anyone could be named in a line;
-- a temporary line, it goes once dev and prod match the reference
DROP FUNCTION IF EXISTS cartlify.log_product_price_change (integer, integer, numeric, numeric, cartlify."PriceChangeMode", numeric);

-- PRICE CHANGE LOGS the version without the end of a sale (21.10.2026): a call of five arguments
-- would match both versions; a temporary line, it goes once dev and prod match the reference
DROP FUNCTION IF EXISTS cartlify.log_product_price_change (integer, numeric, numeric, cartlify."PriceChangeMode", numeric);

-- PRICE CHANGE LOGS insert product price change log entry
-- system function: runs as the owner, the app writes no line straight into the table (db/03);
-- the actor of a line is the admin of the context, a signed-in admin with an id is required.
-- p_mode is how the change was given, p_value is its size in that mode: the percent of the price
-- or the amount of money, negative for a change down. A line with an end (p_ends_at) is the start
-- of a sale, from the price down to the sale price (db/06); a sale taken off goes from the sale
-- price back to the price. A change that changes nothing is no line
CREATE OR REPLACE FUNCTION cartlify.log_product_price_change (
  p_product_id integer,
  p_old_price numeric,
  p_new_price numeric,
  p_mode cartlify."PriceChangeMode",
  p_value numeric,
  p_ends_at timestamp DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor_id integer;
BEGIN
  IF NOT cartlify.is_admin() THEN
    RAISE EXCEPTION 'PRICE_LOG_FORBIDDEN';
  END IF;

  v_actor_id := cartlify.current_actor_id();

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'PRICE_LOG_ACTOR_REQUIRED';
  END IF;

  IF p_old_price IS NOT DISTINCT FROM p_new_price THEN
    RETURN;
  END IF;

  INSERT INTO cartlify."product_price_change_logs" (
    "productId",
    "actorId",
    "oldPrice",
    "newPrice",
    "mode",
    "value",
    "endsAt",
    "createdAt"
  )
  VALUES (
    p_product_id,
    v_actor_id,
    p_old_price,
    p_new_price,
    p_mode,
    p_value,
    p_ends_at,
    now()
  );
END;
$$;

------------------------------------------------------------
-- LOGS
------------------------------------------------------------
-- LOGS === system functions ===
-- LOGS the logins of a deleted account take the email the account has now (deleted+<id>+...,
-- the one its row of users keeps); the rest of a line stays.
-- system function: runs as the owner, the row policies deny every other change of a log line
-- (the data scripts of a superuser still clear the tables); callable by root, who deletes an
-- account (db/03 lets only root change an email), or by the system; only for a deleted account
CREATE OR REPLACE FUNCTION cartlify.anonymize_login_logs (p_user_id integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_email text;
  v_count integer;
BEGIN
  IF NOT cartlify.is_root() AND NOT cartlify.is_system() THEN
    RAISE EXCEPTION 'LOGIN_LOGS_ANONYMIZE_FORBIDDEN';
  END IF;

  SELECT u.email
  INTO v_email
  FROM cartlify.users AS u
  WHERE u.id = p_user_id
    AND u."deletedAt" IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_DELETED';
  END IF;

  UPDATE cartlify.login_logs AS l
  SET email = v_email
  WHERE l."userId" = p_user_id
    AND l.email IS DISTINCT FROM v_email;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

------------------------------------------------------------
-- ADMIN AUDIT LOG
------------------------------------------------------------
-- ADMIN AUDIT LOG === system functions ===
-- ADMIN AUDIT LOG insert admin audit log entry
CREATE OR REPLACE FUNCTION cartlify.log_admin_action (
  p_actor_id integer,
  p_actor_role cartlify."Role",
  p_entity_type cartlify."AdminAuditEntityType",
  p_entity_id integer,
  p_action cartlify."AdminAuditAction",
  p_changes jsonb
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN

  IF p_changes IS NOT NULL AND jsonb_typeof(p_changes) <> 'array' THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_CHANGES_NOT_ARRAY'
      USING HINT = 'expected an array of {field, old, new} objects';
  END IF;

  -- the address and the browser of the request the server does the work for, from the context of
  -- the transaction (empty without a request, the worker has none); no right, only a record
  INSERT INTO cartlify.admin_audit_log (
    "actorId",
    "actorRole",
    "entityType",
    "entityId",
    action,
    meta,
    ip,
    "userAgent",
    "createdAt"
  )
  VALUES (
    p_actor_id,
    p_actor_role,
    p_entity_type,
    p_entity_id,
    p_action,
    p_changes,
    nullif(current_setting('cartlify.request_ip', true), ''),
    nullif(current_setting('cartlify.request_user_agent', true), ''),
    now()
  );
END;
$$;

------------------------------------------------------------
-- MIGRATION AND MAINTENANCE
------------------------------------------------------------
-- MIGRATION AND MAINTENANCE remove the tokens used or ended more than p_keep_days ago: a renewal of
-- a session adds a row each time and closes the one before, the links of the mails stay after
-- they are used. A token used lately stays: a renewed one coming back is how a theft is seen.
-- The work of the system (the admin context without a user id), a periodic task of Railway:
-- SELECT cartlify.cleanup_user_tokens(30); the admin context may delete tokens anyway, so it runs
-- with the rights of the caller. Returns how many rows went
CREATE OR REPLACE FUNCTION cartlify.cleanup_user_tokens (p_keep_days integer) RETURNS integer LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_before  timestamp;
  v_removed integer;
BEGIN
  IF NOT cartlify.is_system() THEN
    RAISE EXCEPTION 'USER_TOKENS_CLEANUP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_keep_days IS NULL OR p_keep_days < 1 THEN
    RAISE EXCEPTION 'USER_TOKENS_CLEANUP_KEEP_DAYS_INVALID' USING ERRCODE = '22023';
  END IF;

  v_before := (now() AT TIME ZONE 'UTC') - make_interval(days => p_keep_days);

  DELETE FROM cartlify.user_tokens AS t
  WHERE t."usedAt" < v_before
     OR t."expiresAt" < v_before;

  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$$;

-- MIGRATION AND MAINTENANCE how long the shop keeps what it needs no longer (4.18): the address and
-- the browser of old logins, the favorites and the chats of guests who stopped coming, the chats of
-- accounts deleted long ago. Each is the work of the system (the admin context without a user id),
-- a periodic task of Railway runs it with the days it keeps, e.g. SELECT * FROM
-- cartlify.cleanup_guest_data(180); it runs as the owner and reaches the rows through narrow
-- policies (db/03) and the guard of the login log (below)
CREATE OR REPLACE FUNCTION cartlify.retention_cutoff (p_keep_days integer) RETURNS timestamp LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  IF NOT cartlify.is_system() THEN
    RAISE EXCEPTION 'RETENTION_CLEANUP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_keep_days IS NULL OR p_keep_days < 1 THEN
    RAISE EXCEPTION 'RETENTION_CLEANUP_KEEP_DAYS_INVALID' USING ERRCODE = '22023';
  END IF;

  -- prisma keeps dates as utc in columns without a time zone
  RETURN (now() AT TIME ZONE 'UTC') - make_interval(days => p_keep_days);
END;
$$;

-- MIGRATION AND MAINTENANCE the address and the browser of the logins older than p_keep_days go,
-- the line stays history (who logged in, when, with which role). Returns how many lines it emptied
CREATE OR REPLACE FUNCTION cartlify.cleanup_login_log_addresses (p_keep_days integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_before timestamp := cartlify.retention_cutoff(p_keep_days);
  v_count  integer;
BEGIN
  UPDATE cartlify.login_logs AS l
  SET
    "ipAddress" = NULL,
    "userAgent" = NULL
  WHERE l."createdAt" < v_before
    AND (l."ipAddress" IS NOT NULL OR l."userAgent" IS NOT NULL);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- MIGRATION AND MAINTENANCE the favorites and the chats of a guest who has not come for longer than
-- p_keep_days go: the last favorite and the last message of the guest are older. A guest who came
-- lately keeps all of it, an old favorite too; the messages go with their chats
CREATE OR REPLACE FUNCTION cartlify.cleanup_guest_data (p_keep_days integer) RETURNS TABLE (
  removed_favorites integer,
  removed_chats integer
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_before timestamp := cartlify.retention_cutoff(p_keep_days);
  v_guests uuid[];
BEGIN
  SELECT coalesce(array_agg(idle.g), '{}')
  INTO v_guests
  FROM (
    SELECT a.g
    FROM (
      SELECT f."guestId" AS g, f."createdAt" AS at
      FROM cartlify.favorites AS f
      WHERE f."userId" IS NULL AND f."guestId" IS NOT NULL
      UNION ALL
      SELECT t."guestId", t."lastMessageAt"
      FROM cartlify.chat_threads AS t
      WHERE t."userId" IS NULL AND t."guestId" IS NOT NULL
    ) AS a
    GROUP BY a.g
    HAVING max(a.at) < v_before
  ) AS idle;

  DELETE FROM cartlify.favorites AS f
  WHERE f."userId" IS NULL AND f."guestId" = ANY (v_guests);
  GET DIAGNOSTICS removed_favorites = ROW_COUNT;

  DELETE FROM cartlify.chat_threads AS t
  WHERE t."userId" IS NULL AND t."guestId" = ANY (v_guests);
  GET DIAGNOSTICS removed_chats = ROW_COUNT;

  RETURN NEXT;
END;
$$;

-- MIGRATION AND MAINTENANCE the chats of the accounts deleted more than p_keep_days ago go with
-- their messages; a deletion keeps them for a while (an admin may still need the conversation).
-- Returns how many chats went
CREATE OR REPLACE FUNCTION cartlify.cleanup_deleted_accounts_chats (p_keep_days integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_before timestamp := cartlify.retention_cutoff(p_keep_days);
  v_count  integer;
BEGIN
  DELETE FROM cartlify.chat_threads AS t
  USING cartlify.users AS u
  WHERE u.id = t."userId"
    AND u."deletedAt" IS NOT NULL
    AND u."deletedAt" < v_before;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- MIGRATION AND MAINTENANCE === system functions ===
-- MIGRATION AND MAINTENANCE migrate guest data to user after authentication
-- system function: runs as the owner, a user cannot see or change guest rows;
-- callable only by the user who has just signed in (user, admin or root), and only for themselves.
-- guest rows are reached through the narrow *_owner policies in db/03, no session flag is involved
CREATE OR REPLACE FUNCTION cartlify.migrate_guest_data_to_user (p_guest_id uuid, p_user_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  IF cartlify.current_actor_role() IS NULL
     OR cartlify.current_actor_role() NOT IN ('USER', 'ADMIN', 'ROOT')
     OR cartlify.current_actor_id() IS DISTINCT FROM p_user_id
  THEN
    RAISE EXCEPTION 'GUEST_MIGRATION_FORBIDDEN';
  END IF;

  IF p_guest_id IS NULL OR p_user_id IS NULL THEN
    RETURN;
  END IF;

  -- FAVORITES: remove conflicts (user already has same product)
  DELETE FROM cartlify.favorites f
  WHERE f."guestId" = p_guest_id
    AND EXISTS (
      SELECT 1
      FROM cartlify.favorites u
      WHERE u."userId" = p_user_id
        AND u."productId" = f."productId"
    );

  -- FAVORITES: migrate guest -> user
  UPDATE cartlify.favorites
  SET "userId"  = p_user_id,
      "guestId" = NULL
  WHERE "guestId" = p_guest_id;

-- CHAT THREADS: migrate guest threads to user
WITH selected_open_guest_thread AS (
  SELECT
    id
  FROM
    cartlify.chat_threads
  WHERE
    "guestId" = p_guest_id
    AND status = 'open'
  ORDER BY
    "lastMessageAt" DESC
  LIMIT
    1
),
existing_open_user_thread AS (
  SELECT
    id
  FROM
    cartlify.chat_threads
  WHERE
    "userId" = p_user_id
    AND status = 'open'
  LIMIT
    1
)
UPDATE cartlify.chat_threads t
SET
  "userId" = p_user_id,
  "guestId" = NULL,
  status = CASE
    WHEN t.status = 'open'
      AND (
        EXISTS (
          SELECT
            1
          FROM
            existing_open_user_thread
        )
        OR t.id <> COALESCE(
          (
            SELECT
              id
            FROM
              selected_open_guest_thread
          ),
          t.id
        )
      )
    THEN 'closed'::cartlify."ChatStatus"
    ELSE t.status
  END,
  "unreadCount" = CASE
    WHEN t.status = 'open'
      AND (
        EXISTS (
          SELECT
            1
          FROM
            existing_open_user_thread
        )
        OR t.id <> COALESCE(
          (
            SELECT
              id
            FROM
              selected_open_guest_thread
          ),
          t.id
        )
      )
    THEN 0
    ELSE t."unreadCount"
  END,
  "adminRequestedAt" = CASE
    WHEN t.status = 'open'
      AND (
        EXISTS (
          SELECT
            1
          FROM
            existing_open_user_thread
        )
        OR t.id <> COALESCE(
          (
            SELECT
              id
            FROM
              selected_open_guest_thread
          ),
          t.id
        )
      )
    THEN NULL
    ELSE t."adminRequestedAt"
  END,
  "adminUnreadSince" = CASE
    WHEN t.status = 'open'
      AND (
        EXISTS (
          SELECT
            1
          FROM
            existing_open_user_thread
        )
        OR t.id <> COALESCE(
          (
            SELECT
              id
            FROM
              selected_open_guest_thread
          ),
          t.id
        )
      )
    THEN NULL
    ELSE t."adminUnreadSince"
  END,
  "updatedAt" = now()
WHERE
  t."guestId" = p_guest_id;
END;
$$;

------------------------------------------------------------
-- UPDATE GUARDS: which columns an update may change
------------------------------------------------------------
-- The policies of db/03 say who may update a row; these triggers say what the update may change,
-- comparing NEW with OLD. A policy that read the old row again by a subquery saw the version from
-- the start of the statement: an update that waited for the lock of the row and then changed the
-- version another transaction left (a view of a product while it is paid for) looked as if it
-- changed what the other one did, and failed with 42501. OLD is the version the update changes.
-- Each trigger keeps the branches of the policies of its table: the update passes when one of
-- them lets it.
-- The functions run as the role of the statement, not as the owner: current_user tells an update
-- of the app (cartlify_app) from a step of the database (cartlify_owner, a security definer
-- function). A superuser (a data script by hand) is not checked, as rls does not check it either.
-- Each trigger is named to run after the other before-update triggers of its table, so it checks
-- the row they leave.

-- UPDATE GUARDS the columns of NEW that differ from OLD
-- an expression in every guard, not a function: the app has no execute right on internal functions

-- UPDATE GUARDS users: the owner changes its row but its email, role, verification and deletion;
-- root changes anything; the steps of the database verify an email or remove an avatar
CREATE OR REPLACE FUNCTION cartlify.users_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF cartlify.is_owner(NEW.id)
     AND NEW.role = cartlify.current_actor_role()
     AND NEW."deletedAt" IS NULL
     AND NEW.email = OLD.email
     AND NEW.role = OLD.role
     AND (
       NEW."isVerified" = OLD."isVerified"
       OR (
         OLD."authProvider" = 'LOCAL'
         AND NEW."authProvider" <> 'LOCAL'
         AND NEW."isVerified" = true
         AND NEW."passwordHash" IS NULL
       )
     ) THEN
    RETURN NEW;
  END IF;

  IF cartlify.is_root() THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner'
     AND (
       (NEW."isVerified" = true AND v_changed <@ ARRAY['isVerified', 'updatedAt'])
       OR (
         NEW."avatarUrl" IS NULL
         AND NEW."publicId" IS NULL
         AND v_changed <@ ARRAY['avatarUrl', 'publicId', 'updatedAt']
       )
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'USER_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_users_update_columns ON cartlify.users;

CREATE TRIGGER trg_users_update_columns
BEFORE UPDATE ON cartlify.users FOR EACH ROW
EXECUTE FUNCTION cartlify.users_update_columns ();

-- UPDATE GUARDS user tokens: a token keeps its user, its kind, its session and its browser, a
-- closed token stays closed, a session gets its hash and deadline once it is made, every other
-- link keeps them and is only closed; a session is revoked only as it is closed (db/06: at that
-- moment), so a token closed by its renewal stays the sign of theft it is when it comes back;
-- the steps of the database close a link of an email verification
CREATE OR REPLACE FUNCTION cartlify.user_tokens_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF cartlify.is_owner_or_admin(NEW."userId")
     AND NEW."userId" = OLD."userId"
     AND NEW.type = OLD.type
     AND NEW."sessionId" IS NOT DISTINCT FROM OLD."sessionId"
     AND NEW."userAgent" IS NOT DISTINCT FROM OLD."userAgent"
     AND (OLD."usedAt" IS NULL OR NEW."usedAt" IS NOT NULL)
     AND (
       NEW."revokedAt" IS NOT DISTINCT FROM OLD."revokedAt"
       OR (OLD."revokedAt" IS NULL AND OLD."usedAt" IS NULL)
     )
     AND (
       NEW.type = 'REFRESH_TOKEN'
       OR (NEW.token = OLD.token AND NEW."expiresAt" = OLD."expiresAt")
     ) THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner'
     AND NEW.type = 'VERIFY_EMAIL'
     AND NEW."usedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'USER_TOKEN_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_user_tokens_update_columns ON cartlify.user_tokens;

CREATE TRIGGER trg_user_tokens_update_columns
BEFORE UPDATE ON cartlify.user_tokens FOR EACH ROW
EXECUTE FUNCTION cartlify.user_tokens_update_columns ();

-- UPDATE GUARDS login logs: history, only anonymize_login_logs gives a line of a deleted account
-- the email the account has now
CREATE OR REPLACE FUNCTION cartlify.login_logs_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner'
     AND v_changed <@ ARRAY['email']
     AND EXISTS (
       SELECT 1
       FROM cartlify.users AS u
       WHERE u.id = NEW."userId"
         AND u."deletedAt" IS NOT NULL
         AND u.email = NEW.email
     ) THEN
    RETURN NEW;
  END IF;

  -- cleanup_login_log_addresses: the address and the browser of an old login go, nothing else
  IF current_user = 'cartlify_owner'
     AND v_changed <@ ARRAY['ipAddress', 'userAgent']
     AND NEW."ipAddress" IS NULL
     AND NEW."userAgent" IS NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'LOGIN_LOG_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_login_logs_update_columns ON cartlify.login_logs;

CREATE TRIGGER trg_login_logs_update_columns
BEFORE UPDATE ON cartlify.login_logs FOR EACH ROW
EXECUTE FUNCTION cartlify.login_logs_update_columns ();

-- UPDATE GUARDS products: an admin changes everything but what the database counts and adds one
-- view like anybody; a guest or a user adds a view; the steps of the database change one group of
-- what they count at a time (the rating, the stock and the reserve, the popularity)
CREATE OR REPLACE FUNCTION cartlify.products_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF cartlify.is_admin()
     AND NEW."stock" = OLD."stock"
     AND NEW."reservedStock" = OLD."reservedStock"
     AND NEW."avgRating" = OLD."avgRating"
     AND NEW."reviewsCount" = OLD."reviewsCount"
     AND NEW.popularity = OLD.popularity
     AND NEW.views IN (OLD.views, OLD.views + 1) THEN
    RETURN NEW;
  END IF;

  IF cartlify.current_actor_role() IN ('GUEST', 'USER')
     AND v_changed <@ ARRAY['views', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner'
     AND (
       (
         NEW."avgRating" >= 0
         AND NEW."avgRating" <= 5
         AND NEW."reviewsCount" >= 0
         AND v_changed <@ ARRAY['avgRating', 'reviewsCount', 'updatedAt']
       )
       OR (
         NEW."stock" >= 0
         AND NEW."reservedStock" >= 0
         AND NEW."reservedStock" <= NEW."stock"
         AND v_changed <@ ARRAY['stock', 'reservedStock', 'updatedAt']
       )
       OR (NEW.popularity >= 0 AND v_changed <@ ARRAY['popularity', 'updatedAt'])
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'PRODUCT_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_products_update_columns ON cartlify.products;

CREATE TRIGGER trg_products_update_columns
BEFORE UPDATE ON cartlify.products FOR EACH ROW
EXECUTE FUNCTION cartlify.products_update_columns ();

-- UPDATE GUARDS product batches: a sale, a write-off or a cancel changes only what a batch has left
CREATE OR REPLACE FUNCTION cartlify.product_batches_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner' AND v_changed <@ ARRAY['remaining'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'PRODUCT_BATCH_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_product_batches_update_columns ON cartlify.product_batches;

CREATE TRIGGER trg_product_batches_update_columns
BEFORE UPDATE ON cartlify.product_batches FOR EACH ROW
EXECUTE FUNCTION cartlify.product_batches_update_columns ();

-- UPDATE GUARDS reviews: the author adds the missing rating or comment and nothing else; the
-- steps of the database count the votes
CREATE OR REPLACE FUNCTION cartlify.reviews_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF cartlify.is_owner(NEW."userId")
     AND (
       NEW."rating" IS NOT NULL
       OR (NEW."comment" IS NOT NULL AND btrim(NEW."comment") <> '')
     )
     AND v_changed <@ ARRAY['rating', 'comment', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner'
     AND NEW."upVotes" >= 0
     AND NEW."downVotes" >= 0 THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'REVIEW_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_reviews_update_columns ON cartlify.reviews;

CREATE TRIGGER trg_reviews_update_columns
BEFORE UPDATE ON cartlify.reviews FOR EACH ROW
EXECUTE FUNCTION cartlify.reviews_update_columns ();

-- UPDATE GUARDS orders: the owner of an unconfirmed order writes the shipping data and the note;
-- an admin or root takes the shipping steps; the steps of the database change the total, the
-- confirmation and the reservation, the payment, and the cancel of an admin
CREATE OR REPLACE FUNCTION cartlify.orders_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF cartlify.is_owner(NEW."userId")
     AND NEW."paymentId" IS NULL
     AND NEW."paymentProvider" IS NULL
     AND NEW.confirmed = false
     AND NEW.status IN ('pending', 'unconfirmed')
     AND NEW."reservationExpiresAt" IS NULL
     AND v_changed <@ ARRAY[
       'shippingAddress', 'recipientFirstName', 'recipientLastName', 'recipientPhone', 'note',
       'updatedAt'
     ] THEN
    RETURN NEW;
  END IF;

  IF cartlify.current_actor_role() IN ('ADMIN', 'ROOT')
     AND NEW.status IN ('shipped', 'delivered')
     AND v_changed <@ ARRAY['status', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner'
     AND (
       (NEW."total" >= 0 AND v_changed <@ ARRAY['total', 'updatedAt'])
       OR (
         NEW.confirmed = false
         AND NEW.status IN ('pending', 'unconfirmed')
         AND NEW."reservationExpiresAt" IS NULL
         AND v_changed <@ ARRAY['confirmed', 'status', 'reservationExpiresAt', 'updatedAt']
       )
       OR (
         NEW.confirmed = true
         AND NEW.status = 'waiting'
         AND NEW."reservationExpiresAt" IS NOT NULL
         AND NEW."paymentId" IS NULL
         AND NEW."paymentProvider" IS NULL
         AND NEW."total" >= 0
         AND cartlify.is_owner(NEW."userId")
         AND v_changed <@ ARRAY['confirmed', 'status', 'reservationExpiresAt', 'total', 'updatedAt']
       )
       -- pay_order: the payment, who took it and when are set together, nothing else but the
       -- state changes
       OR (
         NEW.confirmed = true
         AND NEW.status = 'paid'
         AND NEW."reservationExpiresAt" IS NULL
         AND NEW."paymentId" IS NOT NULL
         AND NEW."paymentProvider" IS NOT NULL
         AND NEW."paidAt" IS NOT NULL
         AND NEW."total" >= 0
         AND v_changed <@ ARRAY[
           'confirmed', 'status', 'reservationExpiresAt', 'paymentId', 'paymentProvider', 'paidAt',
           'total', 'updatedAt'
         ]
       )
       -- cancel_paid_order: a paid or shipped order of the admin context becomes cancelled with
       -- the time of the cancel
       OR (
         cartlify.current_actor_role() IN ('ADMIN', 'ROOT')
         AND NEW.status = 'cancelled'
         AND NEW."cancelledAt" IS NOT NULL
         AND v_changed <@ ARRAY['status', 'cancelledAt', 'updatedAt']
       )
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ORDER_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_update_columns ON cartlify.orders;

CREATE TRIGGER trg_orders_update_columns
BEFORE UPDATE ON cartlify.orders FOR EACH ROW
EXECUTE FUNCTION cartlify.orders_update_columns ();

-- UPDATE GUARDS chat threads: a chat keeps its user or guest, a closed chat stays closed, a request
-- for an admin is made now, never earlier (the queue goes by adminRequestedAt; a minute is left
-- for the clock of the server); migrate_guest_data_to_user makes a guest chat a chat of the user
CREATE OR REPLACE FUNCTION cartlify.chat_threads_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF (
       cartlify.is_owner_or_admin(NEW."userId")
       OR (
         cartlify.current_actor_role() = 'GUEST'
         AND NEW."guestId" = cartlify.current_guest_id()
       )
     )
     AND NEW."userId" IS NOT DISTINCT FROM OLD."userId"
     AND NEW."guestId" IS NOT DISTINCT FROM OLD."guestId"
     AND (OLD.status <> 'closed' OR NEW.status = 'closed')
     AND (
       NEW."adminRequestedAt" IS NULL
       OR NEW."adminRequestedAt" IS NOT DISTINCT FROM OLD."adminRequestedAt"
       OR NEW."adminRequestedAt" >= (now() AT TIME ZONE 'UTC') - interval '1 minute'
     ) THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner'
     AND NEW."userId" IS NOT NULL
     AND NEW."guestId" IS NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'CHAT_THREAD_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_threads_update_columns ON cartlify.chat_threads;

CREATE TRIGGER trg_chat_threads_update_columns
BEFORE UPDATE ON cartlify.chat_threads FOR EACH ROW
EXECUTE FUNCTION cartlify.chat_threads_update_columns ();

-- UPDATE GUARDS admin alert settings: an admin or root changes whether a kind of their alerts is
-- on and its threshold, never whose the row is or which kind
CREATE OR REPLACE FUNCTION cartlify.admin_alert_settings_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF v_changed <@ ARRAY['subscribed', 'threshold'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ADMIN_ALERT_SETTING_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_admin_alert_settings_update_columns ON cartlify.admin_alert_settings;

CREATE TRIGGER trg_admin_alert_settings_update_columns
BEFORE UPDATE ON cartlify.admin_alert_settings FOR EACH ROW
EXECUTE FUNCTION cartlify.admin_alert_settings_update_columns ();

COMMIT;