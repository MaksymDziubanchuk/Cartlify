BEGIN;

-- A busy table makes the script wait for its lock, and every request of the app waits behind
-- the script. After 5 s the script stops and is run again (db-run-sql.yml).
SET LOCAL lock_timeout = '5s';

-- Everything below is created and owned by cartlify_owner, whoever runs the script.
SET LOCAL ROLE cartlify_owner;

------------------------------------------------------------
-- CONTEXT HELPERS
------------------------------------------------------------

-- The actor context lives in three settings that last until the end of the transaction
-- (cartlify.role, cartlify.user_id, cartlify.guest_id). The server sets them first in every
-- transaction (src/db/dbContext.service.ts); the policies and the system functions only read
-- them, through the helpers below.

-- Sets the actor of the transaction. A GUEST context carries a guest id, any other role carries
-- a user id. An ADMIN context without a user id is "the system" (see is_system).
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

-- Returns the user id of the context, or NULL for a guest, the system or no context.
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

-- Returns the guest id of the context, or NULL when it is empty or not a uuid.
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

-- Returns the role of the context, or NULL when there is none or it is not a known role.
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

-- True for ADMIN and ROOT, the system included; false without a context.
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

-- True for ROOT only.
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

-- True when the server acts as the system: the ADMIN role without a user id, as setAdminContext
-- sets it (the payment webhook, the reservation worker, the password reset, periodic jobs). A
-- signed-in admin always has an id.
CREATE OR REPLACE FUNCTION cartlify.is_system () RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN cartlify.current_actor_role() IS NOT DISTINCT FROM 'ADMIN'
    AND cartlify.current_actor_id() IS NULL;
END;
$$;

-- True when the signed-in actor has this user id.
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

-- True for an admin or root, and for the owner of the row.
CREATE OR REPLACE FUNCTION cartlify.is_owner_or_admin (p_user_id integer) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN cartlify.is_admin() OR cartlify.is_owner(p_user_id);
END;
$$;

------------------------------------------------------------
-- AUTH AND USERS
------------------------------------------------------------

-- Reads the login data of an account by email (trimmed, lower case); no row when there is no
-- such account. System function: runs as the owner, a guest cannot read users. Only a guest may
-- call it, a login always starts from the guest context (LOGIN_LOOKUP_FORBIDDEN).
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

-- Reads the profile of an account by id. System function: runs as the owner, RLS shows a user
-- only their own row. Callable by a signed-in user, admin or root, never by a guest
-- (USER_PROFILE_READ_FORBIDDEN). A user gets the name, the avatar and the dates, the other
-- fields are null (the own email too, a user reads it from /users/me). An admin or root gets the
-- whole profile and also sees a deleted account; for everybody else it is no row. The password
-- hash, the provider id and the id of the avatar file are not in the result.
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

-- Takes the avatar of another account away (moderation). System function: runs as the owner,
-- because only root may change the row of another account by plain SQL; the policy for the
-- owner role lets this function update the row, and trg_users_update_columns limits the change to
-- the avatar fields and the time of the change, nothing else. Callable by a signed-in admin or root with an id, never by the system
-- (USER_AVATAR_REMOVE_FORBIDDEN, also when an admin aims at an account that is not a USER).
-- An admin takes the avatar of a USER account only, root of any account; the own avatar goes
-- through PATCH /api/users/me. The result says whether an avatar was taken, read under the lock
-- of the row: the id of its file (the server deletes the file after the commit) and its address.
-- removed is false when the account had none.
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

-- Issues a new email verification link for an unverified account and closes the open ones, so
-- only the newest link works. p_token is the hash of the link: the database never keeps the
-- link itself, so an earlier link cannot be mailed again. No row comes back when the email is
-- unknown, the account is verified, or an input is empty or already expired. System function:
-- runs as the owner, a guest cannot read users or write tokens. Callable only by a guest, a
-- user asks for a new link before the first login (VERIFY_RESEND_FORBIDDEN).
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

  -- clean the inputs; an input that cannot work returns no row
  p_email := lower(btrim(p_email));
  p_token := btrim(p_token);

  IF p_email IS NULL OR p_email = '' THEN RETURN; END IF;
  IF p_token IS NULL OR p_token = '' THEN RETURN; END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN RETURN; END IF;

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

-- Consumes an email verification link and marks the account verified. Returns true when the
-- link was open and not expired, false for an empty, unknown, used or expired one. p_token is
-- the hash of the link, the same value the registration and the resend store. System function:
-- runs as the owner, a guest cannot read tokens or verify a user. Callable only by a guest, the
-- link is opened before the first login (VERIFY_EMAIL_FORBIDDEN).
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

-- Keeps the email in lower case without spaces around it: the login and the password reset
-- look an account up in that form, and the unique email then holds one account per address. An
-- email that does not change is not touched, so older rows keep theirs.
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

-- Blocks a loop in the tree of categories (CATEGORY_PARENT_CYCLE). The tree goes one way, from
-- the top down: a category never goes inside its own branch (under itself or under one of its
-- subcategories), that would make a loop with no top. Changes of the tree wait for each other
-- (an advisory lock for the transaction), so two moves at the same time cannot make a loop
-- that neither of them makes alone. The walk up stops at a row it has seen, so a loop that
-- already exists cannot hold it forever.
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

-- Gives the price a product sells at now: the sale price while the end of the sale is ahead,
-- the price otherwise. A sale that is over keeps its fields until the next sale writes over
-- them or the price goes down to them (products_before_price_change), but it is no price any
-- more. The order items, the price check of confirm_order and the catalog (sort, filters) take
-- this price. Prisma keeps dates as utc in columns without a time zone, so the end is compared
-- in utc.
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

-- Recalculates the average rating and the number of reviews with a comment of a product.
-- Internal: only the trigger of the reviews calls it, the app has no execute right (db/01).
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

-- Stock and batches. The stock of a product is what its batches have left; every step that
-- changes one changes the other in the same transaction: a batch taken in, a sale, a write-off,
-- a cancel. Only the functions below change them, the batches and the stock are closed for plain
-- changes (db/03). Costs go into the admin log as text without a trailing zero (trim_scale:
-- 1.50 becomes 1.5).

-- Gives the day of the shop: the server sets it with the context of every transaction
-- (cartlify.shop_today, yyyy-mm-dd, by the time zone of the shop), without it the day is the
-- utc day. It tells which batches are over; it gives no right to anybody, the policies never
-- read it.
CREATE OR REPLACE FUNCTION cartlify.shop_today () RETURNS date LANGUAGE sql STABLE
SET
  search_path = cartlify,
  pg_temp AS $$
  SELECT COALESCE(
    NULLIF(current_setting('cartlify.shop_today', true), '')::date,
    (now() AT TIME ZONE 'UTC')::date
  );
$$;

-- Counts the units of a product that sit in batches whose last good day is over. They are not
-- sold, so they are no free units; an admin writes them off. Runs as the owner: a buyer sees
-- no batch.
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

-- Counts the units of every product sold in a period: the orders paid in [p_from, p_to) that were
-- not cancelled. It holds no data of a person, only a product and a number. Runs as the owner: a
-- buyer reads no order but the own ones, and the catalog sorts its products by it.
CREATE OR REPLACE FUNCTION cartlify.units_sold_in_period (p_from timestamp, p_to timestamp) RETURNS TABLE (product_id integer, units bigint) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
  SELECT i."productId", SUM(i.quantity)::bigint
  FROM cartlify.order_items AS i
  JOIN cartlify.orders AS o ON o.id = i."orderId"
  WHERE o."paidAt" >= p_from
    AND o."paidAt" < p_to
    AND o.status IN ('paid', 'shipped', 'delivered')
  GROUP BY i."productId";
$$;

-- Takes units out of the batches of a product: first the batch that ends first, then the ones
-- without an end, the oldest first. Returns what each batch gave and its cost of a unit. A sale
-- skips the batches that are over (p_skip_expired), a write-off takes them first. Raises
-- STOCK_QTY_INVALID for a quantity below 1 and PRODUCT_BATCHES_SHORT when the batches hold
-- less than asked. Internal step: runs with the caller rights, only the system functions
-- reach the batches (db/03); the app has no execute right (db/01). The caller holds the lock of
-- the product row.
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

-- Puts the units of a cancelled paid order back into the batches they came from. Raises
-- ORDER_ALLOCATIONS_MISSING when the allocations do not cover the items. Internal step: runs
-- with the caller rights; cancel_paid_order calls it as the owner. The lines of the allocations
-- stay: the reports take the cost back from the time of the cancel.
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

-- Takes in a batch of a product and returns its id: the stock grows by it, and the admin log
-- keeps a line (STOCK_DELIVERY) with the delivery it came with, the supplier, the invoice and
-- the note. System function: runs as the owner, the batches and the stock are closed for plain
-- changes (db/03). Callable only by a signed-in admin or root, the line of the log is in their
-- name (STOCK_RECEIVE_FORBIDDEN). A product removed from the catalog takes in nothing
-- (PRODUCT_NOT_FOUND).
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
    'stock.delivery',
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

-- Writes off free units of a product: from the batch an admin names, or from the batches in the
-- order a sale takes them (the one that ends first, then the oldest). The admin log keeps a line
-- (STOCK_WRITE_OFF) with the reason, the batches and their costs; the batches also come back as
-- the result. The units that waiting orders hold are never written off
-- (INSUFFICIENT_AVAILABLE_STOCK). A product removed from the catalog keeps its units until they
-- are written off, so it can be written off too. System function: runs as the owner; callable
-- only by a signed-in admin or root (STOCK_WRITE_OFF_FORBIDDEN).
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

    -- The reserve of the waiting orders is made of good units. A good batch named here may give
    -- only the good units that no order holds. A batch that is over, and units taken without a
    -- named batch (the ones that are over go first), cannot cut into the reserve.
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
    'stock.write_off',
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

-- Checks that the stock of a product equals what its batches have left. It runs at the end of
-- the transaction (the triggers below are deferred), because a step changes the stock and the
-- batches one after the other. Raises PRODUCT_STOCK_BATCHES_MISMATCH (check_violation). A
-- product with stock and no batches (a copy of prod restored to dev, a reseed) fails at the
-- next change of its stock; db/data/clear_orders_and_stock.sql wipes such data. A product
-- removed for good in the same transaction has nothing to check. Runs as the owner: it reads
-- the batches.
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

-- The check runs after a change of the stock and after a change of the batches.
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

-- Reserves units of a product for an order that is being confirmed. Free units are the stock
-- minus the reserve minus the units of batches that are over. Raises PRODUCT_NOT_FOUND (also
-- for a product removed from the catalog) and INSUFFICIENT_AVAILABLE_STOCK. Internal step: runs
-- with caller rights; trg_products_update_columns lets only the steps of the database change the
-- stock columns, and the app has no execute right (db/01); confirm_order and pay_order call it as
-- the owner.
CREATE OR REPLACE FUNCTION cartlify.reserve_product_stock (p_product_id int, p_qty int) RETURNS void LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
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

  -- no row changed: tell a missing product from a lack of free units
  IF NOT FOUND THEN
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

-- Releases the reserve of units after an unconfirm, a cancelled payment or an expired
-- reservation. Returns the reserve that is left. Raises PRODUCT_NOT_FOUND and
-- INSUFFICIENT_RESERVED_STOCK. Internal step: runs with caller rights; trg_products_update_columns
-- lets only the steps of the database change the stock columns, and the app has no execute right
-- (db/01); unconfirm_order,
-- cancel_order_payment and expire_order_reservation call it.
CREATE OR REPLACE FUNCTION cartlify.release_product_stock (p_product_id int, p_qty int) RETURNS integer LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_reserved_stock integer;
BEGIN
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

-- Turns the reserve of a paid order into a sale: takes the units out of the batches that are
-- still good (a sale skips the batches that are over) and keeps in order_batch_allocations which
-- batch gave how many, which is the cost of goods of the order. Returns the stock that is left.
-- Raises STOCK_CONSUME_FORBIDDEN unless the role is ADMIN or ROOT (the system is an admin
-- context). Internal step: runs with caller rights; trg_products_update_columns lets only the steps of
-- the database change the stock columns, and the app has no execute right (db/01); pay_order calls
-- it as the owner.
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

-- Recalculates the popularity of a product. While a manual override is set and its end is ahead,
-- the override is the popularity. Otherwise it is a weighted sum of ln(1 + count) of the views of
-- all time and, for the last 30 days, the favorites, the cart adds (items of orders not
-- confirmed yet), the purchases (items of confirmed orders) and the reviews. Internal: only the
-- popularity triggers and recalc_all_products_popularity call it, the app has no execute right
-- (db/01).
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

-- Recalculates the popularity of every product. The counts of the last 30 days and the end of a
-- manual override move with time, not with an event, so this has to run now and then. Maintenance: the app has no execute right (db/01); until a periodic job exists, run it
-- by hand as the owner:
--   psql "$MIGRATION_DATABASE_URL" -c 'SELECT cartlify.recalc_all_products_popularity();'
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

-- Keeps the average rating and the review count of a product in step with its reviews. Fires
-- after a review is added or removed, or its rating or comment changes. Trigger function: runs
-- as the owner, the recalc function it calls is internal and closed for the app; it cannot be
-- called directly, only the trigger fires it.
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

-- Limits who changes the views of a product: a guest or a user may raise them by one only
-- (PRODUCT_VIEWS_UPDATE_FORBIDDEN). Other roles are not limited here.
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

-- Keeps the sale of a product valid, whatever way the row changes (before an update of the
-- price, the sale price or the end of the sale). A sale that is set or changed must end in the
-- future (PRODUCT_SALE_ENDS_AT_INVALID). A price changed down to the sale price or below ends
-- the sale: its fields and the lowest price of the 30 days before it go empty. A sale that was
-- still on gets a line of its end in the admin log (PRODUCT_SALE, event product.sale_end_by_price, with a change entry event = ended_by_price) in the
-- name of the admin who changed the price; the system has no id, so it is refused
-- (PRODUCT_SALE_ACTOR_REQUIRED). The log of prices has the change of the price itself. Prices go
-- to the log as text without a trailing zero (trim_scale: 15.50 becomes 15.5), dates as iso utc.
-- Only an update is checked: rows copied in (dev restored from a copy of prod) keep their sales,
-- ended ones too. Prisma keeps dates as utc in columns without a time zone.
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
        'product.sale_end_by_price',
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

-- Recalculates the popularity after the views of a product change. Views enter the score through
-- a logarithm, so one view rarely changes it: recalculate while the counter is small (up to 20),
-- on every tenth view and on any change that is not a single view. Trigger function: runs as the
-- owner, the recalc function it calls is internal and closed for the app; it cannot be called
-- directly, only the trigger fires it.
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

-- Recalculates the popularity of a product after a favorite is added or removed. Trigger
-- function: runs as the owner, the recalc function it calls is internal and closed for the app;
-- it cannot be called directly, only the trigger fires it.
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

-- Recalculates the popularity of a product after an order item is added, removed, or moved to
-- another order or product. The score counts the items, not their quantity or price. Trigger
-- function: runs as the owner, the recalc function it calls is internal and closed for the app;
-- it cannot be called directly, only the trigger fires it.
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

-- Recalculates the popularity of a product after a review is added or removed. The score counts
-- the reviews, not their votes or texts. Trigger function: runs as the owner, the recalc
-- function it calls is internal and closed for the app; it cannot be called directly, only the
-- trigger fires it.
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

-- Recalculates the popularity of the products of an order when its confirmed flag changes.
-- Trigger function: runs as the owner, the recalc function it calls is internal and closed for
-- the app; it cannot be called directly, only the trigger fires it.
CREATE OR REPLACE FUNCTION cartlify.orders_after_update_popularity () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_product_id integer;
BEGIN

  -- an item counts as in a cart or as bought by the confirmed flag of its order: a step of a
  -- confirmed order (paid, shipped, delivered) starts no recalculation; the window of the
  -- purchases follows orders."updatedAt"
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

-- Sets the total of an order to the sum of its items. Until the order is confirmed the total is
-- only the items; the confirmation adds the delivery price (orders_before_update), and a
-- confirmed order refuses a new total. Internal: only the order items trigger calls it, the app
-- has no execute right (db/01).
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

-- Refreshes the item prices of an order from the prices its products sell at now
-- (product_current_price: the sale price while the sale lasts). Returns the number of items
-- whose price changed. Runs with caller rights: RLS lets only the owner change items, and only
-- before the confirmation.
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

-- Gives what the buyer pays for the delivery: the manual method costs the flat price, and
-- nothing from the free-from sum of the items on (that sum itself is free); a pickup, and a shop
-- that names no flat price, cost nothing. The server gives the flat price and the free-from sum
-- from its settings. Pure arithmetic, no table is read.
CREATE OR REPLACE FUNCTION cartlify.delivery_price (
  p_method cartlify."DeliveryMethod",
  p_items_total numeric,
  p_flat numeric,
  p_free_from numeric
) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_method IS DISTINCT FROM 'manual' OR p_flat IS NULL THEN 0::numeric
    WHEN p_free_from IS NOT NULL AND p_items_total >= p_free_from THEN 0::numeric
    ELSE p_flat
  END
$$;

-- Removes the old signature of confirm_order, from before the delivery arguments.
DROP FUNCTION IF EXISTS cartlify.confirm_order (integer, interval);

-- Confirms an order: reserves the stock, checks the prices, fixes the delivery price and sets the
-- reservation deadline (the status becomes waiting). System function: runs as the owner, acts
-- only for a USER (ORDER_CONFIRM_FORBIDDEN) and only on an order of their own: the order of
-- another user is not found (ORDER_NOT_FOUND). The delivery of the order
-- (order_deliveries) must be written before. Its price is fixed here by the rule in the
-- arguments (the flat price and the free-from sum come from the settings of the server). When
-- the buyer sent the price he saw (p_expected_delivery_price) and the rule gives another one,
-- the confirmation is refused (ORDER_DELIVERY_PRICE_CHANGED); an item price that is not the
-- price its product sells at now refuses it too (ORDER_PRICES_CHANGED).
CREATE OR REPLACE FUNCTION cartlify.confirm_order (
  p_order_id integer,
  p_reserve_for interval,
  p_delivery_flat numeric DEFAULT NULL,
  p_delivery_free_from numeric DEFAULT NULL,
  p_expected_delivery_price numeric DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor_role text;
  v_actor_id   integer;

  v_confirmed  boolean;
  v_status     text;

  v_method         cartlify."DeliveryMethod";
  v_items_total    numeric;
  v_delivery_price numeric;

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
  SELECT o.confirmed, o.status
  INTO v_confirmed, v_status
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id
    AND o."userId" = v_actor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
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

  -- the reservation above locked the product rows, so prices cannot change until the commit:
  -- refuse when an item price differs from the price its product sells at now (a sale that just
  -- ended counts), the buyer must confirm the amount he sees
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

  -- where the order goes is written before the confirmation; its price is fixed now, from what
  -- the items cost, and the total that the update below sets holds it
  SELECT d.method
  INTO v_method
  FROM cartlify.order_deliveries AS d
  WHERE d."orderId" = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_DELIVERY_REQUIRED';
  END IF;

  SELECT COALESCE(SUM(oi."totalPrice"), 0)
  INTO v_items_total
  FROM cartlify.order_items AS oi
  WHERE oi."orderId" = p_order_id;

  v_delivery_price := cartlify.delivery_price(
    v_method, v_items_total, p_delivery_flat, p_delivery_free_from
  );

  IF p_expected_delivery_price IS NOT NULL
     AND p_expected_delivery_price IS DISTINCT FROM v_delivery_price THEN
    RAISE EXCEPTION 'ORDER_DELIVERY_PRICE_CHANGED';
  END IF;

  UPDATE cartlify.order_deliveries AS d
  SET "price" = v_delivery_price
  WHERE d."orderId" = p_order_id
    AND d."price" IS DISTINCT FROM v_delivery_price;

  -- confirm order and set reservation deadline
  UPDATE cartlify.orders AS o
  SET
    confirmed = true,
    status = 'waiting',
    "reservationExpiresAt" = clock_timestamp() + p_reserve_for
  WHERE o.id = p_order_id;
END;
$$;

-- Takes a confirmed order that waits for payment back to unconfirmed and releases its reserved
-- stock. System function: only the system (the admin context without a user id) may call it, a
-- signed-in admin is refused (ORDER_UNCONFIRM_FORBIDDEN).
CREATE OR REPLACE FUNCTION cartlify.unconfirm_order (p_order_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_confirmed  boolean;
  v_status     text;

  r record;
BEGIN
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

-- The owner cancels the payment of an order that waits for it: the reservation is released and
-- the order becomes unconfirmed, with its items and delivery data kept, so the owner can change
-- them and confirm it again. System function: runs as the owner, the reserved stock is closed for
-- the app. Callable only by the USER who owns the order (ORDER_CANCEL_PAYMENT_FORBIDDEN). The
-- server closes the payment page of the provider before the call, so no payment can come for
-- this reservation any more.
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

-- An admin cancels a paid or shipped order and puts its stock back into the batches. System
-- function: runs as the owner, the stock of a paid order is closed for plain updates (db/03)
-- and its status moves by the steps of an admin and by this function. Callable only in the admin context (ORDER_CANCEL_FORBIDDEN). The server
-- refunds the payment in the same transaction before the commit, so an order is cancelled only
-- together with its refund. A delivered order is not cancelled (ORDER_ALREADY_DELIVERED).
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

  -- read state without a lock, to answer with the reason
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

-- Records a payment that a provider confirmed (the payment webhook) and turns the order into a
-- paid one. It returns a text, not an error, so the server decides what to do with the money:
--   PAID                        the order is paid now
--   ALREADY_PAID_SAME_PAYMENT   a repeated delivery of the payment that is already recorded
--   ALREADY_PAID_OTHER_PAYMENT  another payment for an order that is paid already
--   ORDER_NOT_FOUND             there is no such order
--   ORDER_NOT_PAYABLE           the order cannot be paid (no items, no delivery)
--   AMOUNT_MISMATCH             the amount is not the items plus the delivery price
--   OUT_OF_STOCK                the units are gone, also from a batch that went over since the
--                               reservation
-- The same payment is the same provider with the same payment id. Two paths: a waiting order
-- consumes the stock it reserved; a pending or unconfirmed order, whose reservation is gone,
-- reserves and consumes it now, only when every item is still available. System function:
-- only the system (the admin context without a user id) may call it, a signed-in admin is
-- refused (ORDER_PAY_FORBIDDEN).
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
  v_recorded_provider cartlify."PaymentProvider";
  v_recorded_payment  text;
  v_items_total       numeric;
  v_delivery_price    numeric;

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

  -- read state without a lock, to answer with the reason
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
  SELECT o.confirmed, o.status, o."paymentProvider", o."paymentId"
  INTO v_confirmed, v_status, v_recorded_provider, v_recorded_payment
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

  -- paid amount must match the items being sold and the price of the delivery fixed at the last
  -- confirmation (an order that was never confirmed has no delivery and is refused below)
  SELECT COALESCE(SUM(oi."totalPrice"), 0)
  INTO v_items_total
  FROM cartlify.order_items AS oi
  WHERE oi."orderId" = p_order_id;

  SELECT d."price"
  INTO v_delivery_price
  FROM cartlify.order_deliveries AS d
  WHERE d."orderId" = p_order_id;

  IF p_paid_amount IS NULL OR p_paid_amount <> v_items_total + COALESCE(v_delivery_price, 0) THEN
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
    -- the order becomes confirmed, so it needs what the confirm trigger requires: where it goes
    IF v_delivery_price IS NULL THEN
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

-- Ends the reservation of a waiting order whose time is over: releases the reserved stock and
-- puts the order back to unconfirmed. Returns true when it did, false when there was nothing to
-- expire (the order is gone, is not waiting, or its time has not come: a stale timer). System
-- function: runs as the owner, it changes orders and stock of any user. Callable only by the
-- system (the admin context without a user id), the order timeout worker sets it before the call
-- (ORDER_EXPIRE_FORBIDDEN).
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
    -- read state without a lock, to answer with the reason
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

-- Takes the unit price and the name from the product and calculates the total price of an item
-- (before an insert or update). The price is the one the product sells at now, never one from
-- the caller. The order must be one the actor can change: RLS hides foreign and confirmed orders
-- (ORDER_NOT_EDITABLE), a confirmed order seen by an admin refuses too (ORDER_ALREADY_CONFIRMED).
-- The confirmation fixes the price and the name, because items of a confirmed order cannot
-- change.
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

-- Recalculates the total of an order after its items change. Trigger function: runs as the
-- owner, the recalc function it calls is internal and closed for the app; it cannot be called
-- directly, only the trigger fires it.
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

-- Guards the updates of an order. It always stamps updatedAt. Going back to unconfirmed (the
-- payment was cancelled or the reservation ended) makes the total the items again; the
-- delivery is priced again at the next confirmation. A confirmed order keeps its owner and its
-- total (ORDER_CONFIRMED_CHANGE_FORBIDDEN). At the confirmation the delivery must be written
-- (ORDER_DELIVERY_REQUIRED) and the total becomes the items plus the delivery price.
CREATE OR REPLACE FUNCTION cartlify.orders_before_update () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_total cartlify.orders.total%TYPE;
  v_delivery_price numeric;
BEGIN
  -- prisma stamps updatedAt only in its own queries, the db functions (pay, confirm, cancel,
  -- expire) change orders too; the column holds utc time without a zone, as prisma writes it
  NEW."updatedAt" := now() AT TIME ZONE 'UTC';

  IF OLD."confirmed" AND NOT NEW."confirmed" THEN
    -- back to unconfirmed (the payment was cancelled or the reservation ended): the order is a
    -- cart again and costs what its items cost, the delivery is priced again at the next
    -- confirmation
    IF NEW."userId" IS DISTINCT FROM OLD."userId" THEN
      RAISE EXCEPTION 'ORDER_CONFIRMED_CHANGE_FORBIDDEN'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(SUM(oi."totalPrice"), 0)
    INTO v_total
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = OLD.id;

    NEW."total" := v_total;

    RETURN NEW;
  END IF;

  IF OLD."confirmed" THEN
    IF NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."total" IS DISTINCT FROM OLD."total"
    THEN
      RAISE EXCEPTION 'ORDER_CONFIRMED_CHANGE_FORBIDDEN'
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  IF NOT OLD."confirmed" AND NEW."confirmed" THEN
    -- where the order goes must be written, with its price
    SELECT d."price"
    INTO v_delivery_price
    FROM cartlify.order_deliveries AS d
    WHERE d."orderId" = OLD.id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ORDER_DELIVERY_REQUIRED'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(SUM(oi."totalPrice"), 0)
    INTO v_total
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = OLD.id;

    NEW."total" := v_total + v_delivery_price;
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

-- Recalculates the up and down vote counters of a review from its votes. Internal: only the
-- review votes trigger calls it, the app has no execute right (db/01).
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

-- Guards a review before an update. The rating and the comment are filled in once: a try to
-- empty them keeps the old value, a try to change them is refused (REVIEW_RATING_UPDATE_FORBIDDEN,
-- REVIEW_COMMENT_UPDATE_FORBIDDEN). The author and the product never change.
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

-- Refuses a new review or favorite for a product removed from the catalog (PRODUCT_NOT_FOUND);
-- what the product had before the removal stays (the app hides it). The same rule as the items
-- of an order (order_items_before_ins_upd).
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

-- Recalculates the vote counters of a review after a vote is added, changed or removed. Trigger
-- function: runs as the owner, the recalc function it calls is internal and closed for the app;
-- it cannot be called directly, only the trigger fires it.
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

  -- a vote moved to another review (only a script of the superuser can do it): both are recounted
  IF TG_OP = 'UPDATE' AND OLD."reviewId" IS DISTINCT FROM NEW."reviewId" THEN
    PERFORM cartlify.recalc_review_votes(OLD."reviewId");
  END IF;

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

-- Guards a chat message before an update: only the read flag may change
-- (CHAT_MESSAGE_UPDATE_FORBIDDEN).
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

-- Writes a line of the price log of a product. System function: runs as the owner, the app
-- writes no line straight into the table (db/03). Callable only by a signed-in admin or root
-- with an id, the line is in their name (PRICE_LOG_FORBIDDEN, PRICE_LOG_ACTOR_REQUIRED). A
-- change that changes nothing is no line.
-- p_event names what made the line (price.set, price.set_batch, price.bulk, price.sale_start,
-- price.sale_end), see src/config/journalEvents.ts. p_mode is how the change was given and
-- p_value is its size in that mode: the percent of the price or the amount of money, negative
-- for a change down. A line with an end (p_ends_at) is the start of a sale, from the price down
-- to the sale price (db/06); a sale taken off goes from the sale price back to the price.
CREATE OR REPLACE FUNCTION cartlify.log_product_price_change (
  p_product_id integer,
  p_old_price numeric,
  p_new_price numeric,
  p_mode cartlify."PriceChangeMode",
  p_value numeric,
  p_event text,
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
    "event",
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
    p_event,
    now()
  );
END;
$$;

-- Removes the old signature, from before p_event.
DROP FUNCTION IF EXISTS cartlify.log_product_price_change (
  integer,
  numeric,
  numeric,
  cartlify."PriceChangeMode",
  numeric,
  timestamp
);

------------------------------------------------------------
-- LOGIN LOGS
------------------------------------------------------------

-- Gives the logins of a deleted account the email the account has now (deleted+<id>+..., the one
-- its row of users keeps); the rest of a line stays. Returns how many lines changed. System
-- function: runs as the owner, the row policies deny every other change of a log line, besides
-- the clean-up of the addresses (the data scripts of a superuser still clear the tables).
-- Callable by root, who deletes an account (trg_users_update_columns lets only root change an
-- email), or by the system (LOGIN_LOGS_ANONYMIZE_FORBIDDEN),
-- and only for a deleted account (USER_NOT_DELETED).
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

-- Writes a line of the admin audit log. p_event names what made the line, finer than the action
-- (product.update_batch, order.ship_bulk, ...), see src/config/journalEvents.ts. p_changes is an
-- array of {field, old, new} objects (ADMIN_AUDIT_CHANGES_NOT_ARRAY). Not a system function:
-- it runs with the rights of the caller, and the policy of the log (aal_insert, db/03) decides
-- who may write and in whose name.
CREATE OR REPLACE FUNCTION cartlify.log_admin_action (
  p_actor_id integer,
  p_actor_role cartlify."Role",
  p_entity_type cartlify."AdminAuditEntityType",
  p_entity_id integer,
  p_action cartlify."AdminAuditAction",
  p_event text,
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
    "event",
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
    p_event,
    p_changes,
    nullif(current_setting('cartlify.request_ip', true), ''),
    nullif(current_setting('cartlify.request_user_agent', true), ''),
    now()
  );
END;
$$;

-- Removes the old signature, from before p_event.
DROP FUNCTION IF EXISTS cartlify.log_admin_action (
  integer,
  cartlify."Role",
  cartlify."AdminAuditEntityType",
  integer,
  cartlify."AdminAuditAction",
  jsonb
);

------------------------------------------------------------
-- MIGRATION AND MAINTENANCE
------------------------------------------------------------

-- Removes the tokens used or ended more than p_keep_days ago: a renewal of a session adds a row
-- each time and closes the one before, and the links of the mails stay after they are used. A
-- token used lately stays, because a renewed token coming back is how a theft is seen. Returns
-- how many rows went. Runs with the rights of the caller (the admin context may delete tokens
-- anyway). Callable only by the system (USER_TOKENS_CLEANUP_FORBIDDEN), meant for a periodic
-- task: SELECT cartlify.cleanup_user_tokens(30);
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

-- Retention: how long the shop keeps what it needs no longer. The functions below empty the
-- address and the browser of old logins, remove the favorites and the chats of guests who
-- stopped coming, and the chats of accounts deleted long ago. Each is the work of the system
-- (the admin context without a user id), meant for a periodic task that passes the days to keep,
-- e.g. SELECT * FROM cartlify.cleanup_guest_data(180). The ones that run as the owner reach the
-- rows through narrow policies (db/03) and the guard of the login log
-- (trg_login_logs_update_columns).

-- Gives the moment before which rows are old, for p_keep_days days to keep; the cleanup
-- functions share it. Only the system may call it (RETENTION_CLEANUP_FORBIDDEN), with at least
-- 1 day (RETENTION_CLEANUP_KEEP_DAYS_INVALID). Internal: runs with the rights of the caller.
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

-- Empties the address and the browser of the logins older than p_keep_days; the line stays as
-- history (who logged in, when, with which role). Returns how many lines it emptied.
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

-- Removes the favorites and the chats of guests who have not come for longer than p_keep_days:
-- a guest is gone when the newest of their favorites and chat messages is older. A guest who
-- came lately keeps all of it, an old favorite too; the messages go with their chats. Returns
-- how many favorites and chats went.
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

-- Removes the chats, with their messages, of the accounts deleted more than p_keep_days ago; a
-- deletion keeps them for a while (an admin may still need the conversation). Returns how many
-- chats went.
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

-- Moves the data of a guest to the account of a user who has just signed in: the favorites (one
-- the user has already is dropped) and the chats. Every guest chat becomes a chat of the user;
-- an open guest chat is closed, with its counters and its request for an admin cleared, when
-- the user has an open chat already or it is not the newest open guest chat; the newest one stays
-- open otherwise. Nothing happens for an
-- empty guest or user id. System function: runs as the owner, a user cannot see or change guest
-- rows. Callable only by the user who has just signed in (user, admin or root), and only for
-- themselves (GUEST_MIGRATION_FORBIDDEN). Guest rows are reached through the narrow *_owner
-- policies in db/03, no session flag is involved.
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

-- CHAT THREADS: every guest thread becomes a thread of the user; an open one is closed when the
-- user has an open thread already or it is not the newest open guest thread
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
-- LEGAL DOCUMENTS AND CONSENTS
------------------------------------------------------------

-- Sets what the database owns in a new version of the terms or of the contract: the next number
-- of its kind, the sha256 of its text and the time, whatever the row says. Two versions
-- published at once wait for each other (an advisory lock of the kind), and a version waits for
-- the consents being written to its kind. It is dated when it got that lock, not when its
-- transaction began, so every consent to the version before it comes earlier.
CREATE OR REPLACE FUNCTION cartlify.legal_documents_before_insert () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cartlify.legal_documents:' || NEW.kind::text));

  NEW.version := coalesce(
    (SELECT max(d.version) FROM cartlify.legal_documents AS d WHERE d.kind = NEW.kind),
    0
  ) + 1;
  NEW.sha256 := encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex');
  NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_legal_documents_before_insert ON cartlify.legal_documents;

CREATE TRIGGER trg_legal_documents_before_insert
BEFORE INSERT ON cartlify.legal_documents FOR EACH ROW
EXECUTE FUNCTION cartlify.legal_documents_before_insert ();

-- Checks and completes a new consent. It must be to the version in force of its kind, a newer
-- version refuses it (LEGAL_DOCUMENT_NOT_CURRENT). The address and the browser are the ones of
-- the request (cartlify.request_ip, cartlify.request_user_agent, set with the context), not what
-- the row says. It holds the lock of its kind shared until it commits: a version published
-- meanwhile waits for it, and one published before it is seen here. It is dated when it is
-- written.
CREATE OR REPLACE FUNCTION cartlify.legal_acceptances_before_insert () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_kind cartlify."LegalDocumentKind";
BEGIN
  SELECT d.kind INTO v_kind FROM cartlify.legal_documents AS d WHERE d.id = NEW."documentId";

  IF v_kind IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('cartlify.legal_documents:' || v_kind::text));
  END IF;

  IF v_kind IS NOT NULL AND EXISTS (
    SELECT 1 FROM cartlify.legal_documents AS d
    WHERE d.kind = v_kind AND d.version > (
      SELECT o.version FROM cartlify.legal_documents AS o WHERE o.id = NEW."documentId"
    )
  ) THEN
    RAISE EXCEPTION 'LEGAL_DOCUMENT_NOT_CURRENT' USING ERRCODE = '23514';
  END IF;

  NEW.ip := nullif(current_setting('cartlify.request_ip', true), '');
  NEW."userAgent" := nullif(current_setting('cartlify.request_user_agent', true), '');
  NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_legal_acceptances_before_insert ON cartlify.legal_acceptances;

CREATE TRIGGER trg_legal_acceptances_before_insert
BEFORE INSERT ON cartlify.legal_acceptances FOR EACH ROW
EXECUTE FUNCTION cartlify.legal_acceptances_before_insert ();

------------------------------------------------------------
-- UPDATE GUARDS
------------------------------------------------------------

-- The policies of db/03 say who may update a row; the triggers below say what the update may
-- change, comparing NEW with OLD. A policy that read the old row again by a subquery saw the
-- version from the start of the statement: an update that waited for the lock of the row and then
-- changed the version another transaction left (a view of a product while it is paid for)
-- looked as if it changed what the other one did, and failed with 42501. OLD is the version the
-- update changes.
--
-- Each trigger keeps the branches of the policies of its table: the update passes when one of
-- them lets it. A refusal is <TABLE>_UPDATE_FORBIDDEN with the code 42501.
--
-- The functions run as the role of the statement, not as the owner: current_user tells an update
-- of the app (cartlify_app) from a step of the database (cartlify_owner, a security definer
-- function). A superuser (a data script by hand) is not checked, as rls does not check it either.
--
-- Each trigger is named to run after the other before-update triggers of its table, so it checks
-- the row they leave. Most guards list the changed columns (v_changed) with an expression, not
-- with a function (those of user_tokens and chat_threads compare the columns one by one): the app has no execute right on internal functions.

-- Guard of users: the owner changes its own row but not its email, role, verification or
-- deletion (the one exception: an unverified LOCAL account taken over by an OAuth provider);
-- root changes anything; the steps of the database verify an email or remove an avatar.
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

-- Guard of user tokens. The owner or an admin may update a token only so: it keeps its user,
-- its kind, its session and its browser; a closed token (usedAt) stays closed; a revoke
-- (revokedAt) is set only as the token is closed (db/06: at that moment), so a token closed by
-- its renewal stays the sign of theft it is when it comes back; a session (REFRESH_TOKEN) may
-- get its hash and deadline after the row is made, every other link keeps them and is only
-- closed. The steps of the database close a link of an email verification.
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

-- Guard of login logs: a line is history. Only two steps of the database change one:
-- anonymize_login_logs gives the line of a deleted account the email the account has now, and
-- cleanup_login_log_addresses empties the address and the browser of an old line.
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

-- Guard of products: an admin changes everything but what the database counts (the stock, the
-- reserve, the rating, the review count, the popularity) and adds at most one view; a guest or a
-- user changes only the views (products_before_views_change limits it to one); the steps of the
-- database change one group of what they count at a time (the rating, the stock and the reserve,
-- the popularity).
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

-- Guard of product batches: a sale, a write-off or a cancel, as a step of the database, changes
-- only what a batch has left.
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

-- Guard of reviews: the author adds the missing rating or comment and nothing else; the steps of
-- the database recount the two vote counters and change nothing else.
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
     AND NEW."downVotes" >= 0
     AND v_changed <@ ARRAY['upVotes', 'downVotes'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'REVIEW_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_reviews_update_columns ON cartlify.reviews;

CREATE TRIGGER trg_reviews_update_columns
BEFORE UPDATE ON cartlify.reviews FOR EACH ROW
EXECUTE FUNCTION cartlify.reviews_update_columns ();

-- Guard of review votes: the voter switches the vote UP <-> DOWN and nothing else. A vote never
-- moves to another review or to another voter (the counters of the review it left would stay as
-- they were); the vote still never lands on an own review (the policy review_votes_update).
CREATE OR REPLACE FUNCTION cartlify.review_votes_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
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
     AND v_changed <@ ARRAY['action', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'REVIEW_VOTE_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_review_votes_update_columns ON cartlify.review_votes;

CREATE TRIGGER trg_review_votes_update_columns
BEFORE UPDATE ON cartlify.review_votes FOR EACH ROW
EXECUTE FUNCTION cartlify.review_votes_update_columns ();

-- Guard of orders: an admin or root takes the shipping steps, one on or one back (a step over
-- is not allowed); the steps of the database change the total, the confirmation and the
-- reservation, the payment, and the cancel of an admin. The owner changes nothing of an order
-- with a plain update: where it goes is written in order_deliveries.
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

  -- the steps of the shipping: paid to shipped to delivered, and one step back of each; a step
  -- over (paid to delivered) is not one
  IF cartlify.current_actor_role() IN ('ADMIN', 'ROOT')
     AND (OLD.status::text, NEW.status::text) IN (
       ('paid', 'shipped'), ('shipped', 'delivered'), ('shipped', 'paid'), ('delivered', 'shipped')
     )
     AND v_changed <@ ARRAY['status', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner'
     AND (
       (NEW."total" >= 0 AND v_changed <@ ARRAY['total', 'updatedAt'])
       -- back to unconfirmed: the total goes back to the items (orders_before_update)
       OR (
         NEW.confirmed = false
         AND NEW.status IN ('pending', 'unconfirmed')
         AND NEW."reservationExpiresAt" IS NULL
         AND v_changed <@ ARRAY['confirmed', 'status', 'reservationExpiresAt', 'total', 'updatedAt']
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

-- Stamps updatedAt of a delivery on every update (utc without a zone, as prisma writes it).
CREATE OR REPLACE FUNCTION cartlify.order_deliveries_before_update () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := now() AT TIME ZONE 'UTC';

  -- A pickup costs nothing. An order that went back to unconfirmed keeps the price of its manual
  -- delivery, so a buyer who changes it to a pickup would meet the check of the address (price 0).
  IF NEW.method = 'pickup' THEN
    NEW."price" := 0;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_deliveries_before_update ON cartlify.order_deliveries;

CREATE TRIGGER trg_order_deliveries_before_update
BEFORE UPDATE ON cartlify.order_deliveries FOR EACH ROW
EXECUTE FUNCTION cartlify.order_deliveries_before_update ();

-- Guard of order deliveries: a user writes where the order goes, the method too (the policy lets
-- this only while the order is not confirmed); an admin or root corrects the person and the
-- address of a paid order (the policy), but not the method or the price; the price is fixed by
-- confirm_order, a step of the database.
CREATE OR REPLACE FUNCTION cartlify.order_deliveries_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
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
     AND v_changed <@ ARRAY['price', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  -- A user may not touch the price, except that a pickup is free: the price goes to 0 together
  -- with the method (order_deliveries_before_update).
  IF cartlify.current_actor_role() = 'USER'
     AND v_changed <@ ARRAY[
       'method', 'recipientFirstName', 'recipientLastName', 'recipientPhone', 'country',
       'postalCode', 'city', 'street', 'house', 'apartment', 'note', 'price', 'updatedAt'
     ]
     AND (NOT 'price' = ANY (v_changed) OR (NEW.method = 'pickup' AND NEW."price" = 0)) THEN
    RETURN NEW;
  END IF;

  IF cartlify.current_actor_role() IN ('ADMIN', 'ROOT')
     AND v_changed <@ ARRAY[
       'recipientFirstName', 'recipientLastName', 'recipientPhone', 'country', 'postalCode', 'city',
       'street', 'house', 'apartment', 'note', 'updatedAt'
     ] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ORDER_DELIVERY_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_order_deliveries_update_columns ON cartlify.order_deliveries;

CREATE TRIGGER trg_order_deliveries_update_columns
BEFORE UPDATE ON cartlify.order_deliveries FOR EACH ROW
EXECUTE FUNCTION cartlify.order_deliveries_update_columns ();

-- Stamps updatedAt of a shipment on every update (utc without a zone, as prisma writes it).
CREATE OR REPLACE FUNCTION cartlify.order_shipments_before_update () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := now() AT TIME ZONE 'UTC';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_shipments_before_update ON cartlify.order_shipments;

CREATE TRIGGER trg_order_shipments_before_update
BEFORE UPDATE ON cartlify.order_shipments FOR EACH ROW
EXECUTE FUNCTION cartlify.order_shipments_before_update ();

-- Guard of order shipments: an admin or root corrects the carrier, the number, the link and the
-- cost, marks the cost as no expense (the shop owes the carrier nothing for it), and rolls a
-- shipment back once. A shipment that was rolled back is history: only its cost and the mark of
-- the cost change.
CREATE OR REPLACE FUNCTION cartlify.order_shipments_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF cartlify.current_actor_role() IN ('ADMIN', 'ROOT')
     AND v_changed <@ ARRAY[
       'carrier', 'trackingNumber', 'trackingUrl', 'cost', 'expense', 'rolledBackAt', 'updatedAt'
     ]
     AND (OLD."rolledBackAt" IS NULL OR v_changed <@ ARRAY['cost', 'expense', 'updatedAt']) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ORDER_SHIPMENT_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_order_shipments_update_columns ON cartlify.order_shipments;

CREATE TRIGGER trg_order_shipments_update_columns
BEFORE UPDATE ON cartlify.order_shipments FOR EACH ROW
EXECUTE FUNCTION cartlify.order_shipments_update_columns ();

-- Guard of chat threads: a chat keeps its user or guest, a closed chat stays closed, a request
-- for an admin is made now, never earlier (the queue goes by adminRequestedAt; a minute is left
-- for the clock of the server). migrate_guest_data_to_user, a step of the database, makes a
-- guest chat a chat of the user.
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

-- Guard of admin alert settings: an admin or root changes whether a kind of their alerts is on
-- and its threshold, never whose the row is or which kind.
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