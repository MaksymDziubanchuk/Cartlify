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
-- them or the price goes down to them (product_variants_before_price_change), but it is no price any
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

-- Stock and batches. The stock of a variant is what its batches have left; every step that
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

-- The names of variants and the values that tell them apart: the one rule of the name. A name is
-- the name of the product, then a dash, then the labels of the characteristics that DIFFER between
-- the variants of the product (a book with one variant has the plain name of the product). The
-- variants compared are the visible ones (for sale and showing a picture); a variant that is not
-- visible itself is compared with the live ones (not taken out of sale) and with itself, so an admin
-- reads a name for it as well. A characteristic differs when the variants compared do not all hold
-- the same value of it (a variant that holds none counts as another value). The labels come main
-- characteristics first, then by the place of the group and of the characteristic in the directory:
-- a text as it is, a number without trailing zeros and with its unit ("256 GB"), a choice by the
-- name of its value (several: the names joined with a comma in the order of the values), yes/no as
-- "<characteristic>: yes|no" in the name and as yes|no in the values. "values" is the same list as
-- json, [{attributeId, name, value}]. Order items keep a name (order_items_before_ins_upd and
-- confirm_order), the card shows the same one: the application reads names only here. Runs with the
-- rights of the caller: all the tables it reads are read by everybody.
CREATE OR REPLACE FUNCTION cartlify.variant_names (p_variant_ids integer[]) RETURNS TABLE (variant_id integer, name text, "values" jsonb) LANGUAGE sql STABLE
SET
  search_path = cartlify,
  pg_temp AS $$
  WITH asked AS (
    SELECT v.id, v."productId" AS product_id, p.name AS product_name,
           (v."deletedAt" IS NULL AND EXISTS (
             SELECT 1 FROM cartlify.variant_images AS i WHERE i."variantId" = v.id
           )) AS visible
    FROM cartlify.product_variants AS v
    JOIN cartlify.products AS p ON p.id = v."productId"
    WHERE v.id = ANY (p_variant_ids)
  ),
  siblings AS (
    SELECT s.id, s."productId" AS product_id, (s."deletedAt" IS NULL) AS live,
           (s."deletedAt" IS NULL AND EXISTS (
             SELECT 1 FROM cartlify.variant_images AS i WHERE i."variantId" = s.id
           )) AS visible
    FROM cartlify.product_variants AS s
    WHERE s."productId" IN (SELECT product_id FROM asked)
  ),
  compared AS (
    SELECT a.id AS variant_id, s.id AS member_id
    FROM asked AS a
    JOIN siblings AS s ON s.product_id = a.product_id
    WHERE s.id = a.id OR CASE WHEN a.visible THEN s.visible ELSE s.live END
  ),
  sizes AS (
    SELECT c.variant_id, count(*) AS n FROM compared AS c GROUP BY c.variant_id
  ),
  held AS (
    SELECT x."variantId" AS variant_id, x."attributeId" AS attribute_id,
           string_agg(
             CASE
               WHEN x."textValue" IS NOT NULL THEN 't' || x."textValue"
               WHEN x."numberValue" IS NOT NULL THEN 'n' || trim_scale(x."numberValue")::text
               WHEN x."boolValue" IS NOT NULL THEN 'b' || x."boolValue"::text
               ELSE 'o' || x."optionId"::text
             END,
             ',' ORDER BY x."optionId"
           ) AS signature
    FROM cartlify.variant_attribute_values AS x
    WHERE x."variantId" IN (SELECT id FROM siblings)
    GROUP BY x."variantId", x."attributeId"
  ),
  differing AS (
    SELECT c.variant_id, h.attribute_id
    FROM compared AS c
    JOIN held AS h ON h.variant_id = c.member_id
    JOIN sizes AS z ON z.variant_id = c.variant_id
    GROUP BY c.variant_id, h.attribute_id, z.n
    HAVING count(DISTINCT h.signature) > 1 OR count(*) < z.n
  ),
  shown AS (
    SELECT d.variant_id, a.id AS attribute_id, a.name AS attribute_name, a.type,
           a."isMain" AS is_main, g.position AS group_position, a.position AS attribute_position,
           own.label
    FROM differing AS d
    JOIN cartlify.attributes AS a ON a.id = d.attribute_id
    JOIN cartlify.attribute_groups AS g ON g.id = a."groupId"
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN count(*) = 0 THEN NULL
               WHEN a.type = 'text' THEN max(x."textValue")
               WHEN a.type = 'number' THEN trim_scale(max(x."numberValue"))::text || COALESCE(' ' || a.unit, '')
               WHEN a.type = 'boolean' THEN CASE WHEN bool_or(x."boolValue") THEN 'yes' ELSE 'no' END
               ELSE string_agg(o.name, ', ' ORDER BY o.position, o.id)
             END AS label
      FROM cartlify.variant_attribute_values AS x
      LEFT JOIN cartlify.attribute_options AS o ON o.id = x."optionId"
      WHERE x."variantId" = d.variant_id AND x."attributeId" = d.attribute_id
    ) AS own
    WHERE own.label IS NOT NULL
  ),
  folded AS (
    SELECT s.variant_id,
           jsonb_agg(
             jsonb_build_object('attributeId', s.attribute_id, 'name', s.attribute_name, 'value', s.label)
             ORDER BY s.is_main DESC, s.group_position, s.attribute_position, s.attribute_id
           ) AS values_json,
           string_agg(
             CASE WHEN s.type = 'boolean' THEN s.attribute_name || ': ' || s.label ELSE s.label END,
             ', ' ORDER BY s.is_main DESC, s.group_position, s.attribute_position, s.attribute_id
           ) AS labels
    FROM shown AS s
    GROUP BY s.variant_id
  )
  SELECT a.id,
         a.product_name || COALESCE(' ' || chr(8212) || ' ' || f.labels, ''),
         COALESCE(f.values_json, '[]'::jsonb)
  FROM asked AS a
  LEFT JOIN folded AS f ON f.variant_id = a.id;
$$;

-- The name of one variant: the same rule as variant_names (its single implementation).
CREATE OR REPLACE FUNCTION cartlify.variant_display_name (p_variant_id integer) RETURNS text LANGUAGE sql STABLE
SET
  search_path = cartlify,
  pg_temp AS $$
  SELECT n.name FROM cartlify.variant_names(ARRAY[p_variant_id]) AS n;
$$;

-- Counts the units of a variant that sit in batches whose last good day is over. They are not
-- sold, so they are no free units; an admin writes them off. Runs as the owner: a buyer sees
-- no batch.
CREATE OR REPLACE FUNCTION cartlify.variant_expired_units (p_variant_id integer) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
  SELECT COALESCE(SUM(b.remaining), 0)::integer
  FROM cartlify.product_batches AS b
  WHERE b."variantId" = p_variant_id
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

-- Takes units out of the batches of a variant: first the batch that ends first, then the ones
-- without an end, the oldest first. Returns what each batch gave and its cost of a unit. A sale
-- skips the batches that are over (p_skip_expired), a write-off takes them first. Raises
-- STOCK_QTY_INVALID for a quantity below 1 and VARIANT_BATCHES_SHORT when the batches hold
-- less than asked. Internal step: runs with the caller rights, only the system functions
-- reach the batches (db/03); the app has no execute right (db/01). The caller holds the lock of
-- the variant row.
CREATE OR REPLACE FUNCTION cartlify.take_from_batches (
  p_variant_id integer,
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
    WHERE b."variantId" = p_variant_id
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
    RAISE EXCEPTION 'VARIANT_BATCHES_SHORT';
  END IF;
END;
$$;

-- Writes a line of the stock log: the change of the stock of a variant and what made it
-- (p_event, see src/config/journalEvents.ts), with the stock after it and the operation the change
-- belongs to (a delivery, a write-off or an order; at most one of the three). The lines of a
-- statement of return (stock.return, stock.return_write_off) also name its row (p_return_item_id). p_meta is an array of
-- {field, old, new} objects (STOCK_LOG_CHANGES_NOT_ARRAY): the batches with their costs, the reason
-- of a write-off, the supplier, the invoice and the note of a delivery. Raises VARIANT_NOT_FOUND.
-- The actor is the one of the context; the system (the admin context without a user id, such as
-- the payment webhook) has none, and neither has its role. The time is utc without a zone, as the
-- other dates the database writes (orders.paidAt); the address and the browser of the request come
-- from the context of the transaction (empty without a request). Internal step: runs with the
-- caller rights, and the policy of the log (stock_log_insert_owner, db/03) lets only the system
-- functions that run as the owner write; the app has no execute right (db/01). Each function that
-- changes the stock calls it in the same transaction, a variant at a time.
CREATE OR REPLACE FUNCTION cartlify.log_stock_change (
  p_variant_id integer,
  p_event text,
  p_quantity_change integer,
  p_stock_after integer,
  p_meta jsonb,
  p_delivery_id uuid,
  p_write_off_id uuid,
  p_order_id integer,
  p_return_item_id integer DEFAULT NULL
) RETURNS void LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_product_id integer;
  v_actor_id   integer := cartlify.current_actor_id();
BEGIN
  IF p_meta IS NOT NULL AND jsonb_typeof(p_meta) <> 'array' THEN
    RAISE EXCEPTION 'STOCK_LOG_CHANGES_NOT_ARRAY'
      USING HINT = 'expected an array of {field, old, new} objects';
  END IF;

  SELECT v."productId"
  INTO v_product_id
  FROM cartlify.product_variants AS v
  WHERE v.id = p_variant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VARIANT_NOT_FOUND';
  END IF;

  INSERT INTO cartlify.stock_log (
    "actorId",
    "actorRole",
    "productId",
    "variantId",
    event,
    "quantityChange",
    "stockAfter",
    meta,
    "deliveryId",
    "writeOffId",
    "orderId",
    "returnItemId",
    ip,
    "userAgent",
    "createdAt"
  )
  VALUES (
    v_actor_id,
    CASE WHEN v_actor_id IS NULL THEN NULL ELSE cartlify.current_actor_role() END,
    v_product_id,
    p_variant_id,
    p_event,
    p_quantity_change,
    p_stock_after,
    p_meta,
    p_delivery_id,
    p_write_off_id,
    p_order_id,
    p_return_item_id,
    nullif(current_setting('cartlify.request_ip', true), ''),
    nullif(current_setting('cartlify.request_user_agent', true), ''),
    now() AT TIME ZONE 'UTC'
  );
END;
$$;

-- Takes in a batch of a variant and returns its id: the stock grows by it, and the stock log
-- keeps a line (stock.delivery) with the delivery it came with, the batch with its cost, the
-- supplier, the invoice and the note. The line of the admin log, one for the whole delivery, is
-- the server's. System function: runs as the owner, the batches and the stock are closed for plain
-- changes (db/03). Callable only by a signed-in admin or root, the line of the log is in their
-- name (STOCK_RECEIVE_FORBIDDEN). A variant that is deleted takes in nothing (VARIANT_NOT_FOUND).
CREATE OR REPLACE FUNCTION cartlify.receive_variant_batch (
  p_delivery_id uuid,
  p_variant_id integer,
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
  v_product_id integer;
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

  -- lock variant row
  SELECT v."stock", v."productId"
  INTO v_stock, v_product_id
  FROM cartlify.product_variants AS v
  WHERE v.id = p_variant_id
    AND v."deletedAt" IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VARIANT_NOT_FOUND';
  END IF;

  INSERT INTO cartlify.product_batches (
    "productId",
    "variantId",
    "deliveryId",
    source,
    "supplierBatchNumber",
    "unitCost",
    quantity,
    remaining,
    "expiresAt"
  )
  VALUES (
    v_product_id,
    p_variant_id,
    p_delivery_id,
    p_source,
    v_number,
    p_unit_cost,
    p_quantity,
    p_quantity,
    p_expires_at
  )
  RETURNING id INTO v_batch_id;

  UPDATE cartlify.product_variants AS v
  SET "stock" = v_stock + p_quantity
  WHERE v.id = p_variant_id;

  PERFORM cartlify.log_stock_change(
    p_variant_id,
    'stock.delivery',
    p_quantity,
    v_stock + p_quantity,
    jsonb_build_array(
      jsonb_build_object(
        'field', 'batches',
        'old', NULL,
        'new', jsonb_build_array(
          jsonb_build_object(
            'batchId', v_batch_id,
            'quantity', p_quantity,
            'unitCost', trim_scale(p_unit_cost)::text
          )
        )
      ),
      jsonb_build_object('field', 'source', 'old', NULL, 'new', p_source)
    )
    || CASE WHEN v_supplier IS NULL THEN '[]'::jsonb
         ELSE jsonb_build_array(jsonb_build_object('field', 'supplier', 'old', NULL, 'new', v_supplier))
       END
    || CASE WHEN v_document IS NULL THEN '[]'::jsonb
         ELSE jsonb_build_array(jsonb_build_object('field', 'document', 'old', NULL, 'new', v_document))
       END
    || CASE WHEN v_note IS NULL THEN '[]'::jsonb
         ELSE jsonb_build_array(jsonb_build_object('field', 'note', 'old', NULL, 'new', v_note))
       END,
    p_delivery_id,
    NULL,
    NULL
  );

  RETURN v_batch_id;
END;
$$;

-- Writes off free units of a variant: from the batch an admin names, or from the batches in the
-- order a sale takes them (the one that ends first, then the oldest). The stock log keeps a line
-- (stock.write_off) with the reason, the batches and their costs; the batches also come back as
-- the result. The line of the admin log, one for the whole write-off, is the server's. The units that waiting orders hold are never written off
-- (INSUFFICIENT_AVAILABLE_STOCK). A variant that is deleted keeps its units until they
-- are written off, so it can be written off too. System function: runs as the owner; callable
-- only by a signed-in admin or root (STOCK_WRITE_OFF_FORBIDDEN).
CREATE OR REPLACE FUNCTION cartlify.write_off_variant_stock (
  p_write_off_id uuid,
  p_variant_id integer,
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

  -- lock variant row
  SELECT v."stock", v."reservedStock"
  INTO v_stock, v_reserved
  FROM cartlify.product_variants AS v
  WHERE v.id = p_variant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VARIANT_NOT_FOUND';
  END IF;

  IF v_stock - v_reserved < p_quantity THEN
    RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_STOCK';
  END IF;

  IF p_batch_id IS NOT NULL THEN
    SELECT b.remaining, b."unitCost", b."expiresAt"
    INTO v_remaining, v_cost, v_expires
    FROM cartlify.product_batches AS b
    WHERE b.id = p_batch_id
      AND b."variantId" = p_variant_id
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
       AND v_stock - cartlify.variant_expired_units(p_variant_id) - v_reserved < p_quantity THEN
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
    FROM cartlify.take_from_batches(p_variant_id, p_quantity, false)
      WITH ORDINALITY AS t(taken_batch_id, taken_quantity, taken_unit_cost, n);
  END IF;

  UPDATE cartlify.product_variants AS v
  SET "stock" = v_stock - p_quantity
  WHERE v.id = p_variant_id;

  PERFORM cartlify.log_stock_change(
    p_variant_id,
    'stock.write_off',
    -p_quantity,
    v_stock - p_quantity,
    jsonb_build_array(
      jsonb_build_object('field', 'reason', 'old', NULL, 'new', p_reason),
      jsonb_build_object('field', 'batches', 'old', NULL, 'new', v_taken)
    )
    || CASE WHEN v_note IS NULL THEN '[]'::jsonb
         ELSE jsonb_build_array(jsonb_build_object('field', 'note', 'old', NULL, 'new', v_note))
       END,
    NULL,
    p_write_off_id,
    NULL
  );

  RETURN v_taken;
END;
$$;

-- Checks that the stock of a variant equals what its batches have left. It runs at the end of
-- the transaction (the triggers below are deferred), because a step changes the stock and the
-- batches one after the other. Raises VARIANT_STOCK_BATCHES_MISMATCH (check_violation). A
-- variant with stock and no batches (a copy of prod restored to dev, a reseed) fails at the
-- next change of its stock; db/data/clear_orders_and_stock.sql wipes such data. A variant
-- removed for good in the same transaction has nothing to check. Runs as the owner: it reads
-- the batches.
CREATE OR REPLACE FUNCTION cartlify.check_variant_stock_batches () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_variant_id integer;
  v_stock      integer;
BEGIN
  IF TG_TABLE_NAME = 'product_variants' THEN
    v_variant_id := NEW.id;
  ELSE
    v_variant_id := NEW."variantId";
  END IF;

  SELECT v."stock"
  INTO v_stock
  FROM cartlify.product_variants AS v
  WHERE v.id = v_variant_id;

  -- a variant removed for good in the same transaction takes its batches with it
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_stock <> (
    SELECT COALESCE(SUM(b.remaining), 0)
    FROM cartlify.product_batches AS b
    WHERE b."variantId" = v_variant_id
  ) THEN
    RAISE EXCEPTION 'VARIANT_STOCK_BATCHES_MISMATCH'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

-- The check runs after a change of the stock and after a change of the batches.
DROP TRIGGER IF EXISTS trg_product_variants_stock_batches ON cartlify.product_variants;

CREATE CONSTRAINT TRIGGER trg_product_variants_stock_batches
AFTER INSERT OR UPDATE OF "stock" ON cartlify.product_variants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION cartlify.check_variant_stock_batches ();

DROP TRIGGER IF EXISTS trg_product_batches_stock ON cartlify.product_batches;

CREATE CONSTRAINT TRIGGER trg_product_batches_stock
AFTER INSERT OR UPDATE OF remaining ON cartlify.product_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION cartlify.check_variant_stock_batches ();

-- Reserves units of a variant for an order that is being confirmed. Free units are the stock
-- minus the reserve minus the units of batches that are over. Raises VARIANT_NOT_FOUND (also
-- for a variant that is deleted) and INSUFFICIENT_AVAILABLE_STOCK. Internal step: runs
-- with caller rights; trg_product_variants_update_columns lets only the steps of the database
-- change the stock columns, and the app has no execute right (db/01); confirm_order and
-- pay_order call it as the owner.
CREATE OR REPLACE FUNCTION cartlify.reserve_variant_stock (p_variant_id int, p_qty int) RETURNS void LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  IF p_variant_id IS NULL OR p_variant_id <= 0 THEN
    RAISE EXCEPTION 'VARIANT_ID_INVALID';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'RESERVE_QTY_INVALID';
  END IF;

  -- reserve only available stock: the units of batches that are over are not sold
  UPDATE cartlify.product_variants v
  SET "reservedStock" = v."reservedStock" + p_qty
  WHERE v.id = p_variant_id
    AND v."deletedAt" IS NULL
    AND (v.stock - v."reservedStock" - cartlify.variant_expired_units(v.id)) >= p_qty;

  -- no row changed: tell a missing variant from a lack of free units
  IF NOT FOUND THEN
    IF NOT EXISTS (
      SELECT 1
      FROM cartlify.product_variants v
      WHERE v.id = p_variant_id
        AND v."deletedAt" IS NULL
    ) THEN
      RAISE EXCEPTION 'VARIANT_NOT_FOUND';
    END IF;

    RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_STOCK';
  END IF;
END;
$$;

-- Releases the reserve of units after an unconfirm, a cancelled payment or an expired
-- reservation. Returns the reserve that is left. Raises VARIANT_NOT_FOUND and
-- INSUFFICIENT_RESERVED_STOCK. Internal step: runs with caller rights;
-- trg_product_variants_update_columns lets only the steps of the database change the stock
-- columns, and the app has no execute right (db/01); unconfirm_order, cancel_order_payment and
-- expire_order_reservation call it.
CREATE OR REPLACE FUNCTION cartlify.release_variant_stock (p_variant_id int, p_qty int) RETURNS integer LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_reserved_stock integer;
BEGIN
  IF p_variant_id IS NULL OR p_variant_id <= 0 THEN
    RAISE EXCEPTION 'VARIANT_ID_INVALID';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'RELEASE_QTY_INVALID';
  END IF;

  -- lock variant row
  SELECT v."reservedStock"
  INTO v_reserved_stock
  FROM cartlify.product_variants AS v
  WHERE v.id = p_variant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VARIANT_NOT_FOUND';
  END IF;

  IF v_reserved_stock < p_qty THEN
    RAISE EXCEPTION 'INSUFFICIENT_RESERVED_STOCK';
  END IF;

  v_reserved_stock := v_reserved_stock - p_qty;

  UPDATE cartlify.product_variants AS v
  SET "reservedStock" = v_reserved_stock
  WHERE v.id = p_variant_id;

  RETURN v_reserved_stock;
END;
$$;

-- Turns the reserve of a paid order into a sale: takes the units out of the batches that are
-- still good (a sale skips the batches that are over) and keeps in order_batch_allocations which
-- batch gave how many, which is the cost of goods of the order. The stock log keeps a line
-- (stock.sale, with the order and the batches, no actor when the system pays). Returns the stock
-- that is left.
-- Raises STOCK_CONSUME_FORBIDDEN unless the role is ADMIN or ROOT (the system is an admin
-- context). Internal step: runs with caller rights; trg_product_variants_update_columns lets only
-- the steps of the database change the stock columns, and the app has no execute right (db/01);
-- pay_order calls it as the owner.
CREATE OR REPLACE FUNCTION cartlify.consume_variant_stock (p_order_id integer, p_variant_id integer, p_qty integer) RETURNS integer LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_role           text;
  v_stock          integer;
  v_reserved_stock integer;
  v_product_id     integer;
  v_taken          jsonb := '[]'::jsonb;

  r record;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'STOCK_QTY_INVALID';
  END IF;

  v_role := cartlify.current_actor_role();

  IF v_role IS NULL OR v_role NOT IN ('ADMIN', 'ROOT') THEN
    RAISE EXCEPTION 'STOCK_CONSUME_FORBIDDEN';
  END IF;

  -- lock variant row
  SELECT v."stock", v."reservedStock", v."productId"
  INTO v_stock, v_reserved_stock, v_product_id
  FROM cartlify.product_variants AS v
  WHERE v.id = p_variant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VARIANT_NOT_FOUND';
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

  UPDATE cartlify.product_variants AS v
  SET
    "stock" = v_stock,
    "reservedStock" = v_reserved_stock
  WHERE v.id = p_variant_id;

  -- the batches give their units in the order of a sale; the line of the log names them in it
  FOR r IN
    SELECT t.taken_batch_id, t.taken_quantity, t.taken_unit_cost
    FROM cartlify.take_from_batches(p_variant_id, p_qty, true) AS t
  LOOP
    INSERT INTO cartlify.order_batch_allocations ("orderId", "productId", "variantId", "batchId", quantity)
    VALUES (p_order_id, v_product_id, p_variant_id, r.taken_batch_id, r.taken_quantity);

    v_taken := v_taken || jsonb_build_array(
      jsonb_build_object(
        'batchId', r.taken_batch_id,
        'quantity', r.taken_quantity,
        'unitCost', trim_scale(r.taken_unit_cost)::text
      )
    );
  END LOOP;

  PERFORM cartlify.log_stock_change(
    p_variant_id,
    'stock.sale',
    -p_qty,
    v_stock,
    jsonb_build_array(jsonb_build_object('field', 'batches', 'old', NULL, 'new', v_taken)),
    NULL,
    NULL,
    p_order_id
  );

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

  -- a person with several variants of the product among the favorites counts once
  SELECT COUNT(DISTINCT COALESCE(f."userId"::text, f."guestId"::text))::integer
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

-- A product that is removed from the catalog takes its live variants with it (the same time), so
-- a variant of a removed product is never sold and lets its article number and barcode go; a
-- restore of the product brings back the variants that went with it (the same time) and leaves
-- the ones an admin removed earlier. Runs as the owner: the variants are closed for plain changes
-- of the removal mark by anybody but admin and the system (db/05, product_variants_update_columns).
CREATE OR REPLACE FUNCTION cartlify.products_after_deleted_change () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  IF NEW."deletedAt" IS NOT NULL AND OLD."deletedAt" IS NULL THEN
    UPDATE cartlify.product_variants AS v
    SET "deletedAt" = NEW."deletedAt"
    WHERE v."productId" = NEW.id
      AND v."deletedAt" IS NULL;
  ELSIF NEW."deletedAt" IS NULL AND OLD."deletedAt" IS NOT NULL THEN
    UPDATE cartlify.product_variants AS v
    SET "deletedAt" = NULL
    WHERE v."productId" = NEW.id
      AND v."deletedAt" = OLD."deletedAt";
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_after_deleted_change ON cartlify.products;

CREATE TRIGGER trg_products_after_deleted_change
AFTER UPDATE OF "deletedAt" ON cartlify.products FOR EACH ROW
EXECUTE FUNCTION cartlify.products_after_deleted_change ();

-- Keeps the sale of a variant valid, whatever way the row changes (before an update of the
-- price, the sale price or the end of the sale). A sale that is set or changed must end in the
-- future (VARIANT_SALE_ENDS_AT_INVALID). A price changed down to the sale price or below ends
-- the sale: its fields and the lowest price of the 30 days before it go empty. A sale that was
-- still on gets a line of its end in the admin log (PRODUCT_SALE, event product.sale_end_by_price,
-- about the variant, with a change entry event = ended_by_price) in the
-- name of the admin who changed the price; the system has no id, so it is refused
-- (VARIANT_SALE_ACTOR_REQUIRED). The log of prices has the change of the price itself. Prices go
-- to the log as text without a trailing zero (trim_scale: 15.50 becomes 15.5), dates as iso utc.
-- Only an update is checked: rows copied in (dev restored from a copy of prod) keep their sales,
-- ended ones too. Prisma keeps dates as utc in columns without a time zone.
CREATE OR REPLACE FUNCTION cartlify.product_variants_before_price_change () RETURNS trigger LANGUAGE plpgsql AS $$
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
    RAISE EXCEPTION 'VARIANT_SALE_ENDS_AT_INVALID';
  END IF;

  IF NEW."price" IS DISTINCT FROM OLD."price"
     AND NEW."salePrice" IS NOT NULL
     AND NEW."price" <= NEW."salePrice"
  THEN
    IF NEW."saleEndsAt" > v_now THEN
      IF v_actor_id IS NULL OR NOT cartlify.is_admin() THEN
        RAISE EXCEPTION 'VARIANT_SALE_ACTOR_REQUIRED';
      END IF;

      PERFORM cartlify.log_admin_action(
        v_actor_id,
        cartlify.current_actor_role(),
        'variant',
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

DROP TRIGGER IF EXISTS trg_product_variants_before_price_change ON cartlify.product_variants;

CREATE TRIGGER trg_product_variants_before_price_change
BEFORE UPDATE OF "price", "salePrice", "saleEndsAt" ON cartlify.product_variants FOR EACH ROW
EXECUTE FUNCTION cartlify.product_variants_before_price_change ();

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

-- Refreshes the item prices of an order from the prices its variants sell at now
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
  SET "unitPrice" = cartlify.product_current_price(v."price", v."salePrice", v."saleEndsAt")
  FROM cartlify.product_variants AS v
  WHERE oi."orderId" = p_order_id
    AND v.id = oi."variantId"
    AND oi."unitPrice" IS DISTINCT FROM
      cartlify.product_current_price(v."price", v."salePrice", v."saleEndsAt");

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

-- Confirms an order: reserves the stock, checks the prices, fixes the delivery price and sets the
-- reservation deadline (the status becomes waiting). System function: runs as the owner, acts
-- only for a USER (ORDER_CONFIRM_FORBIDDEN) and only on an order of their own: the order of
-- another user is not found (ORDER_NOT_FOUND). The delivery of the order
-- (order_deliveries) must be written before. Its price is fixed here by the rule in the
-- arguments (the flat price and the free-from sum come from the settings of the server). When
-- the buyer sent the price he saw (p_expected_delivery_price) and the rule gives another one,
-- the confirmation is refused (ORDER_DELIVERY_PRICE_CHANGED); an item price that is not the
-- price its variant sells at now refuses it too (ORDER_PRICES_CHANGED). The order keeps the days
-- to withdraw and who pays the way back of the contract in force, its latest version. The function
-- holds the shared lock of the contract kind until the commit, as a consent does, so a contract
-- published meanwhile waits and the consent written after it is to the version the order kept (a
-- consent to an older one is refused, LEGAL_DOCUMENT_NOT_CURRENT). The server takes that lock
-- before it reads the versions the buyer accepted, so the order never keeps a contract its buyer
-- did not accept. Both stay empty while no contract is published.
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

  v_withdrawal_days integer;
  v_return_payer    cartlify."ReturnShippingPayer";

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

  -- reserve stock (deterministic lock order by variantId)
  FOR r IN
    SELECT oi."variantId" AS variant_id,
           SUM(oi.quantity)::integer AS qty
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = p_order_id
    GROUP BY oi."variantId"
    ORDER BY oi."variantId"
  LOOP
    PERFORM cartlify.reserve_variant_stock(r.variant_id, r.qty);
  END LOOP;

  -- the reservation above locked the variant rows, so prices cannot change until the commit:
  -- refuse when an item price differs from the price its variant sells at now (a sale that just
  -- ended counts), the buyer must confirm the amount he sees
  IF EXISTS (
    SELECT 1
    FROM cartlify.order_items AS oi
    JOIN cartlify.product_variants AS v ON v.id = oi."variantId"
    WHERE oi."orderId" = p_order_id
      AND oi."unitPrice" IS DISTINCT FROM
        cartlify.product_current_price(v."price", v."salePrice", v."saleEndsAt")
  ) THEN
    RAISE EXCEPTION 'ORDER_PRICES_CHANGED';
  END IF;

  -- the items keep the names their variants have now, the history shows what was bought; the
  -- update goes through order_items_before_ins_upd while the order is not confirmed yet
  UPDATE cartlify.order_items AS oi
  SET "productName" = cartlify.variant_display_name(oi."variantId")
  WHERE oi."orderId" = p_order_id
    AND oi."productName" IS DISTINCT FROM cartlify.variant_display_name(oi."variantId");

  -- the rule of withdrawal each item keeps is the one of this moment, whatever the cart kept from
  -- before; the update goes through order_items_before_ins_upd, which sets the same value
  UPDATE cartlify.order_items AS oi
  SET "withdrawal" = w.rule
  FROM cartlify.product_withdrawals(
    (SELECT array_agg(DISTINCT i."productId") FROM cartlify.order_items AS i WHERE i."orderId" = p_order_id)
  ) AS w
  WHERE oi."orderId" = p_order_id
    AND oi."productId" = w."productId"
    AND oi."withdrawal" IS DISTINCT FROM w.rule;

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

  -- the contract in force: its days to withdraw and its payer of the way back stay with the order;
  -- none published leaves both empty
  PERFORM pg_advisory_xact_lock_shared(hashtext('cartlify.legal_documents:contract'));

  SELECT d."withdrawalDays", d."returnShippingPaidBy"
  INTO v_withdrawal_days, v_return_payer
  FROM cartlify.legal_documents AS d
  WHERE d.kind = 'contract'
  ORDER BY d.version DESC
  LIMIT 1;

  -- confirm order and set reservation deadline
  UPDATE cartlify.orders AS o
  SET
    confirmed = true,
    status = 'waiting',
    "reservationExpiresAt" = clock_timestamp() + p_reserve_for,
    "withdrawalDays" = v_withdrawal_days,
    "returnShippingPaidBy" = v_return_payer
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

  -- release reserved stock (deterministic lock order by variantId)
  FOR r IN
    SELECT oi."variantId" AS variant_id,
           SUM(oi.quantity)::integer AS qty
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = p_order_id
    GROUP BY oi."variantId"
    ORDER BY oi."variantId"
  LOOP
    PERFORM cartlify.release_variant_stock(r.variant_id, r.qty);
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

  -- release reserved stock (deterministic lock order by variantId)
  FOR r IN
    SELECT oi."variantId" AS variant_id,
           SUM(oi.quantity)::integer AS qty
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = p_order_id
    GROUP BY oi."variantId"
    ORDER BY oi."variantId"
  LOOP
    PERFORM cartlify.release_variant_stock(r.variant_id, r.qty);
  END LOOP;

  UPDATE cartlify.orders AS o
  SET
    confirmed = false,
    status = 'unconfirmed',
    "reservationExpiresAt" = NULL
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
  v_withdrawal_days   integer;
  v_return_payer      cartlify."ReturnShippingPayer";

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
        SELECT oi."variantId" AS variant_id,
               SUM(oi.quantity)::integer AS qty
        FROM cartlify.order_items AS oi
        WHERE oi."orderId" = p_order_id
        GROUP BY oi."variantId"
        ORDER BY oi."variantId"
      LOOP
        PERFORM cartlify.consume_variant_stock(p_order_id, r.variant_id, r.qty);
      END LOOP;
    EXCEPTION
      WHEN raise_exception THEN
        -- all or nothing: stock changes made in this block are rolled back
        IF SQLERRM = 'VARIANT_BATCHES_SHORT' THEN
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
        SELECT oi."variantId" AS variant_id,
               SUM(oi.quantity)::integer AS qty
        FROM cartlify.order_items AS oi
        WHERE oi."orderId" = p_order_id
        GROUP BY oi."variantId"
        ORDER BY oi."variantId"
      LOOP
        PERFORM cartlify.reserve_variant_stock(r.variant_id, r.qty);
        PERFORM cartlify.consume_variant_stock(p_order_id, r.variant_id, r.qty);
      END LOOP;
    EXCEPTION
      WHEN raise_exception THEN
        -- all or nothing: stock changes made in this block are rolled back
        IF SQLERRM IN ('INSUFFICIENT_AVAILABLE_STOCK', 'VARIANT_NOT_FOUND', 'VARIANT_BATCHES_SHORT') THEN
          RETURN 'OUT_OF_STOCK';
        END IF;

        RAISE;
    END;

    -- the order is confirmed by its payment: it keeps the term and the payer of the way back of
    -- the contract in force now, as confirm_order does (the unconfirm took the old ones away)
    PERFORM pg_advisory_xact_lock_shared(hashtext('cartlify.legal_documents:contract'));

    SELECT d."withdrawalDays", d."returnShippingPaidBy"
    INTO v_withdrawal_days, v_return_payer
    FROM cartlify.legal_documents AS d
    WHERE d.kind = 'contract'
    ORDER BY d.version DESC
    LIMIT 1;
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
    "paidAt" = now() AT TIME ZONE 'UTC',
    "withdrawalDays" = CASE WHEN v_confirmed THEN o."withdrawalDays" ELSE v_withdrawal_days END,
    "returnShippingPaidBy" = CASE WHEN v_confirmed THEN o."returnShippingPaidBy" ELSE v_return_payer END
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

    -- release reserved stock (deterministic lock order by variantId)
    FOR r IN
      SELECT oi."variantId" AS variant_id,
             SUM(oi.quantity)::integer AS qty
      FROM cartlify.order_items AS oi
      WHERE oi."orderId" = p_order_id
      GROUP BY oi."variantId"
      ORDER BY oi."variantId"
    LOOP
      PERFORM cartlify.release_variant_stock(r.variant_id, r.qty);
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

-- The rule of withdrawal of each product asked, and where it comes from. A product has the rule of
-- its own; without one it takes the rule of the nearest category above it that has one (its own
-- category first, then each parent up the tree); without any it is allowed. source is product,
-- category (categoryId names it) or default. The one rule for every reader: the card of an admin,
-- the cart, the confirmation of an order, the mails. It runs as the owner and reads nothing but
-- the rule, so a buyer gets it for a product they cannot see in the catalog any more (one that was
-- taken out while it lay in their cart); a product that is not there gives no row. It checks no
-- actor on purpose: the rule is shown to everybody in the card of a product, and the function
-- returns nothing else.
CREATE OR REPLACE FUNCTION cartlify.product_withdrawals (p_product_ids integer[])
RETURNS TABLE ("productId" integer, rule cartlify."WithdrawalRule", source text, "categoryId" integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
  WITH RECURSIVE up AS (
    SELECT p.id AS product_id, c.id AS category_id, c.withdrawal, c."parentId", 0 AS depth
    FROM cartlify.products AS p
    JOIN cartlify.categories AS c ON c.id = p."categoryId"
    WHERE p.id = ANY (p_product_ids)
    UNION ALL
    SELECT up.product_id, c.id, c.withdrawal, c."parentId", up.depth + 1
    FROM up
    JOIN cartlify.categories AS c ON c.id = up."parentId"
    WHERE up.depth < 100
  ),
  nearest AS (
    SELECT DISTINCT ON (u.product_id) u.product_id, u.category_id, u.withdrawal
    FROM up AS u
    WHERE u.withdrawal IS NOT NULL
    ORDER BY u.product_id, u.depth
  )
  SELECT
    p.id,
    COALESCE(p.withdrawal, n.withdrawal, 'allowed'::cartlify."WithdrawalRule"),
    CASE
      WHEN p.withdrawal IS NOT NULL THEN 'product'
      WHEN n.withdrawal IS NOT NULL THEN 'category'
      ELSE 'default'
    END,
    CASE WHEN p.withdrawal IS NULL THEN n.category_id END
  FROM cartlify.products AS p
  LEFT JOIN nearest AS n ON n.product_id = p.id
  WHERE p.id = ANY (p_product_ids);
$$;

-- Takes the unit price and the name from the variant and calculates the total price of an item
-- (before an insert or update). The price is the one the variant sells at now, never one from
-- the caller. The order must be one the actor can change: RLS hides foreign and confirmed orders
-- (ORDER_NOT_EDITABLE), a confirmed order seen by an admin refuses too (ORDER_ALREADY_CONFIRMED).
-- The rule of withdrawal of the product comes from the database too (product_withdrawals), never
-- from the caller. The confirmation fixes the price, the name and the rule, because items of a
-- confirmed order cannot change.
CREATE OR REPLACE FUNCTION cartlify.order_items_before_ins_upd () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_confirmed boolean;
  v_price cartlify.product_variants.price%TYPE;
  v_name text;
  v_deleted_at cartlify.product_variants."deletedAt"%TYPE;
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

  -- unit price always comes from the variant, never from the caller: the price it sells at now
  SELECT cartlify.product_current_price(v."price", v."salePrice", v."saleEndsAt"),
         cartlify.variant_display_name(v.id),
         v."deletedAt"
  INTO v_price, v_name, v_deleted_at
  FROM cartlify.product_variants AS v
  WHERE v.id = NEW."variantId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VARIANT_NOT_FOUND';
  END IF;

  -- a variant that is deleted (a product that is deleted takes its variants with it) goes into
  -- no order; an item that holds one since before the removal keeps it, the app drops such items
  -- when it reads the order
  IF v_deleted_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."variantId" IS DISTINCT FROM OLD."variantId") THEN
    RAISE EXCEPTION 'VARIANT_NOT_FOUND';
  END IF;

  NEW."unitPrice" := v_price;
  NEW."totalPrice" := NEW."unitPrice" * NEW."quantity";
  NEW."productName" := v_name;

  -- the rule of the product as it is now; a product that is not there leaves the default
  NEW."withdrawal" := COALESCE(
    (SELECT w.rule FROM cartlify.product_withdrawals(ARRAY[NEW."productId"]) AS w),
    'allowed'
  );

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

-- Guards the updates of an order. It stamps updatedAt, except for a change of the return status
-- alone. It owns deliveredAt (the step to delivered may give the day the carrier delivered): the step to
-- delivered stamps it, every other state has none, and what a statement writes there is
-- overwritten. Going back to unconfirmed (the payment was cancelled or the reservation ended)
-- makes the total the items again and forgets the term of the contract the confirmation kept;
-- the delivery is priced again at the next confirmation. A confirmed order keeps its owner and
-- its total (ORDER_CONFIRMED_CHANGE_FORBIDDEN). At the confirmation the delivery must be written
-- (ORDER_DELIVERY_REQUIRED) and the total becomes the items plus the delivery price.
CREATE OR REPLACE FUNCTION cartlify.orders_before_update () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_total cartlify.orders.total%TYPE;
  v_delivery_price numeric;
BEGIN
  -- prisma stamps updatedAt only in its own queries, the db functions (pay, confirm, cancel,
  -- expire) change orders too; the column holds utc time without a zone, as prisma writes it.
  -- Where the order stands as to its statements (refresh_return_state) is a summary, no change of
  -- the order: it keeps its time (a shipped order keeps the time it was sent, the alerts count
  -- from it)
  IF to_jsonb(NEW) - 'returnStatus' - 'updatedAt' = to_jsonb(OLD) - 'returnStatus' - 'updatedAt' THEN
    NEW."updatedAt" := OLD."updatedAt";
  ELSE
    NEW."updatedAt" := now() AT TIME ZONE 'UTC';
  END IF;

  -- the time of the delivery: the step to delivered stamps it, or keeps the day the admin gives
  -- (the carrier delivered it before the admin marked it): not before the order was sent (paid,
  -- for a pickup), never of the future (ORDER_DELIVERED_AT_INVALID). No other step writes it
  IF NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered' THEN
    IF NEW."deliveredAt" IS NULL THEN
      NEW."deliveredAt" := now() AT TIME ZONE 'UTC';
    ELSIF NEW."deliveredAt" > now() AT TIME ZONE 'UTC'
       OR NEW."deliveredAt" < COALESCE(
         (
           SELECT MAX(sh."shippedAt")
           FROM cartlify.order_shipments AS sh
           WHERE sh."orderId" = NEW.id AND sh."rolledBackAt" IS NULL
         ),
         NEW."paidAt"
       ) THEN
      RAISE EXCEPTION 'ORDER_DELIVERED_AT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'delivered' THEN
    NEW."deliveredAt" := OLD."deliveredAt";
  ELSE
    NEW."deliveredAt" := NULL;
  END IF;

  IF OLD."confirmed" AND NOT NEW."confirmed" THEN
    -- back to unconfirmed (the payment was cancelled or the reservation ended): the order is a
    -- cart again and costs what its items cost, the delivery is priced again at the next
    -- confirmation, which keeps the term of the contract in force then
    IF NEW."userId" IS DISTINCT FROM OLD."userId" THEN
      RAISE EXCEPTION 'ORDER_CONFIRMED_CHANGE_FORBIDDEN'
        USING ERRCODE = 'check_violation';
    END IF;

    NEW."withdrawalDays" := NULL;
    NEW."returnShippingPaidBy" := NULL;

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

-- The end of the period in which a buyer may withdraw from an order: the end of the last day, in
-- the time zone of the shop, of the days of the contract and the days of grace counted after the
-- day of the delivery (that day is not counted). The one rule of the end: the answers of the app
-- and the check of a statement both take it from here. The time is utc without a zone, as the
-- columns hold it; none for an order that is not delivered. A time zone the database does not
-- know is an error.
CREATE OR REPLACE FUNCTION cartlify.withdrawal_ends_at (
  p_delivered_at timestamp without time zone,
  p_days integer,
  p_grace_days integer,
  p_time_zone text
) RETURNS timestamp without time zone LANGUAGE sql STABLE
SET
  search_path = cartlify,
  pg_temp AS $$
  SELECT CASE
    WHEN p_delivered_at IS NULL THEN NULL
    ELSE (
      (
        ((p_delivered_at AT TIME ZONE 'UTC') AT TIME ZONE p_time_zone)::date
        + (p_days + p_grace_days + 1)
      )::timestamp AT TIME ZONE p_time_zone
    ) AT TIME ZONE 'UTC' - interval '1 millisecond'
  END;
$$;

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

-- Refuses a new favorite for a variant taken out of sale (VARIANT_NOT_FOUND); a product that is
-- removed takes its variants with it, the rule above stays for the reviews.
CREATE OR REPLACE FUNCTION cartlify.refuse_removed_variant () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cartlify.product_variants AS v
    WHERE v.id = NEW."variantId"
      AND v."deletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'VARIANT_NOT_FOUND';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_favorites_refuse_removed_variant ON cartlify.favorites;

CREATE TRIGGER trg_favorites_refuse_removed_variant
BEFORE INSERT ON cartlify.favorites FOR EACH ROW
EXECUTE FUNCTION cartlify.refuse_removed_variant ();

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

-- Writes a line of the price log of a variant. System function: runs as the owner, the app
-- writes no line straight into the table (db/03). Callable only by a signed-in admin or root
-- with an id, the line is in their name (PRICE_LOG_FORBIDDEN, PRICE_LOG_ACTOR_REQUIRED). A
-- change that changes nothing is no line.
-- p_event names what made the line (price.set, price.set_batch, price.bulk, price.sale_start,
-- price.sale_end), see src/config/journalEvents.ts. p_mode is how the change was given and
-- p_value is its size in that mode: the percent of the price or the amount of money, negative
-- for a change down. A line with an end (p_ends_at) is the start of a sale, from the price down
-- to the sale price (db/06); a sale taken off goes from the sale price back to the price.
CREATE OR REPLACE FUNCTION cartlify.log_variant_price_change (
  p_variant_id integer,
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
  v_product_id integer;
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

  SELECT v."productId"
  INTO v_product_id
  FROM cartlify.product_variants AS v
  WHERE v.id = p_variant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VARIANT_NOT_FOUND';
  END IF;

  INSERT INTO cartlify."product_price_change_logs" (
    "productId",
    "variantId",
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
    v_product_id,
    p_variant_id,
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
-- address and the browser of old logins and of closed statements of return, make the personal
-- data of closed statements and of the recipients of the orders of deleted accounts anonymous,
-- remove the favorites and the chats of guests who stopped coming, and the chats of accounts
-- deleted long ago; three more clear what the newsletters leave (a request to subscribe that was
-- never confirmed, the proof of the consent of an ended subscription with its journal, the mails of
-- a campaign that ended). The time each kind of data is kept is in the privacy policy of the shop
-- (legal_documents, kind privacy, one column of days for each): a row is kept for the SHORTER of
-- the term of the version in force when the data was collected and the term of the version in force
-- now, and cleaned a day before the term ends, so a task that runs once a day never cleans late
-- (a term of one day cleans at once). Without a published policy nothing is cleaned. Each function
-- is the work of the system (the admin context without a user id), meant for a periodic task, e.g.
-- SELECT * FROM cartlify.cleanup_guest_data(). The ones that run as the owner reach the rows
-- through narrow policies (db/03) and the guards of the tables (db/05).

-- The moment the cleanups count from, utc as the columns keep it. Only the system may ask
-- (RETENTION_CLEANUP_FORBIDDEN). Internal.
CREATE OR REPLACE FUNCTION cartlify.retention_now () RETURNS timestamp LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  IF NOT cartlify.is_system() THEN
    RAISE EXCEPTION 'RETENTION_CLEANUP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN now() AT TIME ZONE 'UTC';
END;
$$;

-- The days of a kind of data in a version of the privacy policy, by the name of its column
-- (RETENTION_FIELD_INVALID for any other). Internal.
CREATE OR REPLACE FUNCTION cartlify.retention_days_of (
  p_field text,
  p_policy cartlify.legal_documents
) RETURNS integer LANGUAGE plpgsql IMMUTABLE
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  RETURN CASE p_field
    WHEN 'retentionLoginAddressesDays' THEN p_policy."retentionLoginAddressesDays"
    WHEN 'retentionGuestDataDays' THEN p_policy."retentionGuestDataDays"
    WHEN 'retentionDeletedChatsDays' THEN p_policy."retentionDeletedChatsDays"
    WHEN 'retentionReturnAddressesDays' THEN p_policy."retentionReturnAddressesDays"
    WHEN 'retentionReturnPersonalDays' THEN p_policy."retentionReturnPersonalDays"
    WHEN 'retentionRecipientDays' THEN p_policy."retentionRecipientDays"
    WHEN 'retentionNewsletterConsentDays' THEN p_policy."retentionNewsletterConsentDays"
    WHEN 'retentionNewsletterRecipientsDays' THEN p_policy."retentionNewsletterRecipientsDays"
    ELSE NULL
  END;
END;
$$;

-- The days to keep data collected at a time: the shorter of the term of the version in force then
-- (the newest version published by then) and the term of the version in force now. None when no
-- policy is published, and for a data collected before the first version only the version in force
-- now counts. Internal.
CREATE OR REPLACE FUNCTION cartlify.retention_days (p_field text, p_collected timestamp) RETURNS integer LANGUAGE plpgsql STABLE
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now  cartlify.legal_documents;
  v_then cartlify.legal_documents;
  v_a    integer;
  v_b    integer;
BEGIN
  IF p_field NOT IN (
    'retentionLoginAddressesDays', 'retentionGuestDataDays', 'retentionDeletedChatsDays',
    'retentionReturnAddressesDays', 'retentionReturnPersonalDays', 'retentionRecipientDays',
    'retentionNewsletterConsentDays', 'retentionNewsletterRecipientsDays'
  ) THEN
    RAISE EXCEPTION 'RETENTION_FIELD_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT d.* INTO v_now
  FROM cartlify.legal_documents AS d
  WHERE d.kind = 'privacy'
  ORDER BY d.version DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_a := cartlify.retention_days_of (p_field, v_now);

  SELECT d.* INTO v_then
  FROM cartlify.legal_documents AS d
  WHERE d.kind = 'privacy' AND d."createdAt" <= p_collected
  ORDER BY d.version DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN v_a;
  END IF;

  v_b := cartlify.retention_days_of (p_field, v_then);

  RETURN LEAST(v_a, v_b);
END;
$$;

-- The shortest term a kind of data has in any version: no row younger than it (less the day in
-- hand) is ever due, so the cleanups skip them without asking the policy for each. None without a
-- policy. Internal.
CREATE OR REPLACE FUNCTION cartlify.retention_floor (p_field text) RETURNS integer LANGUAGE plpgsql STABLE
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_floor integer;
BEGIN
  SELECT min(cartlify.retention_days_of (p_field, d)) INTO v_floor
  FROM cartlify.legal_documents AS d
  WHERE d.kind = 'privacy';

  RETURN v_floor;
END;
$$;

-- Whether data collected at p_collected is due for the cleanup: its term, a day in hand, has passed
-- since p_since (the time the term counts from). False without a policy. Internal.
CREATE OR REPLACE FUNCTION cartlify.retention_due (
  p_field text,
  p_collected timestamp,
  p_since timestamp,
  p_now timestamp
) RETURNS boolean LANGUAGE plpgsql STABLE
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_days integer := cartlify.retention_days (p_field, p_collected);
BEGIN
  RETURN v_days IS NOT NULL AND p_since + make_interval(days => v_days - 1) <= p_now;
END;
$$;

-- Empties the address and the browser of the logins whose term has passed; the line stays as
-- history (who logged in, when, with which role). Returns how many lines it emptied.
CREATE OR REPLACE FUNCTION cartlify.cleanup_login_log_addresses () RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := cartlify.retention_now();
  v_floor integer := cartlify.retention_floor ('retentionLoginAddressesDays');
  v_count integer;
BEGIN
  IF v_floor IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE cartlify.login_logs AS l
  SET
    "ipAddress" = NULL,
    "userAgent" = NULL
  WHERE l."createdAt" <= v_now - make_interval(days => v_floor - 1)
    AND (l."ipAddress" IS NOT NULL OR l."userAgent" IS NOT NULL)
    AND cartlify.retention_due ('retentionLoginAddressesDays', l."createdAt", l."createdAt", v_now);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Removes the favorites and the chats of guests who have not come for as long as the term: a guest
-- is gone when the newest of their favorites and chat messages is older. A guest who came lately
-- keeps all of it, an old favorite too; the messages go with their chats. Returns how many
-- favorites and chats went.
CREATE OR REPLACE FUNCTION cartlify.cleanup_guest_data () RETURNS TABLE (
  removed_favorites integer,
  removed_chats integer
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now    timestamp := cartlify.retention_now();
  v_floor  integer := cartlify.retention_floor ('retentionGuestDataDays');
  v_guests uuid[];
BEGIN
  removed_favorites := 0;
  removed_chats := 0;

  IF v_floor IS NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

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
    HAVING max(a.at) <= v_now - make_interval(days => v_floor - 1)
       AND cartlify.retention_due ('retentionGuestDataDays', max(a.at), max(a.at), v_now)
  ) AS idle;

  -- a guest who came back since the list was made keeps what they made: everything the list saw is
  -- older than the line the term draws, what they made now is not
  DELETE FROM cartlify.favorites AS f
  WHERE f."userId" IS NULL AND f."guestId" = ANY (v_guests)
    AND f."createdAt" <= v_now - make_interval(days => v_floor - 1);
  GET DIAGNOSTICS removed_favorites = ROW_COUNT;

  DELETE FROM cartlify.chat_threads AS t
  WHERE t."userId" IS NULL AND t."guestId" = ANY (v_guests)
    AND t."lastMessageAt" <= v_now - make_interval(days => v_floor - 1);
  GET DIAGNOSTICS removed_chats = ROW_COUNT;

  RETURN NEXT;
END;
$$;

-- Removes the chats, with their messages, of the accounts deleted as long ago as the term; a
-- deletion keeps them for a while (an admin may still need the conversation). The term counts from
-- the deletion. Returns how many chats went.
CREATE OR REPLACE FUNCTION cartlify.cleanup_deleted_accounts_chats () RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := cartlify.retention_now();
  v_floor integer := cartlify.retention_floor ('retentionDeletedChatsDays');
  v_count integer;
BEGIN
  IF v_floor IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM cartlify.chat_threads AS t
  USING cartlify.users AS u
  WHERE u.id = t."userId"
    AND u."deletedAt" IS NOT NULL
    AND u."deletedAt" <= v_now - make_interval(days => v_floor - 1)
    AND cartlify.retention_due ('retentionDeletedChatsDays', t."createdAt", u."deletedAt", v_now);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Empties the address and the browser of the closed statements of return whose term has passed;
-- the statement stays whole. The journals go with it: the lines of the journal of the admins and
-- of the stock log that the buyer or the form caused for the statement (the request was theirs)
-- lose the address and the browser too, the lines of the admins keep theirs. The term counts from
-- the closing of the statement. Returns how many statements it emptied.
CREATE OR REPLACE FUNCTION cartlify.cleanup_return_addresses () RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := cartlify.retention_now();
  v_floor integer := cartlify.retention_floor ('retentionReturnAddressesDays');
  v_count integer;
BEGIN
  IF v_floor IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE cartlify.returns AS r
  SET
    ip = NULL,
    "userAgent" = NULL
  WHERE r."closedAt" IS NOT NULL
    AND r."closedAt" <= v_now - make_interval(days => v_floor - 1)
    AND (r.ip IS NOT NULL OR r."userAgent" IS NOT NULL)
    AND cartlify.retention_due ('retentionReturnAddressesDays', r."createdAt", r."closedAt", v_now);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- the lines a journal still keeps of the request of the buyer or of the form for such a statement
  -- (a line in the name of the buyer, or of the system for the form), also of a statement emptied
  -- before
  UPDATE cartlify.admin_audit_log AS a
  SET
    ip = NULL,
    "userAgent" = NULL
  FROM cartlify.returns AS r
  WHERE r."closedAt" IS NOT NULL
    AND r."closedAt" <= v_now - make_interval(days => v_floor - 1)
    AND a."entityType" = 'order'
    AND a."entityId" = r."orderId"
    AND a.meta @> jsonb_build_array(jsonb_build_object('field', 'returnId', 'new', r.id))
    AND a."actorRole" IS DISTINCT FROM 'ADMIN'
    AND a."actorRole" IS DISTINCT FROM 'ROOT'
    AND (a.ip IS NOT NULL OR a."userAgent" IS NOT NULL)
    AND cartlify.retention_due ('retentionReturnAddressesDays', r."createdAt", r."closedAt", v_now);

  UPDATE cartlify.stock_log AS l
  SET
    ip = NULL,
    "userAgent" = NULL
  FROM cartlify.return_items AS i
  JOIN cartlify.returns AS r ON r.id = i."returnId"
  WHERE l."returnItemId" = i.id
    AND r."closedAt" IS NOT NULL
    AND r."closedAt" <= v_now - make_interval(days => v_floor - 1)
    AND l."actorRole" IS DISTINCT FROM 'ADMIN'
    AND l."actorRole" IS DISTINCT FROM 'ROOT'
    AND (l.ip IS NOT NULL OR l."userAgent" IS NOT NULL)
    AND cartlify.retention_due ('retentionReturnAddressesDays', r."createdAt", r."closedAt", v_now);

  RETURN v_count;
END;
$$;

-- Makes the personal data of the closed statements of return anonymous once their term has passed:
-- the name and the email of the statement become the made-up ones the copy of prod has
-- (Recipient Customer, return+<id>@example.com), the words of the buyer, the link of the parcel and
-- the note of the root go (also the one of the money of the way back), the number of the parcel is
-- made up, and the notes of the rows (the
-- reason money was lowered, the words of the provider about a transfer, the way money was sent
-- outside the app). The money, the goods, the dates and the reasons stay: the reports stand on
-- them. The term counts from the closing of the statement. Returns how many statements it made
-- anonymous.
CREATE OR REPLACE FUNCTION cartlify.cleanup_return_personal () RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := cartlify.retention_now();
  v_floor integer := cartlify.retention_floor ('retentionReturnPersonalDays');
  v_ids   integer[];
BEGIN
  IF v_floor IS NULL THEN
    RETURN 0;
  END IF;

  SELECT coalesce(array_agg(r.id), ARRAY[]::integer[])
  INTO v_ids
  FROM cartlify.returns AS r
  WHERE r."closedAt" IS NOT NULL
    AND r."closedAt" <= v_now - make_interval(days => v_floor - 1)
    AND r."contactEmail" <> 'return+' || r.id || '@example.com'
    AND cartlify.retention_due ('retentionReturnPersonalDays', r."createdAt", r."closedAt", v_now);

  UPDATE cartlify.returns AS r
  SET
    "contactName" = 'Recipient Customer',
    "contactEmail" = 'return+' || r.id || '@example.com',
    description = NULL,
    "proofTrackingNumber" = CASE WHEN r."proofTrackingNumber" IS NOT NULL THEN 'R' || r.id END,
    "proofTrackingUrl" = NULL,
    "closeNote" = CASE WHEN r."closeNote" IS NOT NULL THEN 'Cleared' END,
    "shippingReimbursedNote" = CASE
      WHEN r."shippingReimbursedNote" IS NOT NULL THEN 'Paid back outside the app'
    END
  WHERE r.id = ANY (v_ids);

  UPDATE cartlify.return_items AS i
  SET
    "amountNote" = CASE WHEN i."amountNote" IS NOT NULL THEN 'Lowered by the shop' END,
    "outsideNote" = CASE WHEN i."outsideNote" IS NOT NULL THEN 'Sent outside the app' END,
    "refundFailureText" = NULL
  WHERE i."returnId" = ANY (v_ids)
    AND (i."amountNote" IS NOT NULL OR i."outsideNote" IS NOT NULL OR i."refundFailureText" IS NOT NULL);

  RETURN cardinality(v_ids);
END;
$$;

-- Makes the recipient of the orders of deleted accounts anonymous once the term has passed: the
-- name, the phone, the address and the note of the delivery become made up (Recipient Customer,
-- +10000000000, City, Street, 0). The country, the method and the price stay. An order that is
-- paid or on its way, and one with an open statement of return, keeps its recipient: it is still
-- being worked. So does a delivered order while its period of withdrawal may run (the days of its
-- contract and the longest grace a shop sets, 30 days, with a day more for the zone of the shop):
-- the public form asks for the name of the recipient, and a deleted account keeps the right. The
-- term counts from the deletion of the account for the rest. Returns how many deliveries it made
-- anonymous.
CREATE OR REPLACE FUNCTION cartlify.cleanup_deleted_accounts_recipients () RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := cartlify.retention_now();
  v_floor integer := cartlify.retention_floor ('retentionRecipientDays');
  v_count integer;
BEGIN
  IF v_floor IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE cartlify.order_deliveries AS d
  SET
    "recipientFirstName" = 'Recipient',
    "recipientLastName" = 'Customer',
    "recipientPhone" = '+10000000000',
    "postalCode" = NULL,
    city = CASE WHEN d.method = 'manual' THEN 'City' END,
    street = CASE WHEN d.method = 'manual' THEN 'Street' END,
    house = CASE WHEN d.method = 'manual' THEN '0' END,
    apartment = NULL,
    note = NULL
  FROM cartlify.orders AS o
  JOIN cartlify.users AS u ON u.id = o."userId"
  WHERE o.id = d."orderId"
    AND u."deletedAt" IS NOT NULL
    AND u."deletedAt" <= v_now - make_interval(days => v_floor - 1)
    AND o.status NOT IN ('paid', 'shipped')
    AND NOT EXISTS (
      SELECT 1 FROM cartlify.returns AS r WHERE r."orderId" = o.id AND r."closedAt" IS NULL
    )
    AND (
      o."deliveredAt" IS NULL
      OR o."deliveredAt" + make_interval(days => COALESCE(o."withdrawalDays", 14) + 32) <= v_now
    )
    AND NOT (
      d."recipientFirstName" = 'Recipient'
      AND d."recipientLastName" = 'Customer'
      AND d."recipientPhone" = '+10000000000'
      AND d.note IS NULL
      AND d.apartment IS NULL
      AND d."postalCode" IS NULL
      AND (d.method = 'pickup' OR (d.city = 'City' AND d.street = 'Street' AND d.house = '0'))
    )
    AND cartlify.retention_due ('retentionRecipientDays', o."createdAt", u."deletedAt", v_now);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Removes the requests to subscribe that were not confirmed in time: the link of the mail works for
-- three days (confirmExpiresAt), and a request whose deadline has passed is ended (expired), then
-- its lines of the journal and its row go (the guard of the journal lets a line go only with an
-- ended subscription). Nothing of it is kept, nobody agreed to anything, so this cleanup has no
-- term in the privacy policy and works without one. A request that is confirmed, or asked again
-- (a new deadline), meanwhile is not taken: the update waits for its row and looks at it again.
-- Returns how many requests went.
CREATE OR REPLACE FUNCTION cartlify.cleanup_newsletter_pending () RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := cartlify.retention_now();
  v_ids   integer[];
  v_count integer;
BEGIN
  WITH ended AS (
    UPDATE cartlify.newsletter_subscriptions AS s
    SET
      status = 'ended',
      "confirmHash" = NULL,
      "confirmExpiresAt" = NULL,
      "endedAt" = v_now,
      "endReason" = 'expired',
      "updatedAt" = v_now
    WHERE s.status = 'pending' AND s."confirmExpiresAt" <= v_now
    RETURNING s.id
  )
  SELECT coalesce(array_agg(e.id), ARRAY[]::integer[]) INTO v_ids FROM ended AS e;

  DELETE FROM cartlify.newsletter_subscription_events AS e WHERE e."subscriptionId" = ANY (v_ids);

  DELETE FROM cartlify.newsletter_subscriptions AS s WHERE s.id = ANY (v_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Removes the proof of the consent of the subscriptions that ended long ago: an ended subscription,
-- or one stopped by a bounce, with its journal and its mails (the rows of recipients go with it).
-- The term counts from the end of the subscription; the data was collected when it was made, so the
-- version of the policy in force then counts too. A subscription in force, paused or waiting is
-- never taken. Returns how many subscriptions went.
CREATE OR REPLACE FUNCTION cartlify.cleanup_newsletter_consent () RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := cartlify.retention_now();
  v_floor integer := cartlify.retention_floor ('retentionNewsletterConsentDays');
  v_ids   integer[];
  v_count integer;
BEGIN
  IF v_floor IS NULL THEN
    RETURN 0;
  END IF;

  SELECT coalesce(array_agg(s.id), ARRAY[]::integer[])
  INTO v_ids
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s.status IN ('ended', 'stopped_bounce')
    AND s."endedAt" <= v_now - make_interval(days => v_floor - 1)
    AND cartlify.retention_due ('retentionNewsletterConsentDays', s."createdAt", s."endedAt", v_now);

  DELETE FROM cartlify.newsletter_subscription_events AS e WHERE e."subscriptionId" = ANY (v_ids);

  DELETE FROM cartlify.newsletter_subscriptions AS s
  WHERE s.id = ANY (v_ids) AND s.status IN ('ended', 'stopped_bounce');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Removes the rows of the mails of the campaigns that ended (finished, stopped or cancelled) once
-- their term has passed; the campaign with its totals, the subscriptions and their journals stay. A
-- campaign that is scheduled or sending has not ended, its mails are kept. The term counts from the
-- end of the campaign (the finish, the stop or the cancellation); the data was collected when the
-- rows were made, so the version in force then counts too. The rows of one campaign are made at
-- once, so the policy is asked once for each campaign and moment, not for each mail. Returns how
-- many rows went.
CREATE OR REPLACE FUNCTION cartlify.cleanup_newsletter_recipients () RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := cartlify.retention_now();
  v_floor integer := cartlify.retention_floor ('retentionNewsletterRecipientsDays');
  v_count integer;
BEGIN
  IF v_floor IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM cartlify.newsletter_recipients AS r
  USING (
    SELECT g."campaignId", g.collected
    FROM (
      SELECT
        m."campaignId",
        m."createdAt" AS collected,
        coalesce(c."finishedAt", c."stoppedAt", c."cancelledAt") AS ended
      FROM cartlify.newsletter_recipients AS m
      JOIN cartlify.newsletter_campaigns AS c ON c.id = m."campaignId"
      WHERE c.status IN ('finished', 'stopped', 'cancelled')
        AND coalesce(c."finishedAt", c."stoppedAt", c."cancelledAt") <= v_now - make_interval(days => v_floor - 1)
      GROUP BY m."campaignId", m."createdAt", c."finishedAt", c."stoppedAt", c."cancelledAt"
    ) AS g
    WHERE cartlify.retention_due ('retentionNewsletterRecipientsDays', g.collected, g.ended, v_now)
  ) AS due
  WHERE r."campaignId" = due."campaignId" AND r."createdAt" = due.collected;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Moves the data of a guest to the account of a user who has just signed in: the favorites (a
-- variant the user has already is dropped) and the chats. Every guest chat becomes a chat of the user;
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

  -- FAVORITES: remove conflicts (user already has same variant)
  DELETE FROM cartlify.favorites f
  WHERE f."guestId" = p_guest_id
    AND EXISTS (
      SELECT 1
      FROM cartlify.favorites u
      WHERE u."userId" = p_user_id
        AND u."variantId" = f."variantId"
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

-- Sets what the database owns in a new version of a legal text (the terms, the contract or the
-- privacy policy): the next number of its kind, the sha256 of its text and the time, whatever
-- the row says. Two versions published at once wait for each other (an advisory lock of the
-- kind), and a version waits for the consents being written to its kind and for the orders being
-- confirmed (confirm_order). It is dated when it got that lock, not when its transaction began,
-- so every consent to the version before it comes earlier.
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

-- Checks and completes a new consent. It is to the terms or to the contract, never to the privacy
-- policy, which only informs (LEGAL_DOCUMENT_NOT_ACCEPTABLE). It must be to the version in force
-- of its kind, a newer version refuses it (LEGAL_DOCUMENT_NOT_CURRENT). The address and the
-- browser are the ones of the request (cartlify.request_ip, cartlify.request_user_agent, set with
-- the context), not what the row says. It holds the lock of its kind shared until it commits: a
-- version published meanwhile waits for it, and one published before it is seen here. It is
-- dated when it is written.
CREATE OR REPLACE FUNCTION cartlify.legal_acceptances_before_insert () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_kind cartlify."LegalDocumentKind";
BEGIN
  SELECT d.kind INTO v_kind FROM cartlify.legal_documents AS d WHERE d.id = NEW."documentId";

  IF v_kind = 'privacy' THEN
    RAISE EXCEPTION 'LEGAL_DOCUMENT_NOT_ACCEPTABLE' USING ERRCODE = '23514';
  END IF;

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
-- root changes anything; the steps of the database verify an email or remove an avatar, and reset
-- a language that was turned off (locale emptied, nothing else).
-- The right to run the newsletters (canManageNewsletters) is the one column nobody changes by a
-- statement of their own, root included: it is set and taken off by the function of the database
-- that works for root (it runs as the owner, newsletter_set_manager), and it goes off by itself
-- when the role stops being ADMIN (trg_users_clear_newsletter_manager, which runs before this
-- guard and leaves the column off). A new account never has it either (trg_users_insert_columns).
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

  IF NEW."canManageNewsletters" IS DISTINCT FROM OLD."canManageNewsletters"
     AND NOT (current_user = 'cartlify_owner' AND cartlify.is_root())
     AND NOT (OLD."canManageNewsletters" AND NOT NEW."canManageNewsletters" AND NEW.role <> 'ADMIN') THEN
    RAISE EXCEPTION 'USER_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
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
       OR (
         NEW.locale IS NULL
         AND v_changed <@ ARRAY['locale', 'updatedAt']
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

-- Guard of products: an admin changes everything but what the database counts (the rating, the
-- review count, the popularity) and adds at most one view; a guest or a user changes only the
-- views (products_before_views_change limits it to one); the steps of the database change one
-- group of what they count at a time (the rating, the popularity).
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

-- Guard of variants: an admin changes everything but what the database counts (the stock and the
-- reserve) and the product of the variant (the rows that name the variant name its product too); a
-- variant of a removed product is not brought back by hand, only with its product. The steps of the
-- database change the stock and the reserve, one pair at a time, and the removal mark (a product
-- that is removed takes its variants with it).
CREATE OR REPLACE FUNCTION cartlify.product_variants_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
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
     AND NEW."productId" = OLD."productId"
     AND (
       NEW."deletedAt" IS NOT NULL
       OR OLD."deletedAt" IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM cartlify.products AS p
         WHERE p.id = NEW."productId"
           AND p."deletedAt" IS NOT NULL
       )
     ) THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner'
     AND (
       (
         NEW."stock" >= 0
         AND NEW."reservedStock" >= 0
         AND NEW."reservedStock" <= NEW."stock"
         AND v_changed <@ ARRAY['stock', 'reservedStock', 'updatedAt']
       )
       OR v_changed <@ ARRAY['deletedAt', 'updatedAt']
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'VARIANT_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_product_variants_update_columns ON cartlify.product_variants;

CREATE TRIGGER trg_product_variants_update_columns
BEFORE UPDATE ON cartlify.product_variants FOR EACH ROW
EXECUTE FUNCTION cartlify.product_variants_update_columns ();

-- A variant shows the pictures of the gallery of its own product only (VARIANT_IMAGE_NOT_FOUND,
-- check_violation). The picture and the variant of a row do not change afterwards except by this
-- rule too.
CREATE OR REPLACE FUNCTION cartlify.variant_images_before_write () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM cartlify.product_variants AS v
    JOIN cartlify.product_images AS i ON i."productId" = v."productId"
    WHERE v.id = NEW."variantId"
      AND i.id = NEW."imageId"
  ) THEN
    RAISE EXCEPTION 'VARIANT_IMAGE_NOT_FOUND'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_variant_images_before_write ON cartlify.variant_images;

CREATE TRIGGER trg_variant_images_before_write
BEFORE INSERT OR UPDATE OF "variantId", "imageId" ON cartlify.variant_images FOR EACH ROW
EXECUTE FUNCTION cartlify.variant_images_before_write ();

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
-- is not allowed), and the step to delivered and back carries deliveredAt, which the database
-- sets; the steps of the database change the total, the confirmation (with the term of the
-- contract it keeps) and the reservation, the payment, and the state of the order as to its
-- statements of return with the cancel they bring (refresh_return_state). The owner
-- changes nothing of an order with a plain update: where it goes is written in order_deliveries.
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

  -- a parcel the buyer refused is on its way back: the order does not become delivered meanwhile
  IF OLD.status = 'shipped' AND NEW.status = 'delivered' AND EXISTS (
    SELECT 1
    FROM cartlify.returns AS r
    WHERE r."orderId" = OLD.id AND r.reason = 'refused' AND r."closedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'ORDER_HAS_OPEN_REFUSAL';
  END IF;

  -- the steps of the shipping: paid to shipped to delivered, and one step back of each; a step
  -- over (paid to delivered) is not one
  IF cartlify.current_actor_role() IN ('ADMIN', 'ROOT')
     AND (OLD.status::text, NEW.status::text) IN (
       ('paid', 'shipped'), ('shipped', 'delivered'), ('shipped', 'paid'), ('delivered', 'shipped')
     )
     AND v_changed <@ ARRAY['status', 'deliveredAt', 'updatedAt'] THEN
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
         AND v_changed <@ ARRAY[
           'confirmed', 'status', 'reservationExpiresAt', 'total', 'withdrawalDays',
           'returnShippingPaidBy', 'updatedAt'
         ]
       )
       OR (
         NEW.confirmed = true
         AND NEW.status = 'waiting'
         AND NEW."reservationExpiresAt" IS NOT NULL
         AND NEW."paymentId" IS NULL
         AND NEW."paymentProvider" IS NULL
         AND NEW."total" >= 0
         AND cartlify.is_owner(NEW."userId")
         AND v_changed <@ ARRAY[
           'confirmed', 'status', 'reservationExpiresAt', 'total', 'withdrawalDays',
           'returnShippingPaidBy', 'updatedAt'
         ]
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
           'total', 'withdrawalDays', 'returnShippingPaidBy', 'updatedAt'
         ]
         -- the term of the contract comes only with the payment of an order the payment confirms
         AND (
           NOT OLD.confirmed
           OR NOT (v_changed && ARRAY['withdrawalDays', 'returnShippingPaidBy'])
         )
       )
       -- refresh_return_state: a paid order whose every unit is back, or a shipped one whose money
       -- is back, becomes cancelled with the time of the cancel
       OR (
         OLD.status IN ('paid', 'shipped')
         AND NEW.status = 'cancelled'
         AND NEW."cancelledAt" IS NOT NULL
         AND v_changed <@ ARRAY['status', 'cancelledAt', 'updatedAt']
       )
       -- refresh_return_state: where the order stands as to its statements, nothing else
       OR v_changed <@ ARRAY['returnStatus', 'updatedAt']
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

  -- cleanup_deleted_accounts_recipients makes the person and the address anonymous: the columns
  -- only take the made-up values (the address of a pickup stays empty)
  IF current_user = 'cartlify_owner'
     AND v_changed <@ ARRAY[
       'recipientFirstName', 'recipientLastName', 'recipientPhone', 'postalCode', 'city', 'street',
       'house', 'apartment', 'note', 'updatedAt'
     ]
     AND (NOT ('recipientFirstName' = ANY (v_changed)) OR NEW."recipientFirstName" = 'Recipient')
     AND (NOT ('recipientLastName' = ANY (v_changed)) OR NEW."recipientLastName" = 'Customer')
     AND (NOT ('recipientPhone' = ANY (v_changed)) OR NEW."recipientPhone" = '+10000000000')
     AND (NOT ('postalCode' = ANY (v_changed)) OR NEW."postalCode" IS NULL)
     AND (NOT ('apartment' = ANY (v_changed)) OR NEW.apartment IS NULL)
     AND (NOT ('note' = ANY (v_changed)) OR NEW.note IS NULL)
     AND (
       NOT ('city' = ANY (v_changed))
       OR NEW.city IS NOT DISTINCT FROM (CASE WHEN NEW.method = 'manual' THEN 'City' END)
     )
     AND (
       NOT ('street' = ANY (v_changed))
       OR NEW.street IS NOT DISTINCT FROM (CASE WHEN NEW.method = 'manual' THEN 'Street' END)
     )
     AND (
       NOT ('house' = ANY (v_changed))
       OR NEW.house IS NOT DISTINCT FROM (CASE WHEN NEW.method = 'manual' THEN '0' END)
     ) THEN
    RETURN NEW;
  END IF;

  -- A user may not touch the price, except that a pickup is free: the price goes to 0 together
  -- with the method (order_deliveries_before_update). The roles are of the app: a function of the
  -- owner writes only what the branches above let it, whatever context it runs in.
  IF current_user <> 'cartlify_owner'
     AND cartlify.current_actor_role() = 'USER'
     AND v_changed <@ ARRAY[
       'method', 'recipientFirstName', 'recipientLastName', 'recipientPhone', 'country',
       'postalCode', 'city', 'street', 'house', 'apartment', 'note', 'price', 'updatedAt'
     ]
     AND (NOT 'price' = ANY (v_changed) OR (NEW.method = 'pickup' AND NEW."price" = 0)) THEN
    RETURN NEW;
  END IF;

  IF current_user <> 'cartlify_owner'
     AND cartlify.current_actor_role() IN ('ADMIN', 'ROOT')
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

-- Guard of parties: the policy says who (admin or root), this says what. A party changes its name,
-- address, email and country, never its id (products name it by the id) or the day it was made.
CREATE OR REPLACE FUNCTION cartlify.parties_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF v_changed <@ ARRAY['name', 'address', 'email', 'country', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'PARTY_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_parties_update_columns ON cartlify.parties;

CREATE TRIGGER trg_parties_update_columns
BEFORE UPDATE ON cartlify.parties FOR EACH ROW
EXECUTE FUNCTION cartlify.parties_update_columns ();

-- Guard of documents: the policy says who (admin or root), this says what. A document changes its
-- title and kind; its file (url, public id, size), its id and its day stay as they were made.
CREATE OR REPLACE FUNCTION cartlify.documents_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF v_changed <@ ARRAY['title', 'kind', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'DOCUMENT_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_update_columns ON cartlify.documents;

CREATE TRIGGER trg_documents_update_columns
BEFORE UPDATE ON cartlify.documents FOR EACH ROW
EXECUTE FUNCTION cartlify.documents_update_columns ();

-- Guard of attribute groups: the policy says who, this says what. A group changes its name and place, never its id or its day.
CREATE OR REPLACE FUNCTION cartlify.attribute_groups_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF v_changed <@ ARRAY['name', 'position', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ATTRIBUTE_GROUPS_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_attribute_groups_update_columns ON cartlify.attribute_groups;

CREATE TRIGGER trg_attribute_groups_update_columns
BEFORE UPDATE ON cartlify.attribute_groups FOR EACH ROW
EXECUTE FUNCTION cartlify.attribute_groups_update_columns ();

-- Guard of characteristics: everything a characteristic is described by may change (the type only while the API allows it), never its id or its day.
CREATE OR REPLACE FUNCTION cartlify.attributes_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF v_changed <@ ARRAY['name', 'type', 'unit', 'groupId', 'position', 'isMain', 'inFilters', 'decimals', 'minValue', 'maxValue', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ATTRIBUTES_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_attributes_update_columns ON cartlify.attributes;

CREATE TRIGGER trg_attributes_update_columns
BEFORE UPDATE ON cartlify.attributes FOR EACH ROW
EXECUTE FUNCTION cartlify.attributes_update_columns ();

-- Guard of the values of a choice: a value changes its name, place and colour, never the characteristic it belongs to.
CREATE OR REPLACE FUNCTION cartlify.attribute_options_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF v_changed <@ ARRAY['name', 'position', 'colorCode', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ATTRIBUTE_OPTIONS_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_attribute_options_update_columns ON cartlify.attribute_options;

CREATE TRIGGER trg_attribute_options_update_columns
BEFORE UPDATE ON cartlify.attribute_options FOR EACH ROW
EXECUTE FUNCTION cartlify.attribute_options_update_columns ();

-- The value a variant holds of a characteristic stays within the type of the characteristic: the
-- column of the value is the one its type asks for, a number has no more digits after the point
-- than the characteristic allows and lies within its bounds, a value of a list is a value of this
-- characteristic, and a choice of one value has one row for a variant. The API says the same with
-- the reason (ATTRIBUTE_VALUE_*); this keeps a row that bypassed it out. A characteristic or a
-- value that is not there is left to the foreign keys. The error is a code (check_violation).
CREATE OR REPLACE FUNCTION cartlify.variant_attribute_values_before_write () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_type cartlify."AttributeType";
  v_decimals integer;
  v_min numeric;
  v_max numeric;
  v_option_attribute integer;
BEGIN
  SELECT a.type, a.decimals, a."minValue", a."maxValue"
  INTO v_type, v_decimals, v_min, v_max
  FROM cartlify.attributes AS a
  WHERE a.id = NEW."attributeId";

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NOT (
    CASE v_type
      WHEN 'text' THEN NEW."textValue" IS NOT NULL
      WHEN 'number' THEN NEW."numberValue" IS NOT NULL
      WHEN 'boolean' THEN NEW."boolValue" IS NOT NULL
      ELSE NEW."optionId" IS NOT NULL
    END
    AND num_nonnulls(NEW."textValue", NEW."numberValue", NEW."boolValue", NEW."optionId") = 1
  ) THEN
    RAISE EXCEPTION 'ATTRIBUTE_VALUE_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_type = 'number' THEN
    IF NEW."numberValue" <> round(NEW."numberValue", COALESCE(v_decimals, 0)) THEN
      RAISE EXCEPTION 'ATTRIBUTE_VALUE_TOO_PRECISE'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_min IS NOT NULL AND NEW."numberValue" < v_min THEN
      RAISE EXCEPTION 'ATTRIBUTE_VALUE_TOO_SMALL'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_max IS NOT NULL AND NEW."numberValue" > v_max THEN
      RAISE EXCEPTION 'ATTRIBUTE_VALUE_TOO_LARGE'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_type IN ('option', 'options') THEN
    SELECT o."attributeId"
    INTO v_option_attribute
    FROM cartlify.attribute_options AS o
    WHERE o.id = NEW."optionId";

    IF FOUND AND v_option_attribute <> NEW."attributeId" THEN
      RAISE EXCEPTION 'ATTRIBUTE_OPTION_NOT_FOUND'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- one value of a choice: the row of the variant is locked, so two rows made at once meet here
  -- (a row of a text, a number and yes/no is held by the unique index; the values of a set differ
  -- by the value)
  IF v_type = 'option' THEN
    PERFORM 1
    FROM cartlify.product_variants AS v
    WHERE v.id = NEW."variantId"
    FOR NO KEY UPDATE;

    IF EXISTS (
      SELECT 1
      FROM cartlify.variant_attribute_values AS x
      WHERE x."variantId" = NEW."variantId"
        AND x."attributeId" = NEW."attributeId"
        AND x.id <> NEW.id
    ) THEN
      RAISE EXCEPTION 'ATTRIBUTE_VALUE_REPEATED'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_variant_attribute_values_before_write ON cartlify.variant_attribute_values;

CREATE TRIGGER trg_variant_attribute_values_before_write
BEFORE INSERT OR UPDATE ON cartlify.variant_attribute_values FOR EACH ROW
EXECUTE FUNCTION cartlify.variant_attribute_values_before_write ();

-- Guard of the values of variants: the policy says who, this says what. A row keeps its variant and
-- its characteristic for good; only the value changes.
CREATE OR REPLACE FUNCTION cartlify.variant_attribute_values_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF v_changed <@ ARRAY['textValue', 'numberValue', 'boolValue', 'optionId'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'VARIANT_ATTRIBUTE_VALUES_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_variant_attribute_values_update_columns ON cartlify.variant_attribute_values;

CREATE TRIGGER trg_variant_attribute_values_update_columns
BEFORE UPDATE ON cartlify.variant_attribute_values FOR EACH ROW
EXECUTE FUNCTION cartlify.variant_attribute_values_update_columns ();

-- A characteristic whose type is changed while a variant holds a value of it would leave values of
-- the old type behind (the API refuses the change with ATTRIBUTE_TYPE_LOCKED and the numbers; this
-- is the net under it, for every role).
CREATE OR REPLACE FUNCTION cartlify.attributes_type_locked () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type IS DISTINCT FROM OLD.type
     AND EXISTS (
       SELECT 1 FROM cartlify.variant_attribute_values AS x WHERE x."attributeId" = OLD.id
     ) THEN
    RAISE EXCEPTION 'ATTRIBUTE_TYPE_LOCKED'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attributes_type_locked ON cartlify.attributes;

CREATE TRIGGER trg_attributes_type_locked
BEFORE UPDATE OF type ON cartlify.attributes FOR EACH ROW
EXECUTE FUNCTION cartlify.attributes_type_locked ();

-- Guard of the stock log: a line is history, written once by the functions that move the stock
-- and never changed or removed. The policies of db/03 deny every update and delete already; this
-- guard says it a second time for a role that would skip them. The one change: the cleanup of the
-- retention terms (cleanup_return_addresses, the owner) empties the address and the browser of a
-- line, nothing else. A superuser (a data script by hand, such as the cleanup of a development
-- database) is not checked, as rls does not check it either. The refusal is STOCK_LOG_APPEND_ONLY
-- with the code 42501.
CREATE OR REPLACE FUNCTION cartlify.stock_log_append_only () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND current_user = 'cartlify_owner'
     AND NEW.ip IS NULL
     AND NEW."userAgent" IS NULL
     AND to_jsonb(NEW) - 'ip' - 'userAgent' = to_jsonb(OLD) - 'ip' - 'userAgent' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'STOCK_LOG_APPEND_ONLY' USING ERRCODE = '42501';
END;
$$;

-- Guard of the journal of the admins: a line is never changed. The policies of db/03 deny every
-- update but the owner's; the one change of the owner is the cleanup of the retention terms
-- (cleanup_return_addresses), which empties the address and the browser of a line the buyer or
-- the form caused, nothing else. A superuser is not checked. The refusal is
-- ADMIN_AUDIT_LOG_APPEND_ONLY with the code 42501.
CREATE OR REPLACE FUNCTION cartlify.admin_audit_log_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner'
     AND NEW.ip IS NULL
     AND NEW."userAgent" IS NULL
     AND to_jsonb(NEW) - 'ip' - 'userAgent' = to_jsonb(OLD) - 'ip' - 'userAgent' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ADMIN_AUDIT_LOG_APPEND_ONLY' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_admin_audit_log_update_columns ON cartlify.admin_audit_log;

CREATE TRIGGER trg_admin_audit_log_update_columns
BEFORE UPDATE ON cartlify.admin_audit_log FOR EACH ROW
EXECUTE FUNCTION cartlify.admin_audit_log_update_columns ();

DROP TRIGGER IF EXISTS trg_stock_log_append_only ON cartlify.stock_log;

CREATE TRIGGER trg_stock_log_append_only
BEFORE UPDATE OR DELETE ON cartlify.stock_log FOR EACH ROW
EXECUTE FUNCTION cartlify.stock_log_append_only ();

------------------------------------------------------------
-- SHOP SETTINGS
------------------------------------------------------------
-- The shape of the value of each setting (db/06, shop_settings_value_chk): a CHECK constraint
-- cannot hold a subquery, so the shape is checked here, in plain functions. The rules between
-- settings (a pickup needs its address and hours, a free delivery a price, the language of the
-- shop is one turned on) are the server's: a row cannot see the rows of the other keys.

-- True for a list of texts, each matching a regular expression, none twice; an empty list is one.
CREATE OR REPLACE FUNCTION cartlify.shop_setting_list_valid (p_value jsonb, p_pattern text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(p_value) = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_value) AS e
      WHERE jsonb_typeof(e) <> 'string' OR (e #>> '{}') !~ p_pattern
    )
    AND jsonb_array_length(p_value) = (SELECT count(DISTINCT e) FROM jsonb_array_elements(p_value) AS e);
$$;

-- True when the value is of the shape its key takes; false for a key the server does not know.
-- Money is above zero to the cent and at most what an amount of the shop holds; a count is a
-- whole number; a text has the length its field allows; null is "no value" for a setting that
-- may stay without one (the prices, the logo, the seller).
CREATE OR REPLACE FUNCTION cartlify.shop_setting_value_valid (p_key text, p_value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_type text := jsonb_typeof(p_value);
  v_number numeric := CASE WHEN jsonb_typeof(p_value) = 'number' THEN (p_value)::numeric END;
  v_text text := CASE WHEN jsonb_typeof(p_value) = 'string' THEN p_value #>> '{}' END;
  v_whole boolean;
  v_valid boolean;
BEGIN
  v_whole := v_number IS NOT NULL AND v_number = trunc(v_number) AND v_number <= 2147483647;

  CASE p_key
    WHEN 'deliveryMethods' THEN
      v_valid := cartlify.shop_setting_list_valid(p_value, '^(manual|pickup)$');
    WHEN 'deliveryCountries' THEN
      v_valid := cartlify.shop_setting_list_valid(p_value, '^[A-Z]{2}$');
    WHEN 'enabledLocales' THEN
      v_valid := cartlify.shop_setting_list_valid(p_value, '^[a-z]{2}$');
    WHEN 'deliveryFlatPrice', 'deliveryFreeFrom' THEN
      v_valid := v_type = 'null'
        OR (v_number > 0 AND v_number <= 99999999.99 AND v_number = round(v_number, 2));
    WHEN 'pickupAddress', 'pickupHours' THEN
      v_valid := char_length(v_text) <= 300;
    WHEN 'shopName', 'emailFromName' THEN
      v_valid := char_length(v_text) <= 100;
    WHEN 'newsletterFromName' THEN
      -- the name the newsletters are sent under: one line of up to 100 characters, no control
      -- character (a line break in a name would split the header of the mail); empty falls back to
      -- emailFromName, then to the name of the shop
      v_valid := v_type = 'string' AND char_length(v_text) <= 100 AND v_text !~ '[[:cntrl:]]';
    WHEN 'newsletterTrustedDomains' THEN
      -- up to 50 host names, each in lower case with at least two labels of letters, digits and
      -- hyphens (a label of up to 63 characters, not starting or ending with a hyphen), the last one
      -- starting with a letter, the whole name of up to 253 characters; no scheme, path, port or dot
      -- at the end; none twice
      v_valid := CASE
        WHEN cartlify.shop_setting_list_valid(
          p_value,
          '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
        ) THEN jsonb_array_length(p_value) <= 50
        ELSE false
      END;
    WHEN 'emailReplyTo' THEN
      v_valid := char_length(v_text) <= 254;
    WHEN 'logoUrl', 'logoPublicId' THEN
      v_valid := v_type = 'null' OR v_text <> '';
    WHEN 'reservationMinutes' THEN
      v_valid := v_whole AND v_number > 0;
    WHEN 'stripePageMinutes' THEN
      v_valid := v_whole AND v_number >= 30;
    WHEN 'reviewCheckEnabled' THEN
      v_valid := v_type = 'boolean';
    WHEN 'avatarRemovalsLimit', 'reviewRemovalsLimit' THEN
      v_valid := v_whole AND v_number > 0;
    WHEN 'withdrawalGraceDays' THEN
      v_valid := v_whole AND v_number BETWEEN 0 AND 30;
    WHEN 'newsletterLimitCount' THEN
      v_valid := v_whole AND v_number BETWEEN 1 AND 100;
    WHEN 'newsletterLimitDays' THEN
      v_valid := v_whole AND v_number BETWEEN 1 AND 365;
    WHEN 'shopLocale' THEN
      v_valid := v_text ~ '^[a-z]{2}$';
    WHEN 'sellerLegalName' THEN
      v_valid := v_type = 'null' OR char_length(v_text) <= 200;
    WHEN 'sellerAddress' THEN
      v_valid := v_type = 'null' OR char_length(v_text) <= 500;
    WHEN 'sellerTaxId' THEN
      v_valid := v_type = 'null' OR char_length(v_text) <= 50;
    WHEN 'sellerEmail' THEN
      v_valid := v_type = 'null' OR char_length(v_text) <= 254;
    WHEN 'sellerPhone' THEN
      v_valid := v_type = 'null' OR char_length(v_text) <= 30;
    ELSE
      v_valid := false;
  END CASE;

  -- a value of another type leaves the test of its key unknown (null), which a CHECK would let
  -- through: unknown is a refusal
  RETURN coalesce(v_valid, false);
END;
$$;

-- Sets what the database owns in a new row of the data of the shop: the time, whatever the row
-- says.
CREATE OR REPLACE FUNCTION cartlify.shop_settings_before_insert () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shop_settings_before_insert ON cartlify.shop_settings;

CREATE TRIGGER trg_shop_settings_before_insert
BEFORE INSERT ON cartlify.shop_settings FOR EACH ROW
EXECUTE FUNCTION cartlify.shop_settings_before_insert ();

-- Guard: a row is history, added once and never changed or removed. The policies of db/03
-- deny every update and delete already; this guard says it a second time for a role that would
-- skip them (a superuser is not checked, as rls does not check it either). The refusal is
-- SHOP_SETTINGS_APPEND_ONLY with the code 42501.
CREATE OR REPLACE FUNCTION cartlify.shop_settings_append_only () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SHOP_SETTINGS_APPEND_ONLY' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_shop_settings_append_only ON cartlify.shop_settings;

CREATE TRIGGER trg_shop_settings_append_only
BEFORE UPDATE OR DELETE ON cartlify.shop_settings FOR EACH ROW
EXECUTE FUNCTION cartlify.shop_settings_append_only ();

------------------------------------------------------------
-- RETURNS: THE STATEMENTS OF WITHDRAWAL AND OF RETURN
------------------------------------------------------------

-- Whether the goods of an order were never handed over to the buyer: a paid order that was not
-- sent, or a pickup that is ready and not collected (shipped, the goods still on the shelf of the
-- shop). A statement for such an order takes its goods back at once. Internal step: the returns
-- functions call it with the status they read under the lock of the order; the app has no execute
-- right (db/01).
CREATE OR REPLACE FUNCTION cartlify.order_goods_on_shelf (p_order_id integer, p_status cartlify."OrderStatus") RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
  SELECT p_status = 'paid'
    OR (
      p_status = 'shipped'
      AND EXISTS (
        SELECT 1 FROM cartlify.order_deliveries AS d WHERE d."orderId" = p_order_id AND d.method = 'pickup'
      )
    );
$$;

-- Refreshes what the statements of an order say about it. A statement is over when none of its rows
-- waits for its goods or for its money (every row has a result of the goods other than expected, and
-- its money is refunded or refused): it is closed in the name of the actor of the context, who set
-- the last result (empty for the system). The state of the order is one value for the whole order:
-- none, open or open_partial while a statement is open (partial when part of the money went back),
-- then full when every unit of every item went back with its money and the delivery, partial when some did,
-- declined when none did. A paid order whose every unit is back (on the shelf, written off or lost)
-- becomes cancelled, and so does a shipped one whose statements are all closed with all the money
-- and the delivery back (the buyer refused the parcel): a cancelled order is not sent. Internal
-- step: runs as the owner, the app has no execute right (db/01); the functions below call it in
-- their own transaction.
CREATE OR REPLACE FUNCTION cartlify.refresh_return_state (p_order_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_any    boolean;
  v_open   boolean;
  v_money  boolean;
  v_full   boolean;
  v_whole  boolean;
  v_order_status text;
  v_status cartlify."ReturnStatus";
BEGIN
  -- the delivery goes back only with an order that comes back whole: once a unit will not (its
  -- goods not accepted or not arrived, its money refused, its transfer disputed), a row whose money
  -- has not gone gives its share of the delivery up. Nothing changes once the delivery is on its
  -- way or back
  IF NOT EXISTS (
    SELECT 1
    FROM cartlify.return_items AS i
    JOIN cartlify.returns AS r ON r.id = i."returnId"
    WHERE r."orderId" = p_order_id AND i."deliveryShare" > 0 AND i.money IN ('pending', 'refunded')
  ) AND EXISTS (
    SELECT 1
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = p_order_id
      AND oi.quantity > COALESCE(
        (
          SELECT SUM(i.quantity)
          FROM cartlify.return_items AS i
          WHERE i."orderItemId" = oi.id
            AND i.goods IN ('expected', 'to_stock', 'written_off', 'lost')
            AND i.money <> 'refused'
            AND i."refundFailure" IS DISTINCT FROM 'disputed'
        ),
        0
      )
  ) THEN
    UPDATE cartlify.return_items AS i
    SET "deliveryShare" = 0
    FROM cartlify.returns AS r
    WHERE r.id = i."returnId"
      AND r."orderId" = p_order_id
      AND i.money = 'not_refunded'
      AND i."deliveryShare" <> 0;
  END IF;

  UPDATE cartlify.returns AS r
  SET
    "closedAt" = now() AT TIME ZONE 'UTC',
    "closedById" = cartlify.current_actor_id()
  WHERE r."orderId" = p_order_id
    AND r."closedAt" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM cartlify.return_items AS i
      WHERE i."returnId" = r.id
        AND (i.goods = 'expected' OR i.money IN ('not_refunded', 'pending'))
    );

  SELECT
    EXISTS (SELECT 1 FROM cartlify.returns AS r WHERE r."orderId" = p_order_id),
    EXISTS (SELECT 1 FROM cartlify.returns AS r WHERE r."orderId" = p_order_id AND r."closedAt" IS NULL),
    EXISTS (
      SELECT 1
      FROM cartlify.return_items AS i
      JOIN cartlify.returns AS r ON r.id = i."returnId"
      WHERE r."orderId" = p_order_id AND i.money = 'refunded'
    )
  INTO v_any, v_open, v_money;

  -- every unit of every item of the order came back with its money
  v_full := NOT EXISTS (
    SELECT 1
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = p_order_id
      AND oi.quantity > COALESCE(
        (
          SELECT SUM(i.quantity)
          FROM cartlify.return_items AS i
          WHERE i."orderItemId" = oi.id AND i.money = 'refunded'
        ),
        0
      )
  );

  -- ... and the delivery went with them, when the buyer paid for one
  IF v_full AND COALESCE(
    (SELECT d.price FROM cartlify.order_deliveries AS d WHERE d."orderId" = p_order_id), 0
  ) > 0 THEN
    v_full := EXISTS (
      SELECT 1
      FROM cartlify.return_items AS i
      JOIN cartlify.returns AS r ON r.id = i."returnId"
      WHERE r."orderId" = p_order_id AND i.money = 'refunded' AND i."deliveryShare" > 0
    );
  END IF;

  v_status := CASE
    WHEN NOT v_any THEN 'none'
    WHEN v_open AND v_money THEN 'open_partial'
    WHEN v_open THEN 'open'
    WHEN v_full THEN 'full'
    WHEN v_money THEN 'partial'
    ELSE 'declined'
  END;

  -- every unit of every item is back with the shop, whatever became of the money
  v_whole := NOT EXISTS (
    SELECT 1
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = p_order_id
      AND oi.quantity > COALESCE(
        (
          SELECT SUM(i.quantity)
          FROM cartlify.return_items AS i
          WHERE i."orderItemId" = oi.id AND i.goods IN ('to_stock', 'written_off', 'lost')
        ),
        0
      )
  );

  SELECT o.status::text INTO v_order_status FROM cartlify.orders AS o WHERE o.id = p_order_id;

  IF (cartlify.order_goods_on_shelf (p_order_id, v_order_status::cartlify."OrderStatus") AND v_whole)
     OR (v_order_status = 'shipped' AND v_status = 'full') THEN
    UPDATE cartlify.orders AS o
    SET status = 'cancelled', "cancelledAt" = now() AT TIME ZONE 'UTC'
    WHERE o.id = p_order_id;
  END IF;

  UPDATE cartlify.orders AS o
  SET "returnStatus" = v_status
  WHERE o.id = p_order_id
    AND o."returnStatus" IS DISTINCT FROM v_status;
END;
$$;

-- Locks what every function that changes a statement of an order locks, in one order for all of them:
-- the order, then every statement of the order in the order of their ids; the rows follow, in the
-- function. Two of them that meet on an order wait for one another's order, never for a statement
-- each holds (the closing of the statements of the order, refresh_return_state, touches them all).
-- Returns the id of the order (RETURN_NOT_FOUND for a statement that is not there). Internal step:
-- runs as the owner, the app has no execute right (db/01).
CREATE OR REPLACE FUNCTION cartlify.lock_return_order (p_return_id integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_order_id integer;
BEGIN
  SELECT r."orderId" INTO v_order_id FROM cartlify.returns AS r WHERE r.id = p_return_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RETURN_NOT_FOUND';
  END IF;

  PERFORM 1 FROM cartlify.orders AS o WHERE o.id = v_order_id FOR UPDATE;

  PERFORM 1 FROM cartlify.returns AS r WHERE r."orderId" = v_order_id ORDER BY r.id FOR UPDATE;

  RETURN v_order_id;
END;
$$;

-- Makes a statement of withdrawal or of return for the items of a paid, shipped or delivered order
-- and returns its id. The one place a statement is made, for every source: an admin (any basis, any
-- reason of an admin), the buyer from the account (withdrawal, an order of their own), the system
-- for the public form (withdrawal, the code in the link vouched for the order, or a form without
-- one that an admin checks by hand). RETURN_FORBIDDEN for any other actor; a buyer that does not own
-- the order finds none (RETURN_ORDER_NOT_FOUND). p_items is a list of { orderItemId, quantity }: each
-- item of the order once, units not above what the order bought less what other statements hold (a
-- row whose money was refused gives its units back); a statement of withdrawal takes no item whose
-- product has no right of withdrawal (RETURN_ITEM_NOT_RETURNABLE) and, for a delivered order, only
-- until the end of the period of its contract (withdrawal_ends_at with the grace and the time zone
-- of the shop, which the server gives; RETURN_PERIOD_OVER). The moment of the statement is now; an
-- admin may name a moment of the past (a parcel refused at the door), never of the future and never
-- before the order was paid (RETURN_STATED_AT_INVALID). The name
-- and the email are what the answers go to (RETURN_CONTACT_REQUIRED); the address and the browser
-- come from the context of the request. An extension names a statement of the same order. The reason
-- shop_cancel (a paid order, basis other) takes the goods back to the stock at once and cancels the
-- order when all of it is back; the reason refused (a shipped order, basis withdrawal) takes whatever is left of the
-- order (RETURN_REASON_INVALID for the other basis, RETURN_ORDER_NOT_RETURNABLE for the other status),
-- whatever the right of withdrawal of its items, with the moment of the admin (RETURN_STATED_AT_INVALID
-- without it or before the send). A statement of the buyer for a paid order that was not sent brings
-- the goods back at once too, and cancels the order when it is all of it. A pickup that is ready and
-- not collected (shipped, its goods still on the shelf of the shop) is a paid order that was not
-- sent for all of this: the shop cancels it, and a statement of the buyer brings its goods back.
-- Each statement gets the next number of its order (the code the buyer and the admins see). A
-- statement from the account or with the code takes the units an open form without the code holds
-- (take_back_manual_units): the form gives them up as not arrived, refused, stated_again.
CREATE OR REPLACE FUNCTION cartlify.create_return (
  p_order_id integer,
  p_items jsonb,
  p_source cartlify."ReturnSource",
  p_basis cartlify."ReturnBasis",
  p_reason cartlify."ReturnReason",
  p_description text,
  p_contact_name text,
  p_contact_email text,
  p_stated_at timestamp without time zone,
  p_extends_id integer,
  p_grace_days integer,
  p_time_zone text
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor     integer := cartlify.current_actor_id();
  -- to the millisecond the columns keep, so that the moment of a statement made in the same
  -- millisecond as the payment is not before it
  v_now       timestamp := (now() AT TIME ZONE 'UTC')::timestamp(3);
  v_stated    timestamp;
  v_paid_at   timestamp;
  v_name      text := btrim(p_contact_name);
  v_email     text := btrim(p_contact_email);
  v_status    cartlify."OrderStatus";
  v_confirmed boolean;
  v_owner     integer;
  v_delivered timestamp;
  v_days      integer;
  v_return_id integer;
  v_row       jsonb;
  v_item      record;
  v_taken     integer;
  v_on_shelf  boolean;
  v_number    integer;
BEGIN
  IF p_source = 'admin' THEN
    IF NOT cartlify.is_admin () OR v_actor IS NULL THEN
      RAISE EXCEPTION 'RETURN_FORBIDDEN';
    END IF;
  ELSIF p_source = 'account' THEN
    IF cartlify.current_actor_role () IS DISTINCT FROM 'USER' OR v_actor IS NULL OR p_basis <> 'withdrawal' THEN
      RAISE EXCEPTION 'RETURN_FORBIDDEN';
    END IF;
  ELSIF NOT cartlify.is_system () OR p_basis <> 'withdrawal' THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  IF p_stated_at IS NOT NULL AND p_source <> 'admin' THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  -- a buyer finds the order of another no more than a stranger finds none: the lock is taken only
  -- on an order they own
  IF p_source = 'account' AND NOT EXISTS (
    SELECT 1 FROM cartlify.orders AS o WHERE o.id = p_order_id AND o."userId" = v_actor
  ) THEN
    RAISE EXCEPTION 'RETURN_ORDER_NOT_FOUND';
  END IF;

  SELECT o.status, o.confirmed, o."userId", o."deliveredAt", o."withdrawalDays", o."paidAt"
  INTO v_status, v_confirmed, v_owner, v_delivered, v_days, v_paid_at
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RETURN_ORDER_NOT_FOUND';
  END IF;

  IF NOT v_confirmed OR v_status NOT IN ('paid', 'shipped', 'delivered') THEN
    RAISE EXCEPTION 'RETURN_ORDER_NOT_RETURNABLE';
  END IF;

  -- the goods were never handed over: a paid order not sent, or a pickup ready and not collected
  v_on_shelf := cartlify.order_goods_on_shelf (p_order_id, v_status);

  -- anybody who knows the order and its recipient can send the form without the code: one such
  -- statement waits for the check of an admin at a time per order (under the lock of the order);
  -- once an admin accepted it, another may come for the units left
  IF p_source = 'form_manual' AND EXISTS (
    SELECT 1
    FROM cartlify.returns AS r
    WHERE r."orderId" = p_order_id
      AND r.source = 'form_manual'
      AND r."closedAt" IS NULL
      AND r."acceptedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'RETURN_MANUAL_UNDER_REVIEW';
  END IF;

  IF v_name IS NULL OR v_name = '' OR v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'RETURN_CONTACT_REQUIRED';
  END IF;

  v_stated := COALESCE(p_stated_at, v_now);

  -- never of the future, and never before the order was paid: a withdrawal cannot come before the
  -- purchase, and a moment long gone would bring a period that is over back
  IF v_stated > v_now OR v_stated < v_paid_at THEN
    RAISE EXCEPTION 'RETURN_STATED_AT_INVALID';
  END IF;

  -- a parcel refused is told with the moment the carrier gives, which is the admin's to give (the
  -- period and the reports count from it) and never before the parcel was sent
  IF p_reason = 'refused' THEN
    IF p_stated_at IS NULL OR v_stated < COALESCE(
      (
        SELECT MAX(sh."shippedAt")
        FROM cartlify.order_shipments AS sh
        WHERE sh."orderId" = p_order_id AND sh."rolledBackAt" IS NULL
      ),
      v_paid_at
    ) THEN
      RAISE EXCEPTION 'RETURN_STATED_AT_INVALID';
    END IF;
  END IF;

  -- the reasons that cancel an order. shop_cancel: the shop cancels a paid order that was not sent
  -- (outside the withdrawal); its goods are on the shelf, so they come back to the stock at once
  -- and, when it is the whole order, the order is cancelled. refused: the buyer refused a parcel
  -- that was sent (a withdrawal); it takes whatever is left of the order, a part named is widened
  IF p_reason = 'shop_cancel' THEN
    IF p_basis <> 'other' THEN
      RAISE EXCEPTION 'RETURN_REASON_INVALID';
    END IF;
    IF NOT v_on_shelf THEN
      RAISE EXCEPTION 'RETURN_ORDER_NOT_RETURNABLE';
    END IF;
  ELSIF p_reason = 'refused' THEN
    IF p_basis <> 'withdrawal' THEN
      RAISE EXCEPTION 'RETURN_REASON_INVALID';
    END IF;
    IF v_status <> 'shipped' OR v_on_shelf THEN
      RAISE EXCEPTION 'RETURN_ORDER_NOT_RETURNABLE';
    END IF;

    SELECT COALESCE(
      jsonb_agg(jsonb_build_object('orderItemId', oi.id, 'quantity', oi.quantity - t.taken) ORDER BY oi.id),
      '[]'::jsonb
    )
    INTO p_items
    FROM cartlify.order_items AS oi
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(i.quantity), 0) AS taken
      FROM cartlify.return_items AS i
      WHERE i."orderItemId" = oi.id AND i.money <> 'refused'
    ) AS t
    WHERE oi."orderId" = p_order_id AND oi.quantity > t.taken;
  END IF;

  -- the list: each item of the order once, with whole units above 0
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'RETURN_ITEMS_REQUIRED';
  END IF;

  FOR v_row IN SELECT e.value FROM jsonb_array_elements(p_items) AS e LOOP
    IF jsonb_typeof(v_row) <> 'object'
       OR jsonb_typeof(v_row -> 'orderItemId') IS DISTINCT FROM 'number'
       OR (v_row ->> 'orderItemId') !~ '^[1-9][0-9]{0,9}$'
       OR (v_row ->> 'orderItemId')::bigint > 2147483647 THEN
      RAISE EXCEPTION 'RETURN_ITEMS_INVALID';
    END IF;

    IF jsonb_typeof(v_row -> 'quantity') IS DISTINCT FROM 'number'
       OR (v_row ->> 'quantity') !~ '^[1-9][0-9]{0,8}$' THEN
      RAISE EXCEPTION 'RETURN_QUANTITY_INVALID';
    END IF;
  END LOOP;

  IF (SELECT COUNT(DISTINCT (e.value ->> 'orderItemId')) FROM jsonb_array_elements(p_items) AS e)
     <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'RETURN_ITEMS_REPEATED';
  END IF;

  -- each item is one of the order, and its units are there to take
  FOR v_item IN
    SELECT (e.value ->> 'orderItemId')::integer AS id, (e.value ->> 'quantity')::integer AS quantity
    FROM jsonb_array_elements(p_items) AS e
    ORDER BY 1
  LOOP
    DECLARE
      v_oi record;
    BEGIN
      SELECT oi.quantity, oi.withdrawal
      INTO v_oi
      FROM cartlify.order_items AS oi
      WHERE oi.id = v_item.id AND oi."orderId" = p_order_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'RETURN_ITEM_NOT_FOUND';
      END IF;

      SELECT COALESCE(SUM(i.quantity), 0)
      INTO v_taken
      FROM cartlify.return_items AS i
      WHERE i."orderItemId" = v_item.id AND i.money <> 'refused';

      -- a form without the code holds units until an admin checks it: the buyer who states them
      -- from the account or with the code takes them, the form gives them up (stated_again)
      IF v_item.quantity > v_oi.quantity - v_taken AND p_source IN ('account', 'form_code') THEN
        PERFORM cartlify.take_back_manual_units (
          p_order_id, v_item.id, v_item.quantity - (v_oi.quantity - v_taken), COALESCE(v_actor, v_owner)
        );

        SELECT COALESCE(SUM(i.quantity), 0)
        INTO v_taken
        FROM cartlify.return_items AS i
        WHERE i."orderItemId" = v_item.id AND i.money <> 'refused';
      END IF;

      IF v_item.quantity > v_oi.quantity - v_taken THEN
        RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDED';
      END IF;

      -- a parcel refused is recorded whatever is in it: the money is a decision of the admin
      IF p_basis = 'withdrawal' AND p_reason IS DISTINCT FROM 'refused'
         AND v_oi.withdrawal IN ('perishable', 'personalised', 'periodical') THEN
        RAISE EXCEPTION 'RETURN_ITEM_NOT_RETURNABLE';
      END IF;
    END;
  END LOOP;

  -- the period of a delivered order, as of the moment of the statement; it starts with the
  -- delivery, so a paid or shipped order has none; 14 days is the least the law gives
  -- a grace or a zone the server did not give leaves no end to compare with: the period is over
  IF p_basis = 'withdrawal' AND v_status = 'delivered' AND v_delivered IS NOT NULL
     AND NOT COALESCE(
       v_stated <= cartlify.withdrawal_ends_at (v_delivered, COALESCE(v_days, 14), p_grace_days, p_time_zone),
       false
     ) THEN
    RAISE EXCEPTION 'RETURN_PERIOD_OVER';
  END IF;

  IF p_extends_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cartlify.returns AS r WHERE r.id = p_extends_id AND r."orderId" = p_order_id
  ) THEN
    RAISE EXCEPTION 'RETURN_EXTENDS_INVALID';
  END IF;

  -- the number of the statement in its order, under the lock of the order: 1, 2, 3...
  SELECT COALESCE(MAX(r.number), 0) + 1 INTO v_number FROM cartlify.returns AS r WHERE r."orderId" = p_order_id;

  INSERT INTO cartlify.returns (
    "orderId", number, "extendsId", "statedAt", source, "createdById", basis, reason, description,
    "contactName", "contactEmail", ip, "userAgent", "createdAt", "updatedAt"
  )
  VALUES (
    p_order_id,
    v_number,
    p_extends_id,
    v_stated,
    p_source,
    CASE WHEN p_source IN ('admin', 'account') THEN v_actor END,
    p_basis,
    p_reason,
    NULLIF(btrim(p_description), ''),
    v_name,
    v_email,
    NULLIF(current_setting('cartlify.request_ip', true), ''),
    NULLIF(current_setting('cartlify.request_user_agent', true), ''),
    v_now,
    v_now
  )
  RETURNING id INTO v_return_id;

  INSERT INTO cartlify.return_items ("returnId", "orderItemId", quantity, amount, "createdAt", "updatedAt")
  SELECT v_return_id, oi.id, (e.value ->> 'quantity')::integer,
         oi."unitPrice" * (e.value ->> 'quantity')::integer, v_now, v_now
  FROM jsonb_array_elements(p_items) AS e
  JOIN cartlify.order_items AS oi ON oi.id = (e.value ->> 'orderItemId')::integer
  ORDER BY oi.id;

  -- a cancel by the shop, or a withdrawal of the buyer (from the account, or from the form with the
  -- code of the order) from a paid order that was not sent or a pickup not collected: the goods are
  -- on the shelf, they come back at once. A form has no actor, so the buyer of the order stands for
  -- the author of the results
  IF p_reason = 'shop_cancel' OR (p_source IN ('account', 'form_code') AND v_on_shelf) THEN
    PERFORM cartlify.apply_return_results (
      v_return_id,
      (
        SELECT jsonb_agg(
          jsonb_build_object('itemId', i.id, 'quantity', i.quantity, 'goods', 'to_stock') ORDER BY i.id
        )
        FROM cartlify.return_items AS i
        WHERE i."returnId" = v_return_id
      ),
      COALESCE(v_actor, v_owner)
    );
  END IF;

  PERFORM cartlify.refresh_return_state (p_order_id);

  RETURN v_return_id;
END;
$$;

-- Takes units of an item from the open statements of the form without the code of an order, for a
-- statement of the buyer from the account or with the code: the oldest rows first, each unit as not
-- arrived with its money refused and the code stated_again (a row that gives up a part of its units
-- is split, apply_return_results). A form whose every row has its result is closed. Internal step:
-- create_return calls it under the lock of the order; the app has no execute right (db/01).
CREATE OR REPLACE FUNCTION cartlify.take_back_manual_units (
  p_order_id integer,
  p_order_item_id integer,
  p_units integer,
  p_actor integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_row  record;
  v_left integer := p_units;
  v_take integer;
BEGIN
  FOR v_row IN
    SELECT i.id, i."returnId", i.quantity
    FROM cartlify.return_items AS i
    JOIN cartlify.returns AS r ON r.id = i."returnId"
    WHERE r."orderId" = p_order_id
      AND r.source = 'form_manual'
      AND r."closedAt" IS NULL
      AND r."acceptedAt" IS NULL
      AND i."orderItemId" = p_order_item_id
      AND i.goods = 'expected'
      AND i.money = 'not_refunded'
    ORDER BY i.id
  LOOP
    EXIT WHEN v_left <= 0;

    v_take := LEAST(v_left, v_row.quantity);

    PERFORM cartlify.apply_return_results (
      v_row."returnId",
      jsonb_build_array(
        jsonb_build_object('itemId', v_row.id, 'quantity', v_take, 'goods', 'not_arrived')
      ),
      p_actor
    );

    -- the units just given up carry the reason
    UPDATE cartlify.return_items AS i
    SET "refusedCode" = 'stated_again'
    WHERE i."returnId" = v_row."returnId"
      AND i."orderItemId" = p_order_item_id
      AND i.goods = 'not_arrived'
      AND i.money = 'refused'
      AND i."refusedCode" IS NULL
      AND i."goodsSetAt" = (now() AT TIME ZONE 'UTC')::timestamp(3);

    v_left := v_left - v_take;
  END LOOP;
END;
$$;

-- Brings units of a returned item back through the batches they were sold from, in the order of the
-- sale (the allocations of the order for the variant, by id), and writes the lines of the stock log
-- with the row of the statement. to_stock: the units go back into their batches and into the stock
-- (stock.return). written_off and lost: they come back and go out at once, the same batches and the
-- stock as they were, a line for each (stock.return, stock.return_write_off, with the goods as the
-- reason): the cost of the loss is the cost of the batches. RETURN_ALLOCATIONS_MISSING when the
-- order has not taken so many units from batches (an order paid before the batches). Internal step:
-- runs as the owner, the app has no execute right (db/01).
CREATE OR REPLACE FUNCTION cartlify.return_units_to_batches (
  p_order_id integer,
  p_variant_id integer,
  p_quantity integer,
  p_return_item_id integer,
  p_goods cartlify."ReturnGoods"
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  a         record;
  v_left    integer := p_quantity;
  v_take    integer;
  v_cost    numeric;
  v_batches jsonb := '[]'::jsonb;
  v_stock   integer;
BEGIN
  SELECT v.stock
  INTO v_stock
  FROM cartlify.product_variants AS v
  WHERE v.id = p_variant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VARIANT_NOT_FOUND';
  END IF;

  FOR a IN
    SELECT al.id, al."batchId", al.quantity, al.returned
    FROM cartlify.order_batch_allocations AS al
    WHERE al."orderId" = p_order_id AND al."variantId" = p_variant_id
    ORDER BY al.id
    FOR UPDATE
  LOOP
    EXIT WHEN v_left = 0;
    v_take := LEAST(a.quantity - a.returned, v_left);
    CONTINUE WHEN v_take <= 0;

    UPDATE cartlify.order_batch_allocations AS al
    SET returned = al.returned + v_take
    WHERE al.id = a.id;

    -- a unit that goes out at once leaves the batch as it was
    IF p_goods = 'to_stock' THEN
      UPDATE cartlify.product_batches AS b
      SET remaining = b.remaining + v_take
      WHERE b.id = a."batchId";
    END IF;

    SELECT b."unitCost" INTO v_cost FROM cartlify.product_batches AS b WHERE b.id = a."batchId";

    v_batches := v_batches || jsonb_build_object(
      'batchId', a."batchId",
      'quantity', v_take,
      'unitCost', trim_scale(v_cost)::text
    );
    v_left := v_left - v_take;
  END LOOP;

  IF v_left > 0 THEN
    RAISE EXCEPTION 'RETURN_ALLOCATIONS_MISSING';
  END IF;

  IF p_goods = 'to_stock' THEN
    UPDATE cartlify.product_variants AS v
    SET "stock" = v."stock" + p_quantity
    WHERE v.id = p_variant_id
    RETURNING v."stock" INTO v_stock;

    PERFORM cartlify.log_stock_change (
      p_variant_id, 'stock.return', p_quantity, v_stock,
      jsonb_build_array(jsonb_build_object('field', 'batches', 'old', NULL, 'new', v_batches)),
      NULL, NULL, p_order_id, p_return_item_id
    );
  ELSE
    PERFORM cartlify.log_stock_change (
      p_variant_id, 'stock.return', p_quantity, v_stock + p_quantity,
      jsonb_build_array(jsonb_build_object('field', 'batches', 'old', NULL, 'new', v_batches)),
      NULL, NULL, p_order_id, p_return_item_id
    );
    PERFORM cartlify.log_stock_change (
      p_variant_id, 'stock.return_write_off', -p_quantity, v_stock,
      jsonb_build_array(
        jsonb_build_object('field', 'batches', 'old', NULL, 'new', v_batches),
        jsonb_build_object('field', 'reason', 'old', NULL, 'new', p_goods::text)
      ),
      NULL, NULL, p_order_id, p_return_item_id
    );
  END IF;
END;
$$;

-- Sets what became of the goods of the rows of a statement, in the name of the actor given; the
-- callers check who may (receive_return_items for an admin, create_return for the cancels that bring
-- the goods back at once). Internal step: runs as the owner, the app has no execute right (db/01).
-- All the results or none, on an order that is not cancelled (RETURN_ORDER_NOT_RETURNABLE: a cancel
-- puts the units back itself). p_results is a list of { itemId, quantity, goods, notAcceptedReason }:
-- the units of a row that waits for its goods (RETURN_ITEM_NOT_EXPECTED) get one of to_stock,
-- written_off, lost (the proof of the buyer confirmed first, RETURN_PROOF_REQUIRED), not_accepted
-- (with the reason, RETURN_NOT_ACCEPTED_REASON_REQUIRED) or not_arrived. A result for fewer units
-- than the row holds splits it: the units with the result are a row of their own, the rest waits
-- on, so one unit may come late or be refused alone; the money of each row is the price of its
-- units, and units whose money was settled ahead of the goods keep that state in both rows. The
-- units that come back move the stock (return_units_to_batches); the units that are not accepted
-- or never came have their money refused with the goods, which only a row with no money settled
-- takes (RETURN_ITEM_MONEY_SETTLED); goods paid ahead that never came are not arrived with their
-- money back. The results are shaped first, then worked in the order of the
-- variants of the rows, so two admins that take in the same variants in another order do not
-- lock them crosswise. The statement is closed when every row has its result (refresh_return_state).
CREATE OR REPLACE FUNCTION cartlify.apply_return_results (p_return_id integer, p_results jsonb, p_actor integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor    integer := p_actor;
  v_now      timestamp := now() AT TIME ZONE 'UTC';
  v_order_id integer;
  v_status   cartlify."OrderStatus";
  v_proof    timestamp;
  v_result   jsonb;
  v_row      record;
  v_goods    cartlify."ReturnGoods";
  v_reason   cartlify."ReturnNotAcceptedReason";
  v_quantity integer;
  v_target   integer;
  v_part     numeric;
  v_refused  boolean;
BEGIN
  v_order_id := cartlify.lock_return_order (p_return_id);

  SELECT r."proofConfirmedAt" INTO v_proof FROM cartlify.returns AS r WHERE r.id = p_return_id;

  SELECT o.status INTO v_status FROM cartlify.orders AS o WHERE o.id = v_order_id;

  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'RETURN_ORDER_NOT_RETURNABLE';
  END IF;

  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array' OR jsonb_array_length(p_results) = 0 THEN
    RAISE EXCEPTION 'RETURN_ITEMS_REQUIRED';
  END IF;

  -- the shape of every result, before anything is read of a row
  FOR v_result IN SELECT e.value FROM jsonb_array_elements(p_results) AS e LOOP
    IF jsonb_typeof(v_result) <> 'object'
       OR jsonb_typeof(v_result -> 'itemId') IS DISTINCT FROM 'number'
       OR (v_result ->> 'itemId') !~ '^[1-9][0-9]{0,9}$'
       OR (v_result ->> 'itemId')::bigint > 2147483647 THEN
      RAISE EXCEPTION 'RETURN_ITEMS_INVALID';
    END IF;

    IF jsonb_typeof(v_result -> 'quantity') IS DISTINCT FROM 'number'
       OR (v_result ->> 'quantity') !~ '^[1-9][0-9]{0,8}$' THEN
      RAISE EXCEPTION 'RETURN_QUANTITY_INVALID';
    END IF;

    IF (v_result ->> 'goods') IS NULL
       OR (v_result ->> 'goods') NOT IN ('to_stock', 'written_off', 'not_accepted', 'lost', 'not_arrived') THEN
      RAISE EXCEPTION 'RETURN_GOODS_INVALID';
    END IF;

    IF (v_result ->> 'goods') = 'not_accepted' THEN
      IF (v_result ->> 'notAcceptedReason') IS NULL
         OR (v_result ->> 'notAcceptedReason') NOT IN ('unsealed', 'mixed', 'used', 'damaged', 'other') THEN
        RAISE EXCEPTION 'RETURN_NOT_ACCEPTED_REASON_REQUIRED';
      END IF;
    ELSIF (v_result ->> 'notAcceptedReason') IS NOT NULL THEN
      RAISE EXCEPTION 'RETURN_GOODS_INVALID';
    END IF;
  END LOOP;

  -- the results in the order of the variants of their rows (a row that is not there last: it is
  -- refused when its turn comes), the results of one row in the order they were given
  FOR v_result IN
    SELECT e.value
    FROM jsonb_array_elements(p_results) WITH ORDINALITY AS e (value, n)
    LEFT JOIN cartlify.return_items AS i
      ON i.id = (e.value ->> 'itemId')::integer AND i."returnId" = p_return_id
    LEFT JOIN cartlify.order_items AS oi ON oi.id = i."orderItemId"
    ORDER BY oi."variantId" NULLS LAST, i.id NULLS LAST, e.n
  LOOP
    v_goods := (v_result ->> 'goods')::cartlify."ReturnGoods";
    v_reason := (v_result ->> 'notAcceptedReason')::cartlify."ReturnNotAcceptedReason";
    v_quantity := (v_result ->> 'quantity')::integer;

    SELECT i.*, oi."unitPrice" AS "unitPrice", oi."variantId" AS "variantId"
    INTO v_row
    FROM cartlify.return_items AS i
    JOIN cartlify.order_items AS oi ON oi.id = i."orderItemId"
    WHERE i.id = (v_result ->> 'itemId')::integer AND i."returnId" = p_return_id
    FOR UPDATE OF i;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'RETURN_ITEM_NOT_FOUND';
    END IF;

    IF v_row.goods <> 'expected' THEN
      RAISE EXCEPTION 'RETURN_ITEM_NOT_EXPECTED';
    END IF;

    IF v_quantity > v_row.quantity THEN
      RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDED';
    END IF;

    -- the goods that were lost on the way need the proof the buyer sent them
    IF v_goods = 'lost' AND v_proof IS NULL THEN
      RAISE EXCEPTION 'RETURN_PROOF_REQUIRED';
    END IF;

    -- money already on its way or back is not refused with the goods; goods paid ahead that never
    -- came are not arrived with their money back (the shop gets it back outside the app)
    IF v_goods IN ('not_accepted', 'not_arrived') AND v_row.money <> 'not_refunded'
       AND NOT (v_goods = 'not_arrived' AND v_row.money = 'refunded') THEN
      RAISE EXCEPTION 'RETURN_ITEM_MONEY_SETTLED';
    END IF;

    v_refused := v_goods IN ('not_accepted', 'not_arrived') AND v_row.money = 'not_refunded';

    IF v_quantity < v_row.quantity THEN
      -- the units with the result are a row of their own, the rest of the row waits on; the money of
      -- the row goes by the units and a transfer that covers the row covers both (the delivery stays
      -- with the row that waits). Units refused with their goods carry none of the money
      v_part := round(v_row.amount * v_quantity / v_row.quantity, 2);

      UPDATE cartlify.return_items AS i
      SET quantity = i.quantity - v_quantity,
          amount = i.amount - v_part
      WHERE i.id = v_row.id;

      INSERT INTO cartlify.return_items (
        "returnId", "orderItemId", quantity, goods, "notAcceptedReason", money, amount, "amountNote",
        "refundKey", "refundId", "refundedAt", "refundFailure", "refundFailureText",
        "outsideMethod", "outsideNote", "outsideById",
        "goodsSetAt", "goodsSetById", "createdAt", "updatedAt"
      )
      VALUES (
        p_return_id, v_row."orderItemId", v_quantity, v_goods, v_reason,
        CASE WHEN v_refused THEN 'refused'::cartlify."ReturnMoney" ELSE v_row.money END,
        v_part, v_row."amountNote",
        CASE WHEN v_refused THEN NULL ELSE v_row."refundKey" END,
        CASE WHEN v_refused THEN NULL ELSE v_row."refundId" END,
        CASE WHEN v_refused THEN NULL ELSE v_row."refundedAt" END,
        CASE WHEN v_refused THEN NULL ELSE v_row."refundFailure" END,
        CASE WHEN v_refused THEN NULL ELSE v_row."refundFailureText" END,
        CASE WHEN v_refused THEN NULL ELSE v_row."outsideMethod" END,
        CASE WHEN v_refused THEN NULL ELSE v_row."outsideNote" END,
        CASE WHEN v_refused THEN NULL ELSE v_row."outsideById" END,
        v_now, v_actor, v_row."createdAt", v_now
      )
      RETURNING id INTO v_target;
    ELSE
      UPDATE cartlify.return_items AS i
      SET goods = v_goods,
          "notAcceptedReason" = v_reason,
          money = CASE WHEN v_refused THEN 'refused' ELSE i.money END,
          "deliveryShare" = CASE WHEN v_refused THEN 0 ELSE i."deliveryShare" END,
          "shippingDeduction" = CASE WHEN v_refused THEN 0 ELSE i."shippingDeduction" END,
          "refundFailure" = CASE WHEN v_refused THEN NULL ELSE i."refundFailure" END,
          "refundFailureText" = CASE WHEN v_refused THEN NULL ELSE i."refundFailureText" END,
          "goodsSetAt" = v_now,
          "goodsSetById" = v_actor
      WHERE i.id = v_row.id;

      v_target := v_row.id;
    END IF;

    IF v_goods IN ('to_stock', 'written_off', 'lost') THEN
      PERFORM cartlify.return_units_to_batches (v_order_id, v_row."variantId", v_quantity, v_target, v_goods);
    END IF;
  END LOOP;

  PERFORM cartlify.refresh_return_state (v_order_id);
END;
$$;

-- Refuses a statement of the form without the code that no admin accepted yet
-- (RETURN_NOT_ACCEPTED): its goods and its money wait for the check. Internal step: runs as the
-- owner, the app has no execute right (db/01).
CREATE OR REPLACE FUNCTION cartlify.assert_return_accepted (p_return_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cartlify.returns AS r
    WHERE r.id = p_return_id AND r.source = 'form_manual' AND r."acceptedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'RETURN_NOT_ACCEPTED';
  END IF;
END;
$$;

-- An admin or root accepts a statement of the form without the code as the buyer's, once
-- (RETURN_ALREADY_ACCEPTED), while it is open (RETURN_ALREADY_CLOSED): only then its goods and its
-- money are handled, it leaves the check of the admins, a statement of the buyer no longer takes
-- its units over, and the form may take another statement without the code for the units left.
-- RETURN_NOT_MANUAL for a statement of another source, RETURN_FORBIDDEN for anyone else,
-- RETURN_NOT_FOUND for a statement that is not there.
CREATE OR REPLACE FUNCTION cartlify.accept_return (p_return_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor integer := cartlify.current_actor_id();
  v_row   record;
BEGIN
  IF NOT cartlify.is_admin () OR v_actor IS NULL THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  -- the same order of locks as the other functions of the statements
  PERFORM cartlify.lock_return_order (p_return_id);

  SELECT r.source, r."acceptedAt", r."closedAt"
  INTO v_row
  FROM cartlify.returns AS r
  WHERE r.id = p_return_id;

  IF v_row.source <> 'form_manual' THEN
    RAISE EXCEPTION 'RETURN_NOT_MANUAL';
  END IF;

  IF v_row."closedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_ALREADY_CLOSED';
  END IF;

  IF v_row."acceptedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_ALREADY_ACCEPTED';
  END IF;

  UPDATE cartlify.returns AS r
  SET "acceptedAt" = (now() AT TIME ZONE 'UTC')::timestamp(3),
      "acceptedById" = v_actor
  WHERE r.id = p_return_id;
END;
$$;

-- Sets what became of the goods of the rows of a statement; admin or root only (RETURN_FORBIDDEN),
-- a statement of the form without the code once accepted (RETURN_NOT_ACCEPTED); the work is
-- apply_return_results.
CREATE OR REPLACE FUNCTION cartlify.receive_return_items (p_return_id integer, p_results jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  IF NOT cartlify.is_admin () OR cartlify.current_actor_id() IS NULL THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  PERFORM cartlify.assert_return_accepted (p_return_id);

  PERFORM cartlify.apply_return_results (p_return_id, p_results, cartlify.current_actor_id());
END;
$$;

-- An admin or root confirms the proof the buyer sent the goods back (a carrier and a number, or a
-- letter with the photos: the admin may confirm it without a number), once (RETURN_PROOF_ALREADY_CONFIRMED).
-- The goods lost on the way and the money paid ahead of the goods need it. RETURN_FORBIDDEN for any
-- other actor, RETURN_NOT_FOUND for a statement that is not there.
CREATE OR REPLACE FUNCTION cartlify.confirm_return_proof (p_return_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor integer := cartlify.current_actor_id();
  v_proof timestamp;
BEGIN
  IF NOT cartlify.is_admin () OR v_actor IS NULL THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  SELECT r."proofConfirmedAt"
  INTO v_proof
  FROM cartlify.returns AS r
  WHERE r.id = p_return_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RETURN_NOT_FOUND';
  END IF;

  IF v_proof IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_PROOF_ALREADY_CONFIRMED';
  END IF;

  PERFORM cartlify.assert_return_accepted (p_return_id);

  UPDATE cartlify.returns AS r
  SET "proofConfirmedAt" = now() AT TIME ZONE 'UTC',
      "proofConfirmedById" = v_actor
  WHERE r.id = p_return_id;
END;
$$;

-- The buyer of a statement of their own account tells how they sent the goods back: the carrier and
-- the number of the parcel, and a link to follow it when there is one. The statement is then in the
-- state "proof given" for the admin, who checks it and confirms it (confirm_return_proof); the buyer
-- may correct what they wrote until then. Only the buyer who made the statement (a statement of
-- another is not found: RETURN_NOT_FOUND; the system writes it for a statement of an account or of a
-- form with the code, once the server checked the code of the order), only while some row waits for its goods
-- (RETURN_NOTHING_WAITING: nothing to send back for a statement whose goods are in already) and the
-- statement is open (RETURN_ALREADY_CLOSED), and not after the admin confirmed it
-- (RETURN_PROOF_ALREADY_CONFIRMED). The carrier and the number are required, the link is https
-- (RETURN_PROOF_INVALID).
CREATE OR REPLACE FUNCTION cartlify.provide_return_proof (
  p_return_id integer,
  p_carrier text,
  p_number text,
  p_url text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor     integer := cartlify.current_actor_id();
  v_carrier   text := btrim(p_carrier);
  v_number    text := btrim(p_number);
  v_url       text := NULLIF(btrim(p_url), '');
  v_creator   integer;
  v_source    cartlify."ReturnSource";
  v_confirmed timestamp;
  v_closed    timestamp;
  v_order_id  integer;
BEGIN
  IF cartlify.is_system () THEN
    -- the server checked the code of the order: a statement of an account or of a form with a code
    SELECT r.source INTO v_source FROM cartlify.returns AS r WHERE r.id = p_return_id;

    IF NOT FOUND OR v_source NOT IN ('account', 'form_code') THEN
      RAISE EXCEPTION 'RETURN_NOT_FOUND';
    END IF;
  ELSIF cartlify.current_actor_role () IS DISTINCT FROM 'USER' OR v_actor IS NULL THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  ELSE
    -- a statement that is not the buyer's own is not found, and no lock is taken on its order
    SELECT r."createdById", r.source INTO v_creator, v_source FROM cartlify.returns AS r WHERE r.id = p_return_id;

    IF NOT FOUND OR v_source <> 'account' OR v_creator IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'RETURN_NOT_FOUND';
    END IF;
  END IF;

  v_order_id := cartlify.lock_return_order (p_return_id);

  SELECT r."proofConfirmedAt", r."closedAt" INTO v_confirmed, v_closed FROM cartlify.returns AS r WHERE r.id = p_return_id;

  IF v_closed IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_ALREADY_CLOSED';
  END IF;

  IF v_confirmed IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_PROOF_ALREADY_CONFIRMED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM cartlify.return_items AS i WHERE i."returnId" = p_return_id AND i.goods = 'expected'
  ) THEN
    RAISE EXCEPTION 'RETURN_NOTHING_WAITING';
  END IF;

  IF v_carrier IS NULL OR v_carrier = '' OR char_length(v_carrier) > 100
     OR v_number IS NULL OR v_number = '' OR char_length(v_number) > 100
     OR (v_url IS NOT NULL AND (char_length(v_url) > 500 OR v_url !~ '^https://[^[:space:]]+$')) THEN
    RAISE EXCEPTION 'RETURN_PROOF_INVALID';
  END IF;

  UPDATE cartlify.returns AS r
  SET "proofProvidedAt" = now() AT TIME ZONE 'UTC',
      "proofCarrier" = v_carrier,
      "proofTrackingNumber" = v_number,
      "proofTrackingUrl" = v_url
  WHERE r.id = p_return_id;
END;
$$;

-- Stamps updatedAt of a statement and of a row on every update (utc without a zone, as prisma writes
-- it).
CREATE OR REPLACE FUNCTION cartlify.returns_before_update () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := now() AT TIME ZONE 'UTC';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_returns_before_update ON cartlify.returns;

CREATE TRIGGER trg_returns_before_update
BEFORE UPDATE ON cartlify.returns FOR EACH ROW
EXECUTE FUNCTION cartlify.returns_before_update ();

DROP TRIGGER IF EXISTS trg_return_items_before_update ON cartlify.return_items;

CREATE TRIGGER trg_return_items_before_update
BEFORE UPDATE ON cartlify.return_items FOR EACH ROW
EXECUTE FUNCTION cartlify.returns_before_update ();

-- Guard of the statements: only the system functions that run as the owner change the proof, the
-- closing, the acceptance of a statement of the form (once), the money of the way back root gave
-- back (once) and, as the retention cleanups do, the
-- personal columns, which then only take the made-up values (the name, the email, an empty
-- description, address, browser and note of the money of the way back); nothing else of a
-- statement changes (the statement is what the buyer said, when and from where).
CREATE OR REPLACE FUNCTION cartlify.returns_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
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
     AND v_changed <@ ARRAY[
       'proofProvidedAt', 'proofCarrier', 'proofTrackingNumber', 'proofTrackingUrl',
       'proofConfirmedAt', 'proofConfirmedById', 'closedAt', 'closedById', 'closeCode', 'closeNote',
       'contactName', 'contactEmail', 'description', 'ip', 'userAgent', 'shippingReimbursed',
       'shippingReimbursedAt', 'shippingReimbursedMethod', 'shippingReimbursedNote',
       'shippingReimbursedById', 'acceptedAt', 'acceptedById', 'updatedAt'
     ]
     -- an admin accepts a statement of the form without the code once
     AND (NOT (v_changed && ARRAY['acceptedAt', 'acceptedById']) OR OLD."acceptedAt" IS NULL)
     -- the money of the way back is given back once; its note is then only made up (the retention
     -- terms)
     AND (
       NOT (v_changed && ARRAY[
         'shippingReimbursed', 'shippingReimbursedAt', 'shippingReimbursedMethod',
         'shippingReimbursedById'
       ])
       OR OLD."shippingReimbursed" IS NULL
     )
     AND (
       NOT ('shippingReimbursedNote' = ANY (v_changed))
       OR OLD."shippingReimbursed" IS NULL
       OR NEW."shippingReimbursedNote" = 'Paid back outside the app'
     )
     AND (NOT ('contactName' = ANY (v_changed)) OR NEW."contactName" = 'Recipient Customer')
     AND (
       NOT ('contactEmail' = ANY (v_changed))
       OR NEW."contactEmail" = 'return+' || NEW.id || '@example.com'
     )
     AND (NOT ('description' = ANY (v_changed)) OR NEW.description IS NULL)
     AND (NOT ('ip' = ANY (v_changed)) OR NEW.ip IS NULL)
     AND (NOT ('userAgent' = ANY (v_changed)) OR NEW."userAgent" IS NULL) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'RETURN_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_returns_update_columns ON cartlify.returns;

CREATE TRIGGER trg_returns_update_columns
BEFORE UPDATE ON cartlify.returns FOR EACH ROW
EXECUTE FUNCTION cartlify.returns_update_columns ();

-- Guard of the rows: the system functions that run as the owner set the result of the goods, the
-- money and the quantity a split leaves; the item the row names never changes.
CREATE OR REPLACE FUNCTION cartlify.return_items_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
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
     AND v_changed <@ ARRAY[
       'quantity', 'goods', 'notAcceptedReason', 'money', 'amount', 'amountNote', 'deliveryShare',
       'shippingDeduction', 'refundKey', 'refundId', 'refundedAt', 'refundFailure', 'refundFailureText', 'outsideMethod',
       'outsideNote', 'outsideById', 'refusedCode', 'goodsSetAt', 'goodsSetById', 'updatedAt'
     ] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'RETURN_ITEM_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_return_items_update_columns ON cartlify.return_items;

CREATE TRIGGER trg_return_items_update_columns
BEFORE UPDATE ON cartlify.return_items FOR EACH ROW
EXECUTE FUNCTION cartlify.return_items_update_columns ();

-- Guard of the allocations of an order: only the units that came back change, and only the system
-- functions that run as the owner change them.
CREATE OR REPLACE FUNCTION cartlify.order_batch_allocations_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner' AND v_changed <@ ARRAY['returned'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ORDER_BATCH_ALLOCATION_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_order_batch_allocations_update_columns ON cartlify.order_batch_allocations;

CREATE TRIGGER trg_order_batch_allocations_update_columns
BEFORE UPDATE ON cartlify.order_batch_allocations FOR EACH ROW
EXECUTE FUNCTION cartlify.order_batch_allocations_update_columns ();


------------------------------------------------------------
-- RETURNS: THE MONEY OF THE STATEMENTS
------------------------------------------------------------

-- Starts a transfer of money back for rows of a statement (the first of the three steps: this
-- function in one transaction, the provider asked outside any transaction, finish_return_refund in
-- a second transaction). Admin or root (RETURN_FORBIDDEN). p_item_ids names the rows (all that can
-- be refunded when null): a row waits for its money (RETURN_ITEM_NOT_REFUNDABLE otherwise: its
-- goods were not accepted or did not arrive, or its money is on its way or back); a row whose goods
-- are still expected is paid ahead only when the proof of the buyer is confirmed
-- (RETURN_PROOF_REQUIRED); a row whose last transfer the buyer disputed at the bank is never sent
-- again (RETURN_REFUND_DISPUTED: the bank gives the money back, the shop would pay twice) and is
-- not taken by default. Only root lowers what a row refunds (p_reductions, a list of
-- { itemId, amount, note }: the amount is above 0 and not above the price of the units, the note
-- says why, RETURN_AMOUNT_INVALID). The delivery goes back, all of it, with the row of the highest id of the
-- call that makes the order whole (every unit of every item is in a row whose goods are expected,
-- on the shelf, written off or lost, in this call, on its way, back, or owed after a failed
-- transfer that was not disputed); a unit not accepted or not arrived keeps it, and
-- refresh_return_state takes it off a row that has not sent its money once the order cannot come
-- back whole. The transfer is
-- the sum of its rows and never more than the order was paid, counting what is on its way or back
-- (RETURN_REFUND_EXCEEDS_PAID). The rows become pending under one new key; the answer says what to
-- ask the provider for: { key, returnId, orderId, provider, paymentId, amount, itemIds }, lowered:
-- the rows root lowered in this call, { itemId, from, to, note }, for the journal of the admins, and
-- deduction. p_shipping_deduction takes the cost of the way back off the transfer, an admin or root:
-- only a withdrawal whose contract says the buyer pays (RETURN_DEDUCTION_NOT_ALLOWED), above 0 and
-- leaving the transfer above 0 (RETURN_DEDUCTION_INVALID), at most what the parcels of the
-- statement cost the shop less what other transfers took (RETURN_DEDUCTION_EXCEEDS_COST).
CREATE OR REPLACE FUNCTION cartlify.begin_return_refund (
  p_return_id integer,
  p_item_ids integer[],
  p_reductions jsonb,
  p_shipping_deduction numeric DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_order_id   integer;
  v_proof      timestamp;
  v_provider   cartlify."PaymentProvider";
  v_payment_id text;
  v_total      numeric;
  v_paid_at    timestamp;
  v_delivery   numeric;
  v_key        uuid := gen_random_uuid();
  v_ids        integer[];
  v_row        record;
  v_red        jsonb;
  v_seen       integer[] := ARRAY[]::integer[];
  v_count      integer := 0;
  v_price      numeric;
  v_amount     numeric;
  v_sum        numeric;
  v_taken      numeric;
  v_old        numeric;
  v_lowered    jsonb := '[]'::jsonb;
  v_basis      cartlify."ReturnBasis";
  v_payer      cartlify."ReturnShippingPayer";
  v_left       numeric;
BEGIN
  IF NOT cartlify.is_admin () THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  v_order_id := cartlify.lock_return_order (p_return_id);

  PERFORM cartlify.assert_return_accepted (p_return_id);

  SELECT r."proofConfirmedAt" INTO v_proof FROM cartlify.returns AS r WHERE r.id = p_return_id;

  SELECT o."paymentProvider", o."paymentId", o.total, o."paidAt", COALESCE(d.price, 0)
  INTO v_provider, v_payment_id, v_total, v_paid_at, v_delivery
  FROM cartlify.orders AS o
  LEFT JOIN cartlify.order_deliveries AS d ON d."orderId" = o.id
  WHERE o.id = v_order_id;

  IF v_payment_id IS NULL OR v_paid_at IS NULL THEN
    RAISE EXCEPTION 'RETURN_ORDER_NOT_RETURNABLE';
  END IF;

  IF p_item_ids IS NULL THEN
    SELECT COALESCE(array_agg(i.id ORDER BY i.id), ARRAY[]::integer[])
    INTO v_ids
    FROM cartlify.return_items AS i
    WHERE i."returnId" = p_return_id
      AND i.money = 'not_refunded'
      AND i."refundFailure" IS DISTINCT FROM 'disputed'
      AND i.goods IN ('expected', 'to_stock', 'written_off', 'lost')
      AND (i.goods <> 'expected' OR v_proof IS NOT NULL);
  ELSE
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::integer[])
    INTO v_ids
    FROM unnest(p_item_ids) AS x;
  END IF;

  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'RETURN_ITEMS_REQUIRED';
  END IF;

  FOR v_row IN
    SELECT i.id, i.goods, i.money, i."refundFailure"
    FROM cartlify.return_items AS i
    WHERE i.id = ANY (v_ids) AND i."returnId" = p_return_id
    ORDER BY i.id
    FOR UPDATE OF i
  LOOP
    v_count := v_count + 1;

    IF v_row.money <> 'not_refunded' OR v_row.goods NOT IN ('expected', 'to_stock', 'written_off', 'lost') THEN
      RAISE EXCEPTION 'RETURN_ITEM_NOT_REFUNDABLE';
    END IF;

    IF v_row."refundFailure" = 'disputed' THEN
      RAISE EXCEPTION 'RETURN_REFUND_DISPUTED';
    END IF;

    IF v_row.goods = 'expected' AND v_proof IS NULL THEN
      RAISE EXCEPTION 'RETURN_PROOF_REQUIRED';
    END IF;
  END LOOP;

  IF v_count <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'RETURN_ITEM_NOT_FOUND';
  END IF;

  -- what root lowers: each row once, an amount not above the price of its units, with the reason
  IF p_reductions IS NOT NULL THEN
    IF jsonb_typeof(p_reductions) <> 'array' THEN
      RAISE EXCEPTION 'RETURN_AMOUNT_INVALID';
    END IF;

    IF jsonb_array_length(p_reductions) > 0 AND NOT cartlify.is_root () THEN
      RAISE EXCEPTION 'RETURN_FORBIDDEN';
    END IF;

    FOR v_red IN SELECT e.value FROM jsonb_array_elements(p_reductions) AS e LOOP
      IF jsonb_typeof(v_red) <> 'object'
         OR jsonb_typeof(v_red -> 'itemId') IS DISTINCT FROM 'number'
         OR (v_red ->> 'itemId') !~ '^[1-9][0-9]{0,9}$'
         OR (v_red ->> 'itemId')::bigint > 2147483647 THEN
        RAISE EXCEPTION 'RETURN_ITEMS_INVALID';
      END IF;

      IF NOT ((v_red ->> 'itemId')::integer = ANY (v_ids)) THEN
        RAISE EXCEPTION 'RETURN_ITEM_NOT_FOUND';
      END IF;

      IF (v_red ->> 'itemId')::integer = ANY (v_seen) THEN
        RAISE EXCEPTION 'RETURN_ITEMS_REPEATED';
      END IF;

      v_seen := v_seen || (v_red ->> 'itemId')::integer;

      IF jsonb_typeof(v_red -> 'amount') IS DISTINCT FROM 'number'
         OR (v_red ->> 'amount') !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$' THEN
        RAISE EXCEPTION 'RETURN_AMOUNT_INVALID';
      END IF;

      v_amount := (v_red ->> 'amount')::numeric;

      SELECT oi."unitPrice" * i.quantity, i.amount
      INTO v_price, v_old
      FROM cartlify.return_items AS i
      JOIN cartlify.order_items AS oi ON oi.id = i."orderItemId"
      WHERE i.id = (v_red ->> 'itemId')::integer;

      -- a row lowered to nothing could never be settled: it has no money to send and its goods
      -- are back, so it would keep the statement open
      IF v_amount <= 0 OR v_amount > v_price THEN
        RAISE EXCEPTION 'RETURN_AMOUNT_INVALID';
      END IF;

      IF v_amount < v_price AND (jsonb_typeof(v_red -> 'note') IS DISTINCT FROM 'string'
         OR btrim(v_red ->> 'note') = '' OR char_length(btrim(v_red ->> 'note')) > 500) THEN
        RAISE EXCEPTION 'RETURN_AMOUNT_NOTE_REQUIRED';
      END IF;

      UPDATE cartlify.return_items AS i
      SET amount = v_amount,
          "amountNote" = CASE WHEN v_amount < v_price THEN btrim(v_red ->> 'note') ELSE NULL END
      WHERE i.id = (v_red ->> 'itemId')::integer;

      IF v_amount <> v_old THEN
        v_lowered := v_lowered || jsonb_build_array(
          jsonb_build_object(
            'itemId', (v_red ->> 'itemId')::integer,
            'from', to_char(v_old, 'FM99999999990.00'),
            'to', to_char(v_amount, 'FM99999999990.00'),
            'note', CASE WHEN v_amount < v_price THEN btrim(v_red ->> 'note') END
          )
        );
      END IF;
    END LOOP;
  END IF;

  -- the delivery: with the last row of the call, when this call makes the order whole and no row of
  -- the order carries it already (a row that failed keeps it until it is refunded or settled)
  UPDATE cartlify.return_items AS i
  SET "deliveryShare" = 0
  WHERE i.id = ANY (v_ids) AND i."deliveryShare" <> 0;

  IF v_delivery > 0
     AND NOT EXISTS (
       SELECT 1
       FROM cartlify.return_items AS i
       JOIN cartlify.returns AS r ON r.id = i."returnId"
       WHERE r."orderId" = v_order_id AND i."deliveryShare" > 0 AND NOT (i.id = ANY (v_ids))
     )
     AND NOT EXISTS (
       SELECT 1
       FROM cartlify.order_items AS oi
       WHERE oi."orderId" = v_order_id
         AND oi.quantity > COALESCE(
           (
             SELECT SUM(i.quantity)
             FROM cartlify.return_items AS i
             WHERE i."orderItemId" = oi.id
               AND i.goods IN ('expected', 'to_stock', 'written_off', 'lost')
               AND (
                 i.id = ANY (v_ids)
                 OR i.money IN ('pending', 'refunded')
                 -- a transfer that failed is still owed (tried again or sent outside the app); a
                 -- disputed one is never sent
                 OR (
                   i.money = 'not_refunded'
                   AND i."refundFailure" IS NOT NULL
                   AND i."refundFailure" <> 'disputed'
                 )
               )
           ),
           0
         )
     ) THEN
    UPDATE cartlify.return_items AS i
    SET "deliveryShare" = v_delivery
    WHERE i.id = v_ids[cardinality(v_ids)];
  END IF;

  -- the way back the buyer owes: a withdrawal whose contract says the buyer pays (an order without
  -- a contract told the buyer nothing, so the shop pays, art. 14(1)), with the last row of the
  -- call, at most what the parcels of the statement cost the shop less what other transfers took
  -- for them; the transfer stays above 0
  UPDATE cartlify.return_items AS i
  SET "shippingDeduction" = 0
  WHERE i.id = ANY (v_ids) AND i."shippingDeduction" <> 0;

  IF p_shipping_deduction IS NOT NULL THEN
    IF p_shipping_deduction <= 0 OR p_shipping_deduction > 99999999.99
       OR p_shipping_deduction <> round(p_shipping_deduction, 2) THEN
      RAISE EXCEPTION 'RETURN_DEDUCTION_INVALID';
    END IF;

    SELECT r.basis INTO v_basis FROM cartlify.returns AS r WHERE r.id = p_return_id;
    SELECT o."returnShippingPaidBy" INTO v_payer FROM cartlify.orders AS o WHERE o.id = v_order_id;

    IF v_basis <> 'withdrawal' OR v_payer IS DISTINCT FROM 'buyer' THEN
      RAISE EXCEPTION 'RETURN_DEDUCTION_NOT_ALLOWED';
    END IF;

    SELECT
      COALESCE((SELECT SUM(s.cost) FROM cartlify.return_shipments AS s WHERE s."returnId" = p_return_id), 0)
      - COALESCE(
        (
          SELECT SUM(i."shippingDeduction")
          FROM cartlify.return_items AS i
          WHERE i."returnId" = p_return_id AND NOT (i.id = ANY (v_ids))
        ),
        0
      )
    INTO v_left;

    IF p_shipping_deduction > v_left THEN
      RAISE EXCEPTION 'RETURN_DEDUCTION_EXCEEDS_COST';
    END IF;

    UPDATE cartlify.return_items AS i
    SET "shippingDeduction" = p_shipping_deduction
    WHERE i.id = v_ids[cardinality(v_ids)];
  END IF;

  SELECT COALESCE(SUM(i.amount + i."deliveryShare" - i."shippingDeduction"), 0)
  INTO v_sum
  FROM cartlify.return_items AS i
  WHERE i.id = ANY (v_ids);

  SELECT COALESCE(SUM(i.amount + i."deliveryShare" - i."shippingDeduction"), 0)
  INTO v_taken
  FROM cartlify.return_items AS i
  JOIN cartlify.returns AS r ON r.id = i."returnId"
  WHERE r."orderId" = v_order_id AND i.money IN ('pending', 'refunded');

  IF v_sum <= 0 THEN
    IF p_shipping_deduction IS NOT NULL THEN
      RAISE EXCEPTION 'RETURN_DEDUCTION_INVALID';
    END IF;
    RAISE EXCEPTION 'RETURN_REFUND_AMOUNT_INVALID';
  END IF;

  IF v_taken + v_sum > v_total THEN
    RAISE EXCEPTION 'RETURN_REFUND_EXCEEDS_PAID';
  END IF;

  UPDATE cartlify.return_items AS i
  SET money = 'pending',
      "refundKey" = v_key,
      "refundFailure" = NULL,
      "refundFailureText" = NULL
  WHERE i.id = ANY (v_ids);

  PERFORM cartlify.refresh_return_state (v_order_id);

  RETURN jsonb_build_object(
    'key', v_key,
    'returnId', p_return_id,
    'orderId', v_order_id,
    'provider', v_provider::text,
    'paymentId', v_payment_id,
    'amount', to_char(v_sum, 'FM99999999990.00'),
    'itemIds', to_jsonb(v_ids),
    'lowered', v_lowered,
    'deduction', to_char(COALESCE(p_shipping_deduction, 0), 'FM99999999990.00')
  );
END;
$$;

-- Settles a transfer by the key it was started with (the last of the three steps; also what the
-- payment webhook and the worker call when the provider tells a pending transfer's end). Admin,
-- root or the system (RETURN_FORBIDDEN). p_status is succeeded (the rows become refunded, with the
-- id the provider gave and the time), pending (the id is kept, the rows wait on) or failed (the
-- rows go back to not refunded with the reason in our code and the words of the provider, the key
-- is taken off so the next try has a new one). Repeating it changes nothing: only rows still
-- pending under the key are settled, so a webhook and a request that meet are both right. A refund
-- the provider took back after it succeeded (the bank of a card that is gone sends the money back,
-- refund.failed of the same refund id) puts the rows refunded by it back to not refunded the same
-- way, with no time of the money any more, and opens their statement again, so an admin sees them
-- and root sends the money another way (reversed in the answer). The answer is { changed, status,
-- returnId, orderId, itemIds, amount, deduction, reversed }; changed is false when nothing waited for
-- the key. RETURN_REFUND_STATUS_INVALID for a status that is none of the three or a failure without
-- its reason.
CREATE OR REPLACE FUNCTION cartlify.finish_return_refund (
  p_key uuid,
  p_status text,
  p_refund_id text,
  p_failure cartlify."ReturnRefundFailure",
  p_failure_text text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_return_id integer;
  v_order_id  integer;
  v_ids       integer[];
  v_amount    numeric;
  v_deduction numeric;
  v_reversed  boolean := false;
  v_now       timestamp := (now() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF NOT cartlify.is_admin () THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  IF p_key IS NULL OR p_status IS NULL OR p_status NOT IN ('succeeded', 'pending', 'failed')
     OR (p_status = 'failed' AND p_failure IS NULL) THEN
    RAISE EXCEPTION 'RETURN_REFUND_STATUS_INVALID';
  END IF;

  SELECT i."returnId" INTO v_return_id FROM cartlify.return_items AS i WHERE i."refundKey" = p_key LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('changed', false, 'status', p_status);
  END IF;

  -- the same order of locks as begin_return_refund: the order, its statements, the rows
  v_order_id := cartlify.lock_return_order (v_return_id);

  PERFORM 1
  FROM cartlify.return_items AS i
  WHERE i."refundKey" = p_key AND i.money = 'pending'
  ORDER BY i.id
  FOR UPDATE;

  SELECT array_agg(i.id ORDER BY i.id), SUM(i.amount + i."deliveryShare" - i."shippingDeduction"),
         SUM(i."shippingDeduction")
  INTO v_ids, v_amount, v_deduction
  FROM cartlify.return_items AS i
  WHERE i."refundKey" = p_key AND i.money = 'pending';

  -- nothing waits, but the provider failed a refund it had made: the rows it refunded
  IF v_ids IS NULL AND p_status = 'failed' AND p_refund_id IS NOT NULL THEN
    PERFORM 1
    FROM cartlify.return_items AS i
    WHERE i."refundKey" = p_key AND i.money = 'refunded' AND i."refundId" = p_refund_id
    ORDER BY i.id
    FOR UPDATE;

    SELECT array_agg(i.id ORDER BY i.id), SUM(i.amount + i."deliveryShare" - i."shippingDeduction"),
           SUM(i."shippingDeduction")
    INTO v_ids, v_amount, v_deduction
    FROM cartlify.return_items AS i
    WHERE i."refundKey" = p_key AND i.money = 'refunded' AND i."refundId" = p_refund_id;

    v_reversed := v_ids IS NOT NULL;
  END IF;

  IF v_ids IS NULL THEN
    RETURN jsonb_build_object(
      'changed', false, 'status', p_status, 'returnId', v_return_id, 'orderId', v_order_id
    );
  END IF;

  IF p_status = 'succeeded' THEN
    UPDATE cartlify.return_items AS i
    SET money = 'refunded',
        "refundedAt" = v_now,
        "refundId" = COALESCE(p_refund_id, i."refundId")
    WHERE i.id = ANY (v_ids);
  ELSIF p_status = 'pending' THEN
    UPDATE cartlify.return_items AS i
    SET "refundId" = COALESCE(p_refund_id, i."refundId")
    WHERE i.id = ANY (v_ids);
  ELSE
    UPDATE cartlify.return_items AS i
    SET money = 'not_refunded',
        "refundKey" = NULL,
        "refundId" = NULL,
        "refundedAt" = NULL,
        "refundFailure" = p_failure,
        "refundFailureText" = left(p_failure_text, 500)
    WHERE i.id = ANY (v_ids);
  END IF;

  -- a statement closed with the money of these rows waits for it again
  IF v_reversed THEN
    UPDATE cartlify.returns AS r
    SET "closedAt" = NULL, "closedById" = NULL
    WHERE r.id IN (SELECT i."returnId" FROM cartlify.return_items AS i WHERE i.id = ANY (v_ids))
      AND r."closedAt" IS NOT NULL;
  END IF;

  PERFORM cartlify.refresh_return_state (v_order_id);

  RETURN jsonb_build_object(
    'changed', p_status <> 'pending',
    'status', p_status,
    'returnId', v_return_id,
    'orderId', v_order_id,
    'itemIds', to_jsonb(v_ids),
    'amount', to_char(v_amount, 'FM99999999990.00'),
    'deduction', to_char(v_deduction, 'FM99999999990.00'),
    'reversed', v_reversed
  );
END;
$$;

-- Root records that the money of rows whose transfer failed went back outside the app (a bank
-- transfer, cash, another way). Root only (RETURN_FORBIDDEN). Only rows whose last transfer failed
-- (RETURN_ITEM_NOT_FAILED: not one without a try), and never one the buyer disputed at the bank
-- (RETURN_REFUND_DISPUTED: the bank settles it, the money would go twice). p_item_ids names the
-- rows (all the failed ones of the statement when null). The method, a note (RETURN_OUTSIDE_NOTE_REQUIRED)
-- and the day it really happened are required (RETURN_OUTSIDE_AT_INVALID: not before the order was
-- paid, never of the future): the day is the day of the money in the reports. The sum is the sum
-- of the rows. The answer is { returnId, orderId, itemIds, amount }.
CREATE OR REPLACE FUNCTION cartlify.mark_return_refunded_outside (
  p_return_id integer,
  p_item_ids integer[],
  p_method cartlify."ReturnOutsideMethod",
  p_note text,
  p_at timestamp without time zone
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor    integer := cartlify.current_actor_id();
  v_now      timestamp := (now() AT TIME ZONE 'UTC')::timestamp(3);
  v_order_id integer;
  v_paid_at  timestamp;
  v_note     text := btrim(p_note);
  v_ids      integer[];
  v_row      record;
  v_count    integer := 0;
  v_amount   numeric;
BEGIN
  IF NOT cartlify.is_root () OR v_actor IS NULL THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  v_order_id := cartlify.lock_return_order (p_return_id);

  SELECT o."paidAt" INTO v_paid_at FROM cartlify.orders AS o WHERE o.id = v_order_id;

  IF p_method IS NULL OR v_note IS NULL OR v_note = '' OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'RETURN_OUTSIDE_NOTE_REQUIRED';
  END IF;

  -- the bank gives the money of a dispute back, root records it with settle_return_dispute
  IF p_method = 'chargeback' THEN
    RAISE EXCEPTION 'RETURN_OUTSIDE_METHOD_INVALID';
  END IF;

  IF p_at IS NULL OR p_at > v_now OR p_at < v_paid_at THEN
    RAISE EXCEPTION 'RETURN_OUTSIDE_AT_INVALID';
  END IF;

  IF p_item_ids IS NULL THEN
    SELECT COALESCE(array_agg(i.id ORDER BY i.id), ARRAY[]::integer[])
    INTO v_ids
    FROM cartlify.return_items AS i
    WHERE i."returnId" = p_return_id
      AND i.money = 'not_refunded'
      AND i."refundFailure" IS NOT NULL
      AND i."refundFailure" <> 'disputed';
  ELSE
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::integer[])
    INTO v_ids
    FROM unnest(p_item_ids) AS x;
  END IF;

  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'RETURN_ITEMS_REQUIRED';
  END IF;

  FOR v_row IN
    SELECT i.id, i.money, i."refundFailure"
    FROM cartlify.return_items AS i
    WHERE i.id = ANY (v_ids) AND i."returnId" = p_return_id
    ORDER BY i.id
    FOR UPDATE OF i
  LOOP
    v_count := v_count + 1;

    IF v_row.money <> 'not_refunded' OR v_row."refundFailure" IS NULL THEN
      RAISE EXCEPTION 'RETURN_ITEM_NOT_FAILED';
    END IF;

    IF v_row."refundFailure" = 'disputed' THEN
      RAISE EXCEPTION 'RETURN_REFUND_DISPUTED';
    END IF;
  END LOOP;

  IF v_count <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'RETURN_ITEM_NOT_FOUND';
  END IF;

  SELECT SUM(i.amount + i."deliveryShare" - i."shippingDeduction")
  INTO v_amount
  FROM cartlify.return_items AS i
  WHERE i.id = ANY (v_ids);

  UPDATE cartlify.return_items AS i
  SET money = 'refunded',
      "refundedAt" = p_at,
      "refundFailure" = NULL,
      "refundFailureText" = NULL,
      "outsideMethod" = p_method,
      "outsideNote" = v_note,
      "outsideById" = v_actor
  WHERE i.id = ANY (v_ids);

  PERFORM cartlify.refresh_return_state (v_order_id);

  RETURN jsonb_build_object(
    'returnId', p_return_id,
    'orderId', v_order_id,
    'itemIds', to_jsonb(v_ids),
    'amount', to_char(v_amount, 'FM99999999990.00')
  );
END;
$$;

-- Root records that the shop gave the buyer back what they paid the carrier for the way back,
-- outside the app (a payment of the card cannot be more than the order was paid): the shop pays
-- the way back (a statement outside the withdrawal, or a contract that says the shop pays; an order
-- without a contract told the buyer nothing, so the shop pays) and the buyer paid the carrier.
-- Root only (RETURN_FORBIDDEN); once a statement (RETURN_REIMBURSEMENT_EXISTS); never when the
-- buyer pays the way back of a withdrawal (RETURN_REIMBURSEMENT_NOT_ALLOWED). The sum is above 0
-- (RETURN_REIMBURSEMENT_INVALID); the way and a note are required (RETURN_OUTSIDE_NOTE_REQUIRED);
-- the day it went is required, not before the statement and never of the future
-- (RETURN_OUTSIDE_AT_INVALID): the reports count the expense in its period. The answer is
-- { returnId, orderId, amount }.
CREATE OR REPLACE FUNCTION cartlify.record_return_reimbursement (
  p_return_id integer,
  p_amount numeric,
  p_method cartlify."ReturnOutsideMethod",
  p_note text,
  p_at timestamp without time zone
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor    integer := cartlify.current_actor_id();
  v_now      timestamp := (now() AT TIME ZONE 'UTC')::timestamp(3);
  v_order_id integer;
  v_note     text := btrim(p_note);
  v_row      record;
  v_payer    cartlify."ReturnShippingPayer";
BEGIN
  IF NOT cartlify.is_root () OR v_actor IS NULL THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  v_order_id := cartlify.lock_return_order (p_return_id);

  PERFORM cartlify.assert_return_accepted (p_return_id);

  SELECT r.basis, r."statedAt", r."shippingReimbursed"
  INTO v_row
  FROM cartlify.returns AS r
  WHERE r.id = p_return_id;

  SELECT o."returnShippingPaidBy" INTO v_payer FROM cartlify.orders AS o WHERE o.id = v_order_id;

  IF v_row."shippingReimbursed" IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_REIMBURSEMENT_EXISTS';
  END IF;

  IF v_row.basis = 'withdrawal' AND v_payer = 'buyer' THEN
    RAISE EXCEPTION 'RETURN_REIMBURSEMENT_NOT_ALLOWED';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 99999999.99 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'RETURN_REIMBURSEMENT_INVALID';
  END IF;

  IF p_method IS NULL OR v_note IS NULL OR v_note = '' OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'RETURN_OUTSIDE_NOTE_REQUIRED';
  END IF;

  IF p_method = 'chargeback' THEN
    RAISE EXCEPTION 'RETURN_OUTSIDE_METHOD_INVALID';
  END IF;

  IF p_at IS NULL OR p_at > v_now OR p_at < v_row."statedAt" THEN
    RAISE EXCEPTION 'RETURN_OUTSIDE_AT_INVALID';
  END IF;

  UPDATE cartlify.returns AS r
  SET "shippingReimbursed" = p_amount,
      "shippingReimbursedAt" = p_at,
      "shippingReimbursedMethod" = p_method,
      "shippingReimbursedNote" = v_note,
      "shippingReimbursedById" = v_actor
  WHERE r.id = p_return_id;

  RETURN jsonb_build_object(
    'returnId', p_return_id,
    'orderId', v_order_id,
    'amount', to_char(p_amount, 'FM99999999990.00')
  );
END;
$$;

-- The end of a dispute of the payment of an order at the bank, for the rows whose transfer failed
-- as disputed: lost (the bank gave the buyer the money: the rows are refunded with the way
-- chargeback, on the day the dispute closed, with a note) or won (the bank gave the money back to
-- the shop: the rows lose the mark and their money is sent again the usual way). Root, or the
-- system (the webhook of the provider, which tells the end of a dispute of a payment): RETURN_FORBIDDEN
-- for anyone else. RETURN_NOT_DISPUTED when no row of the order waits on a dispute. The note is
-- required (RETURN_OUTSIDE_NOTE_REQUIRED); a lost dispute needs the day, not before the payment and
-- never of the future (RETURN_OUTSIDE_AT_INVALID): the reports count the money in its period. The
-- answer is { orderId, itemIds, returnIds, won, amount }.
CREATE OR REPLACE FUNCTION cartlify.settle_return_dispute (
  p_order_id integer,
  p_won boolean,
  p_note text,
  p_at timestamp without time zone
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor     integer := cartlify.current_actor_id();
  v_now       timestamp := (now() AT TIME ZONE 'UTC')::timestamp(3);
  v_note      text := btrim(p_note);
  v_return_id integer;
  v_paid_at   timestamp;
  v_ids       integer[];
  v_returns   integer[];
  v_amount    numeric;
BEGIN
  IF NOT ((cartlify.is_root () AND v_actor IS NOT NULL) OR cartlify.is_system ()) THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  SELECT MIN(i."returnId")
  INTO v_return_id
  FROM cartlify.return_items AS i
  JOIN cartlify.returns AS r ON r.id = i."returnId"
  WHERE r."orderId" = p_order_id AND i.money = 'not_refunded' AND i."refundFailure" = 'disputed';

  IF v_return_id IS NULL THEN
    RAISE EXCEPTION 'RETURN_NOT_DISPUTED';
  END IF;

  -- the same order of locks as the other functions of the statements
  PERFORM cartlify.lock_return_order (v_return_id);

  SELECT
    array_agg(i.id ORDER BY i.id),
    array_agg(DISTINCT i."returnId"),
    SUM(i.amount + i."deliveryShare" - i."shippingDeduction")
  INTO v_ids, v_returns, v_amount
  FROM cartlify.return_items AS i
  JOIN cartlify.returns AS r ON r.id = i."returnId"
  WHERE r."orderId" = p_order_id AND i.money = 'not_refunded' AND i."refundFailure" = 'disputed';

  IF v_ids IS NULL THEN
    RAISE EXCEPTION 'RETURN_NOT_DISPUTED';
  END IF;

  IF v_note IS NULL OR v_note = '' OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'RETURN_OUTSIDE_NOTE_REQUIRED';
  END IF;

  IF p_won THEN
    UPDATE cartlify.return_items AS i
    SET "refundFailure" = NULL,
        "refundFailureText" = NULL
    WHERE i.id = ANY (v_ids);
  ELSE
    SELECT o."paidAt" INTO v_paid_at FROM cartlify.orders AS o WHERE o.id = p_order_id;

    IF p_at IS NULL OR p_at > v_now OR p_at < v_paid_at THEN
      RAISE EXCEPTION 'RETURN_OUTSIDE_AT_INVALID';
    END IF;

    UPDATE cartlify.return_items AS i
    SET money = 'refunded',
        "refundedAt" = p_at,
        "refundFailure" = NULL,
        "refundFailureText" = NULL,
        "outsideMethod" = 'chargeback',
        "outsideNote" = v_note,
        "outsideById" = v_actor
    WHERE i.id = ANY (v_ids);
  END IF;

  PERFORM cartlify.refresh_return_state (p_order_id);

  RETURN jsonb_build_object(
    'orderId', p_order_id,
    'itemIds', to_jsonb(v_ids),
    'returnIds', to_jsonb(v_returns),
    'won', p_won,
    'amount', to_char(v_amount, 'FM99999999990.00')
  );
END;
$$;

-- Root closes rows of a statement without a refund: the goods never came back and the buyer does not
-- get the money (the buyer changed their mind, was not the buyer, did not send the goods). Root
-- only (RETURN_FORBIDDEN). Rows that wait for their goods and have no money on its way or back
-- (RETURN_ITEM_NOT_CLOSABLE otherwise); p_item_ids names them (all of the statement when null). The
-- rows become not arrived with the money refused and the code; the statement keeps the code and
-- the note of the last time (the code and a note are required, RETURN_CLOSE_NOTE_REQUIRED) and is closed
-- when no row waits. The stock does not move. The answer is { returnId, orderId, itemIds, closed }.
CREATE OR REPLACE FUNCTION cartlify.close_return_without_refund (
  p_return_id integer,
  p_item_ids integer[],
  p_code cartlify."ReturnCloseCode",
  p_note text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor    integer := cartlify.current_actor_id();
  v_now      timestamp := (now() AT TIME ZONE 'UTC')::timestamp(3);
  v_order_id integer;
  v_note     text := btrim(p_note);
  v_ids      integer[];
  v_row      record;
  v_count    integer := 0;
  v_closed   timestamp;
BEGIN
  IF NOT cartlify.is_root () OR v_actor IS NULL THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  v_order_id := cartlify.lock_return_order (p_return_id);

  IF p_code IS NULL OR v_note IS NULL OR v_note = '' OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'RETURN_CLOSE_NOTE_REQUIRED';
  END IF;

  IF p_item_ids IS NULL THEN
    SELECT COALESCE(array_agg(i.id ORDER BY i.id), ARRAY[]::integer[])
    INTO v_ids
    FROM cartlify.return_items AS i
    WHERE i."returnId" = p_return_id AND i.goods = 'expected' AND i.money = 'not_refunded';
  ELSE
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::integer[])
    INTO v_ids
    FROM unnest(p_item_ids) AS x;
  END IF;

  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'RETURN_ITEMS_REQUIRED';
  END IF;

  FOR v_row IN
    SELECT i.id, i.goods, i.money
    FROM cartlify.return_items AS i
    WHERE i.id = ANY (v_ids) AND i."returnId" = p_return_id
    ORDER BY i.id
    FOR UPDATE OF i
  LOOP
    v_count := v_count + 1;

    IF v_row.goods <> 'expected' OR v_row.money <> 'not_refunded' THEN
      RAISE EXCEPTION 'RETURN_ITEM_NOT_CLOSABLE';
    END IF;
  END LOOP;

  IF v_count <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'RETURN_ITEM_NOT_FOUND';
  END IF;

  UPDATE cartlify.return_items AS i
  SET goods = 'not_arrived',
      money = 'refused',
      "refusedCode" = p_code,
      "deliveryShare" = 0,
      "shippingDeduction" = 0,
      "refundFailure" = NULL,
      "refundFailureText" = NULL,
      "goodsSetAt" = v_now,
      "goodsSetById" = v_actor
  WHERE i.id = ANY (v_ids);

  UPDATE cartlify.returns AS r
  SET "closeCode" = p_code, "closeNote" = v_note
  WHERE r.id = p_return_id;

  PERFORM cartlify.refresh_return_state (v_order_id);

  SELECT r."closedAt" INTO v_closed FROM cartlify.returns AS r WHERE r.id = p_return_id;

  RETURN jsonb_build_object(
    'returnId', p_return_id,
    'orderId', v_order_id,
    'itemIds', to_jsonb(v_ids),
    'closed', v_closed IS NOT NULL
  );
END;
$$;

----------------------------------------
-- RETURNS: THE PARCELS BACK
----------------------------------------
-- Guard of the parcels back: the owner functions set the cost, nothing else changes (the carrier,
-- the number and the time are as the admin gave them when the parcel was recorded).
CREATE OR REPLACE FUNCTION cartlify.return_shipments_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner' AND v_changed <@ ARRAY['cost', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'RETURN_SHIPMENT_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_return_shipments_update_columns ON cartlify.return_shipments;

CREATE TRIGGER trg_return_shipments_update_columns
BEFORE UPDATE ON cartlify.return_shipments FOR EACH ROW
EXECUTE FUNCTION cartlify.return_shipments_update_columns ();

-- Stamps updatedAt of a parcel back on every update (utc without a zone, as prisma writes it).
CREATE OR REPLACE FUNCTION cartlify.return_shipments_before_update () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := now() AT TIME ZONE 'UTC';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_return_shipments_before_update ON cartlify.return_shipments;

CREATE TRIGGER trg_return_shipments_before_update
BEFORE UPDATE ON cartlify.return_shipments FOR EACH ROW
EXECUTE FUNCTION cartlify.return_shipments_before_update ();

-- Records a parcel the shop paid to carry the goods of a statement back from the buyer, and returns
-- its id. An admin or root (the system records none: RETURN_FORBIDDEN). The time it was sent is the
-- admin's to give: a parcel the buyer sent, or the moment a parcel was refused; never of the
-- future, never before the order was paid (RETURN_SHIPMENT_TIME_INVALID). The cost may be written
-- later (set_return_shipment_cost); the reports count the parcel in the period of that time.
CREATE OR REPLACE FUNCTION cartlify.record_return_shipment (
  p_return_id integer,
  p_carrier text,
  p_tracking_number text,
  p_tracking_url text,
  p_cost numeric,
  p_shipped_at timestamp
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor    integer;
  v_order_id integer;
  v_paid_at  timestamp;
  v_now      timestamp := (now() AT TIME ZONE 'UTC')::timestamp(3);
  v_id       integer;
BEGIN
  v_actor := cartlify.current_actor_id ();

  IF NOT cartlify.is_admin () OR v_actor IS NULL THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  v_order_id := cartlify.lock_return_order (p_return_id);

  PERFORM cartlify.assert_return_accepted (p_return_id);

  SELECT o."paidAt" INTO v_paid_at FROM cartlify.orders AS o WHERE o.id = v_order_id;

  IF p_shipped_at IS NULL OR p_shipped_at > v_now OR v_paid_at IS NULL OR p_shipped_at < v_paid_at THEN
    RAISE EXCEPTION 'RETURN_SHIPMENT_TIME_INVALID';
  END IF;

  -- one parcel is one cost: its number once per statement, whatever the spaces and the case (a
  -- double click would count the cost twice and let a transfer take it off twice)
  IF NULLIF(btrim(p_tracking_number), '') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM cartlify.return_shipments AS s
    WHERE s."returnId" = p_return_id
      AND upper(regexp_replace(s."trackingNumber", '\s', '', 'g'))
        = upper(regexp_replace(p_tracking_number, '\s', '', 'g'))
  ) THEN
    RAISE EXCEPTION 'RETURN_SHIPMENT_EXISTS';
  END IF;

  INSERT INTO cartlify.return_shipments (
    "returnId", carrier, "trackingNumber", "trackingUrl", cost, "shippedAt", "recordedById"
  )
  VALUES (
    p_return_id,
    NULLIF(btrim(p_carrier), ''),
    NULLIF(btrim(p_tracking_number), ''),
    NULLIF(btrim(p_tracking_url), ''),
    p_cost,
    p_shipped_at,
    v_actor
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Writes what the shop paid for a parcel back (a cost not written yet, or one corrected), and
-- returns the id of the parcel with the cost it had, read under the lock of the order, for the
-- log. An admin or root; RETURN_SHIPMENT_NOT_FOUND for a parcel there is not. The time of the
-- parcel stays, so the cost goes to the period the parcel was sent in.
CREATE OR REPLACE FUNCTION cartlify.set_return_shipment_cost (
  p_shipment_id integer,
  p_cost numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_return_id integer;
  v_old       numeric;
BEGIN
  IF NOT cartlify.is_admin () OR cartlify.current_actor_id () IS NULL THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN';
  END IF;

  SELECT s."returnId" INTO v_return_id FROM cartlify.return_shipments AS s WHERE s.id = p_shipment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RETURN_SHIPMENT_NOT_FOUND';
  END IF;

  PERFORM cartlify.lock_return_order (v_return_id);

  SELECT s.cost INTO v_old FROM cartlify.return_shipments AS s WHERE s.id = p_shipment_id;

  UPDATE cartlify.return_shipments AS s SET cost = p_cost WHERE s.id = p_shipment_id;

  RETURN jsonb_build_object('shipmentId', p_shipment_id, 'oldCost', v_old);
END;
$$;

-- A change of a row of a statement (the result of the goods, the money, a split) is a change of the
-- statement: its updatedAt follows, so the list of the statements sorted by the last change shows
-- the work on the rows too. Internal: a trigger, it runs as the owner whoever changed the row.
CREATE OR REPLACE FUNCTION cartlify.return_items_touch_return () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  UPDATE cartlify.returns AS r
  SET "updatedAt" = now() AT TIME ZONE 'UTC'
  WHERE r.id = NEW."returnId";

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_return_items_touch_return ON cartlify.return_items;

CREATE TRIGGER trg_return_items_touch_return
AFTER INSERT OR UPDATE ON cartlify.return_items FOR EACH ROW
EXECUTE FUNCTION cartlify.return_items_touch_return ();

------------------------------------------------------------
-- NEWSLETTERS
------------------------------------------------------------
-- The tables: newsletter_subscriptions (the present state of one address), newsletter_subscription_events
-- (its journal), newsletter_campaigns, newsletter_recipients (one mail of a campaign),
-- newsletter_form_blocklist (addresses blocked for the public form). Their policies are in db/03,
-- their checks and indexes in db/06. Nobody writes a subscription, a journal line, a recipient or a
-- blocked address with a statement of the app: the functions of the database do (they run as the
-- owner); a campaign is written by the one who runs the newsletters, and moved along by the system.
-- A guard says what an update may change, comparing NEW with OLD (the rules of UPDATE GUARDS above).

-- True for root, and for an ADMIN, signed in, whose account root allowed to run the newsletters
-- (users."canManageNewsletters") and which is not deleted. The system (the admin context without a
-- user id) is not one. The column is read here as the owner, so a policy of another table can ask
-- it for the actor of the statement, whoever that is: this is data, not a flag of the session.
CREATE OR REPLACE FUNCTION cartlify.newsletter_manager () RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_id integer;
BEGIN
  IF cartlify.is_root() THEN
    RETURN true;
  END IF;

  IF cartlify.current_actor_role() IS DISTINCT FROM 'ADMIN' THEN
    RETURN false;
  END IF;

  v_id := cartlify.current_actor_id();

  IF v_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN COALESCE(
    (
      SELECT u."canManageNewsletters"
      FROM cartlify.users AS u
      WHERE u.id = v_id AND u.role = 'ADMIN' AND u."deletedAt" IS NULL
    ),
    false
  );
END;
$$;

-- The version of the privacy policy in force, for the events of consent of a subscription; none
-- while no policy is published. Internal: the functions of the newsletters call it.
CREATE OR REPLACE FUNCTION cartlify.current_privacy_version () RETURNS integer LANGUAGE sql STABLE
SET
  search_path = cartlify,
  pg_temp AS $$
  SELECT d.version
  FROM cartlify.legal_documents AS d
  WHERE d.kind = 'privacy'
  ORDER BY d.version DESC
  LIMIT 1;
$$;

-- The right to run the newsletters goes off when the account stops being an ADMIN. It runs before
-- the guard of users (trg_users_update_columns, named to come after the other triggers), which
-- then sees a column that is off together with the role that left. It does not set anything on.
CREATE OR REPLACE FUNCTION cartlify.users_clear_newsletter_manager () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."canManageNewsletters" := false;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_clear_newsletter_manager ON cartlify.users;

CREATE TRIGGER trg_users_clear_newsletter_manager
BEFORE UPDATE OF role ON cartlify.users FOR EACH ROW
WHEN (OLD.role = 'ADMIN' AND NEW.role <> 'ADMIN' AND NEW."canManageNewsletters")
EXECUTE FUNCTION cartlify.users_clear_newsletter_manager ();

-- Guard of a new account: it never brings the right to run the newsletters. The policy of db/03
-- (users_insert) lets root insert an ADMIN and the system a verified buyer, and the column is off
-- by default, but a statement may name it; the right is given afterwards, to an account that
-- exists, by the function of the database for root (newsletter_set_manager), and by nobody else.
-- A superuser (a data script by hand) is not checked, as rls does not check it either. The refusal
-- is USER_INSERT_FORBIDDEN with the code 42501.
CREATE OR REPLACE FUNCTION cartlify.users_insert_columns () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF NEW."canManageNewsletters" THEN
    RAISE EXCEPTION 'USER_INSERT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_insert_columns ON cartlify.users;

CREATE TRIGGER trg_users_insert_columns
BEFORE INSERT ON cartlify.users FOR EACH ROW
EXECUTE FUNCTION cartlify.users_insert_columns ();

-- The address a subscription takes when an admin erases its address
-- (newsletter_admin_erase_address): the placeholder of the row, deleted+<id>@deleted.invalid ("invalid"
-- is a top level domain nobody can register or mail). The guards of the subscriptions and of the
-- journal and a policy of db/03 know an erased row by it. Internal: no execute right for the app.
CREATE OR REPLACE FUNCTION cartlify.newsletter_erased_email (p_id integer) RETURNS text LANGUAGE sql IMMUTABLE
SET
  search_path = cartlify,
  pg_temp AS $$
  SELECT 'deleted+' || p_id || '@deleted.invalid';
$$;

-- 64 random characters in hex, from the generator of the database that is made for secrets: the new
-- salt and the new hashes of the links of a subscription an admin erased, which nobody holds. Internal:
-- no execute right for the app.
CREATE OR REPLACE FUNCTION cartlify.newsletter_random_hex () RETURNS text LANGUAGE sql VOLATILE
SET
  search_path = cartlify,
  pg_temp AS $$
  SELECT encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex');
$$;

-- Guard of the subscriptions: only the steps of the database (the owner) change a row, and these
-- never: the id, the email, the time it was made. The account and the source change together,
-- once, when the account asks for its own address and that address waits for the confirmation of a
-- subscription of the form: the row becomes the subscription of the account. A subscription goes
-- one way: waiting to in force or ended; in force to paused by a complaint, stopped by a bounce or
-- ended; paused back to in force or on to stopped and ended; stopped to ended. An ended row is the
-- proof of the consent and changes no more (but the time of the change).
-- Two things are the exception, each a shape of its own that nothing else can pass:
--   the erasing of an address (newsletter_admin_erase_address): the email becomes the placeholder of
--     the row, the HMAC, the confirmation link and the account that ended it are emptied, the salt and
--     both hashes of the links are replaced by new ones, a live row ends, an ended or stopped one
--     keeps its state; the row may be ended or stopped already. Nothing else changes in that step, and
--     a row that is anonymous already cannot be anonymized again;
--   the account that ended a subscription of the form (endedUserId): written in the move that ends it,
--     and emptied (alone) by the foreign key when the account row goes.
-- The HMAC of the address changes in no other step but the erasing and the turn of a request of the
-- form into the subscription of the account that asked for its own address. A superuser is not
-- checked. The refusal is NEWSLETTER_SUBSCRIPTION_UPDATE_FORBIDDEN with the code 42501.
CREATE OR REPLACE FUNCTION cartlify.newsletter_subscriptions_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
  -- the step that erases an address, in the one shape it has
  v_erasing boolean := coalesce(
    current_user = 'cartlify_owner'
    AND NEW.email <> OLD.email
    AND NEW.email = cartlify.newsletter_erased_email (NEW.id)
    AND NEW."emailHmac" IS NULL
    AND NEW."confirmHash" IS NULL
    AND NEW."confirmExpiresAt" IS NULL
    AND NEW."endedUserId" IS NULL
    AND NEW.status IN ('ended', 'stopped_bounce')
    AND NEW."manageSalt" <> OLD."manageSalt"
    AND NEW."manageHash" <> OLD."manageHash"
    AND NEW."unsubscribeHash" <> OLD."unsubscribeHash"
    AND v_changed <@ ARRAY[
      'email', 'emailHmac', 'confirmHash', 'confirmExpiresAt', 'endedUserId', 'manageSalt',
      'manageHash', 'unsubscribeHash', 'status', 'endedAt', 'endReason', 'updatedAt'
    ],
    false
  );
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  -- the foreign key empties the account that ended a subscription, when that account row goes
  IF current_user = 'cartlify_owner'
     AND v_changed = ARRAY['endedUserId']
     AND NEW."endedUserId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF current_user = 'cartlify_owner'
     AND NEW.id = OLD.id
     AND (NEW.email = OLD.email OR v_erasing)
     AND NEW."createdAt" = OLD."createdAt"
     AND (
       NEW."emailHmac" IS NOT DISTINCT FROM OLD."emailHmac"
       OR v_erasing
       OR (OLD.source = 'form' AND NEW.source = 'account' AND OLD.status = 'pending')
     )
     AND (
       NEW."endedUserId" IS NOT DISTINCT FROM OLD."endedUserId"
       OR v_erasing
       OR (OLD.status IN ('pending', 'active', 'paused_complaint') AND NEW.status = 'ended')
     )
     AND (
       NEW.source = OLD.source
       OR (OLD.source = 'form' AND NEW.source = 'account' AND OLD.status = 'pending')
     )
     AND (
       NEW."userId" IS NOT DISTINCT FROM OLD."userId"
       OR (
         OLD.source = 'form' AND NEW.source = 'account' AND OLD.status = 'pending'
         AND OLD."userId" IS NULL
       )
     )
     AND (
       (
         NEW.status = OLD.status
         AND (OLD.status <> 'ended' OR v_changed <@ ARRAY['updatedAt'] OR v_erasing)
       )
       OR (OLD.status = 'pending' AND NEW.status IN ('active', 'ended'))
       OR (OLD.status = 'active' AND NEW.status IN ('paused_complaint', 'stopped_bounce', 'ended'))
       OR (OLD.status = 'paused_complaint' AND NEW.status IN ('active', 'stopped_bounce', 'ended'))
       OR (OLD.status = 'stopped_bounce' AND NEW.status = 'ended')
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'NEWSLETTER_SUBSCRIPTION_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_newsletter_subscriptions_update_columns ON cartlify.newsletter_subscriptions;

CREATE TRIGGER trg_newsletter_subscriptions_update_columns
BEFORE UPDATE ON cartlify.newsletter_subscriptions FOR EACH ROW
EXECUTE FUNCTION cartlify.newsletter_subscriptions_update_columns ();

-- Guard of the journal of a subscription: a line is history, written once and never changed. The
-- policies of db/03 deny every update already; this guard says it a second time for a role that
-- would skip them. The one change is the owner's, who empties the address and the browser of a line
-- (nothing else of it) when its subscription was erased by an admin (it ended or stopped and has the
-- placeholder of its id in the place of the address, newsletter_erased_email). A line is removed only
-- by the owner (the cleanup of the retention terms, the removal of a subscriber by an admin, the
-- removal of a request that was not confirmed) and only when its subscription has ended or stopped: a
-- subscription in force keeps its proof. A superuser is not checked. The refusal is
-- NEWSLETTER_EVENTS_APPEND_ONLY with the code 42501.
CREATE OR REPLACE FUNCTION cartlify.newsletter_subscription_events_append_only () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE'
     AND current_user = 'cartlify_owner'
     AND EXISTS (
       SELECT 1
       FROM cartlify.newsletter_subscriptions AS s
       WHERE s.id = OLD."subscriptionId" AND s.status IN ('ended', 'stopped_bounce')
     ) THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND current_user = 'cartlify_owner'
     AND NEW.ip IS NULL
     AND NEW."userAgent" IS NULL
     AND to_jsonb(NEW) - 'ip' - 'userAgent' = to_jsonb(OLD) - 'ip' - 'userAgent'
     AND EXISTS (
       SELECT 1
       FROM cartlify.newsletter_subscriptions AS s
       WHERE s.id = OLD."subscriptionId"
         AND s.status IN ('ended', 'stopped_bounce')
         AND s.email = cartlify.newsletter_erased_email (s.id)
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'NEWSLETTER_EVENTS_APPEND_ONLY' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_newsletter_subscription_events_append_only ON cartlify.newsletter_subscription_events;

CREATE TRIGGER trg_newsletter_subscription_events_append_only
BEFORE UPDATE OR DELETE ON cartlify.newsletter_subscription_events FOR EACH ROW
EXECUTE FUNCTION cartlify.newsletter_subscription_events_append_only ();

-- Guard of the campaigns. A campaign goes draft, scheduled, sending, then finished or stopped; a
-- scheduled one may go back to a draft or be cancelled. Who moves it: the one who runs the
-- newsletters (newsletter_manager) schedules, unschedules, cancels and stops; the system (the admin
-- context without a user id) starts a scheduled campaign and finishes a sending one, and cancels a
-- scheduled one when the limit of the campaigns is reached at its start (the reason "limit" is
-- written with the time of it, and nothing else changes; a cancellation of a manager has no reason).
-- The text (the name, the language rule, the content, the time) changes only in a draft or a scheduled
-- campaign,
-- by a manager, who names themselves as the editor (updatedById). The data of the products and the
-- start are the system's, at the start. The totals move only with the sending and after it (the
-- system, and the steps of the database for a bounce, a complaint or an unsubscribe, which run as
-- the owner for whoever asked): never by a manager, never while the campaign is a draft or
-- scheduled; the number of planned mails only while it is sending. Nothing else changes, besides
-- the link to the original: it is emptied by the foreign key (as the owner) when that draft is
-- deleted. A superuser is not checked. The refusal is NEWSLETTER_CAMPAIGN_UPDATE_FORBIDDEN with
-- the code 42501.
CREATE OR REPLACE FUNCTION cartlify.newsletter_campaigns_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_changed text[] := ARRAY(
    SELECT n.key FROM jsonb_each(to_jsonb(NEW)) AS n
    WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
  );
  v_totals CONSTANT text[] := ARRAY[
    'plannedCount', 'sentCount', 'rejectedCount', 'undeliveredCount', 'complaintCount',
    'unsubscribedCount'
  ];
  v_text CONSTANT text[] := ARRAY['name', 'missingLocale', 'content', 'scheduledAt', 'updatedById', 'updatedAt'];
  v_system boolean := cartlify.is_system();
  v_actor integer := cartlify.current_actor_id();
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  -- the foreign key empties the link to a deleted draft, at any state of the copy
  IF current_user = 'cartlify_owner'
     AND v_changed = ARRAY['copiedFromId']
     AND NEW."copiedFromId" IS NULL THEN
    RETURN NEW;
  END IF;

  -- the totals
  IF NEW.status = OLD.status
     AND OLD.status IN ('sending', 'finished', 'stopped', 'cancelled')
     AND (v_system OR current_user = 'cartlify_owner')
     AND v_changed <@ (v_totals || ARRAY['updatedAt'])
     AND (NOT v_changed @> ARRAY['plannedCount'] OR OLD.status = 'sending') THEN
    RETURN NEW;
  END IF;

  -- the system starts a scheduled campaign and ends a sending one
  IF v_system
     AND OLD.status = 'scheduled'
     AND NEW.status = 'sending'
     AND NEW."startedAt" IS NOT NULL
     AND v_changed <@ ARRAY['status', 'startedAt', 'productsSnapshot', 'plannedCount', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  IF v_system
     AND OLD.status = 'sending'
     AND NEW.status = 'finished'
     AND NEW."finishedAt" IS NOT NULL
     AND v_changed <@ (ARRAY['status', 'finishedAt', 'updatedAt'] || v_totals) THEN
    RETURN NEW;
  END IF;

  IF v_system
     AND OLD.status = 'scheduled'
     AND NEW.status = 'cancelled'
     AND NEW."cancelledAt" IS NOT NULL
     AND NEW."cancelReason" = 'limit'
     AND v_changed <@ ARRAY['status', 'cancelledAt', 'cancelReason', 'updatedAt'] THEN
    RETURN NEW;
  END IF;

  -- the one who runs the newsletters
  IF cartlify.newsletter_manager() AND NEW."updatedById" = v_actor THEN
    IF OLD.status IN ('draft', 'scheduled')
       AND NEW.status = OLD.status
       AND v_changed <@ v_text THEN
      RETURN NEW;
    END IF;

    IF OLD.status = 'draft'
       AND NEW.status = 'scheduled'
       AND NEW."scheduledAt" IS NOT NULL
       AND v_changed <@ (v_text || ARRAY['status']) THEN
      RETURN NEW;
    END IF;

    IF OLD.status = 'scheduled'
       AND NEW.status = 'draft'
       AND v_changed <@ (v_text || ARRAY['status']) THEN
      RETURN NEW;
    END IF;

    IF OLD.status = 'scheduled'
       AND NEW.status = 'cancelled'
       AND NEW."cancelledAt" IS NOT NULL
       AND v_changed <@ ARRAY['status', 'cancelledAt', 'updatedById', 'updatedAt'] THEN
      RETURN NEW;
    END IF;

    IF OLD.status = 'sending'
       AND NEW.status = 'stopped'
       AND NEW."stoppedAt" IS NOT NULL
       AND v_changed <@ ARRAY['status', 'stoppedAt', 'updatedById', 'updatedAt'] THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'NEWSLETTER_CAMPAIGN_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_newsletter_campaigns_update_columns ON cartlify.newsletter_campaigns;

CREATE TRIGGER trg_newsletter_campaigns_update_columns
BEFORE UPDATE ON cartlify.newsletter_campaigns FOR EACH ROW
EXECUTE FUNCTION cartlify.newsletter_campaigns_update_columns ();

-- Guard of the recipients: the system and the steps of the database record how the sending went
-- (the status, the tries, the id of the mail, the time), but a row keeps its campaign, its
-- subscription and the language it was made in. The status goes one way: a mail that waits (queued)
-- becomes any other; a mail that was sent can only be reported on by the provider (bounced, dropped,
-- complained); a mail the provider refused (rejected), one the sending left out (skipped) and one
-- reported on keep their status. A superuser is not checked. The refusal is
-- NEWSLETTER_RECIPIENT_UPDATE_FORBIDDEN with the code 42501.
CREATE OR REPLACE FUNCTION cartlify.newsletter_recipients_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF (cartlify.is_system() OR current_user = 'cartlify_owner')
     AND NEW.id = OLD.id
     AND NEW."campaignId" = OLD."campaignId"
     AND NEW."subscriptionId" = OLD."subscriptionId"
     AND NEW.locale = OLD.locale
     AND NEW."createdAt" = OLD."createdAt"
     AND (
       NEW.status = OLD.status
       OR OLD.status = 'queued'
       OR (OLD.status = 'sent' AND NEW.status IN ('bounced', 'dropped', 'complained'))
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'NEWSLETTER_RECIPIENT_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_newsletter_recipients_update_columns ON cartlify.newsletter_recipients;

CREATE TRIGGER trg_newsletter_recipients_update_columns
BEFORE UPDATE ON cartlify.newsletter_recipients FOR EACH ROW
EXECUTE FUNCTION cartlify.newsletter_recipients_update_columns ();

-- Guard of the blocklist: an entry is added or removed, never changed. The policies of db/03 deny
-- every update already; this guard says it a second time for a role that would skip them. A
-- superuser is not checked. The refusal is NEWSLETTER_FORM_BLOCK_UPDATE_FORBIDDEN with the code
-- 42501.
CREATE OR REPLACE FUNCTION cartlify.newsletter_form_blocklist_update_columns () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'NEWSLETTER_FORM_BLOCK_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_newsletter_form_blocklist_update_columns ON cartlify.newsletter_form_blocklist;

CREATE TRIGGER trg_newsletter_form_blocklist_update_columns
BEFORE UPDATE ON cartlify.newsletter_form_blocklist FOR EACH ROW
EXECUTE FUNCTION cartlify.newsletter_form_blocklist_update_columns ();

------------------------------------------------------------
-- NEWSLETTERS: THE SUBSCRIPTION OF A PERSON
------------------------------------------------------------
-- The steps a person takes on their subscription, each a function that runs as the owner (the
-- tables of the newsletters take no statement of the app, db/03) and checks the actor itself.
-- Three kinds of caller:
--   the form of the public page and the links of the mails (newsletter_request, _confirm, _not_me,
--     _manage_*): a guest, or whoever holds the link. The functions do not look at who asks: the
--     token in the hand is the key, and the answer of the form does not depend on the actor;
--   the account on its own address (newsletter_subscribe_account, _profile_*): the owner of the
--     account, or the system; the address comes from users, never from a parameter, and an address
--     the account never proved is refused (NEWSLETTER_EMAIL_NOT_VERIFIED);
--   the end of an account (newsletter_end_for_account): its owner, the system, an admin or root.
-- Refusals are codes. Every change of state writes a line of the journal in the same transaction
-- (newsletter_subscription_events); the lines of consent (requested, confirmed, subscribed) keep the
-- version of the privacy policy in force. The guards of the tables (trg_newsletter_subscriptions_
-- update_columns and the others) say which change is allowed at all, and an ended subscription is
-- frozen: it stays as the proof of the consent until its term in the privacy policy.
-- A subscription is "live" while it is pending, active or paused_complaint (one per address,
-- db/06); it is "in force" while it is active or paused_complaint (the page of management and the
-- profile work on those). A step that looks an address up waits for the other steps on the same
-- address (an advisory lock for the transaction), so two requests cannot both make a row.
-- The locks of the steps go in one order, so none waits for another in a circle: the HMAC of the
-- address (the form and the blocklist know it: newsletter_request, _not_me, _block_add), then the
-- address, then the row (FOR UPDATE). A step by the token of a link takes the row only.
-- The time of a mail goes by the clock of the database in utc, as the other dates it writes.

-- Writes a line of the journal of a subscription. Internal step: runs with the rights of the
-- caller, which is a function of the newsletters running as the owner; the app has no execute
-- right (db/01). The address and the browser are cut to a sane length. The version of the privacy
-- policy goes to the lines of consent only (none while no policy is published).
CREATE OR REPLACE FUNCTION cartlify.newsletter_log_event (
  p_subscription_id integer,
  p_event text,
  p_place text,
  p_ip text,
  p_user_agent text,
  p_locale text,
  p_campaign_id integer DEFAULT NULL,
  p_actor_id integer DEFAULT NULL
) RETURNS void LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  INSERT INTO cartlify.newsletter_subscription_events (
    "subscriptionId",
    event,
    place,
    ip,
    "userAgent",
    locale,
    "campaignId",
    "privacyVersion",
    "actorId",
    "createdAt"
  )
  VALUES (
    p_subscription_id,
    p_event::cartlify."NewsletterEventKind",
    p_place::cartlify."NewsletterEventPlace",
    left(p_ip, 64),
    left(p_user_agent, 512),
    p_locale,
    p_campaign_id,
    CASE
      WHEN p_event IN ('requested', 'confirmed', 'subscribed') THEN cartlify.current_privacy_version()
    END,
    p_actor_id,
    now() AT TIME ZONE 'UTC'
  );
END;
$$;

-- Ends a subscription in force with the reason given and writes the line of the journal that says
-- so (in the language the subscription had). The row stays: it is the proof of the consent.
-- p_ended_user_id names the account whose deletion ends a subscription of the form (the column
-- endedUserId, the way the export of a deleted account finds it). Internal step, as above.
CREATE OR REPLACE FUNCTION cartlify.newsletter_end_subscription (
  p_subscription_id integer,
  p_reason text,
  p_event text,
  p_place text,
  p_ip text,
  p_user_agent text,
  p_campaign_id integer DEFAULT NULL,
  p_actor_id integer DEFAULT NULL,
  p_ended_user_id integer DEFAULT NULL
) RETURNS void LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now    timestamp := now() AT TIME ZONE 'UTC';
  v_locale text;
BEGIN
  UPDATE cartlify.newsletter_subscriptions AS s
  SET
    status = 'ended',
    "confirmHash" = NULL,
    "confirmExpiresAt" = NULL,
    "endedAt" = v_now,
    "endReason" = p_reason::cartlify."NewsletterEndReason",
    "endedUserId" = p_ended_user_id,
    "updatedAt" = v_now
  WHERE s.id = p_subscription_id
  RETURNING s.locale INTO v_locale;

  PERFORM cartlify.newsletter_log_event (
    p_subscription_id, p_event, p_place, p_ip, p_user_agent, v_locale, p_campaign_id, p_actor_id
  );
END;
$$;

-- The unsubscribe of the person who holds a link: the campaign whose mail they came from counts it
-- (the total "unsubscribed", and the line of the journal names the campaign) when it has gone out
-- (sending, finished or stopped) and has a mail to this very subscription (a row of its recipients).
-- The id of the campaign comes from the address of the link, so anybody who holds a token could
-- otherwise raise the totals of any campaign: an id of a campaign that does not exist, has not sent
-- anything, or never mailed this subscription is passed over (the unsubscribe works, nothing is
-- counted, the line names no campaign). Then the subscription ends with the reason unsubscribed. The
-- caller found the subscription by a token and holds its row, and says that it is in force. Internal
-- step, as above.
CREATE OR REPLACE FUNCTION cartlify.newsletter_unsubscribe_subscription (
  p_subscription_id integer,
  p_campaign_id integer,
  p_place text,
  p_ip text,
  p_user_agent text
) RETURNS void LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now      timestamp := now() AT TIME ZONE 'UTC';
  v_campaign integer;
BEGIN
  IF p_campaign_id IS NOT NULL THEN
    UPDATE cartlify.newsletter_campaigns AS c
    SET
      "unsubscribedCount" = c."unsubscribedCount" + 1,
      "updatedAt" = v_now
    WHERE c.id = p_campaign_id
      AND c.status IN ('sending', 'finished', 'stopped')
      AND EXISTS (
        SELECT 1
        FROM cartlify.newsletter_recipients AS r
        WHERE r."campaignId" = c.id AND r."subscriptionId" = p_subscription_id
      );

    IF FOUND THEN
      v_campaign := p_campaign_id;
    END IF;
  END IF;

  PERFORM cartlify.newsletter_end_subscription (
    p_subscription_id, 'unsubscribed', 'unsubscribed', p_place, p_ip, p_user_agent, v_campaign
  );
END;
$$;

-- The data of subscriptions as a person gets it (the page of management, the export of the
-- account): for each one the address, where it came from, the language, the state, the dates and
-- its journal (what, where, from which address and browser, the campaign of an unsubscribe, the
-- version of the policy). Dates are utc, ISO 8601. No token, no hash, no id of a row, no admin:
-- these are not the person's data. Only what the person confirmed: a subscription of an account, and
-- one of the form that has the time of its confirmation; a request that waits, or one that ended
-- without ever being confirmed, is the doing of whoever typed the address and is not given. Internal
-- step, as above.
CREATE OR REPLACE FUNCTION cartlify.newsletter_export_subscriptions (p_ids integer[]) RETURNS jsonb LANGUAGE sql STABLE
SET
  search_path = cartlify,
  pg_temp AS $$
  SELECT jsonb_build_object(
    'subscriptions',
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'email', s.email,
          'source', s.source,
          'locale', s.locale,
          'status', s.status,
          'createdAt', to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'confirmedAt', to_char(s."confirmedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'endedAt', to_char(s."endedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'endReason', s."endReason",
          'events', (
            SELECT COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'event', e.event,
                  'place', e.place,
                  'ip', e.ip,
                  'userAgent', e."userAgent",
                  'locale', e.locale,
                  'campaignId', e."campaignId",
                  'privacyVersion', e."privacyVersion",
                  'createdAt', to_char(e."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                )
                ORDER BY e.id
              ),
              '[]'::jsonb
            )
            FROM cartlify.newsletter_subscription_events AS e
            WHERE e."subscriptionId" = s.id
          )
        )
        ORDER BY s.id
      ),
      '[]'::jsonb
    )
  )
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s.id = ANY (p_ids) AND (s.source = 'account' OR s."confirmedAt" IS NOT NULL);
$$;

-- The address of the account that speaks for itself, for the steps of the profile. Only the owner
-- of the account or the system may ask (NEWSLETTER_FORBIDDEN, also for an account that does not
-- exist or is deleted, so the answer says nothing about who has an account), and only for an
-- address the account proved (NEWSLETTER_EMAIL_NOT_VERIFIED): a subscription sits on the address,
-- and the one who registers an address they do not own must not see or change what is on it.
-- Internal step, as above.
CREATE OR REPLACE FUNCTION cartlify.newsletter_account_email (p_user_id integer) RETURNS text LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_email    text;
  v_verified boolean;
BEGIN
  IF NOT (cartlify.is_system() OR cartlify.is_owner(p_user_id)) THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  SELECT lower(btrim(u.email)), u."isVerified"
  INTO v_email, v_verified
  FROM cartlify.users AS u
  WHERE u.id = p_user_id AND u."deletedAt" IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  IF NOT v_verified THEN
    RAISE EXCEPTION 'NEWSLETTER_EMAIL_NOT_VERIFIED';
  END IF;

  RETURN v_email;
END;
$$;

-- The form of the public page: someone asks to subscribe an address (a guest, or an account that
-- asks about an address that is not its own). Decides what the server must mail and records the
-- request; sends nothing itself. The answer is the outcome (confirm: mail the link of the
-- confirmation; already: mail "you are already subscribed"; nothing: mail nothing), the language
-- the mail goes in (that of the new request for a confirmation, of the subscription for "already";
-- empty means no language) and the salt of the link of management of the subscription the mail is
-- about (the server derives the token from it). The outcome of an address, by its state:
--   on the blocklist (the HMAC the server computed from the address)   nothing
--   a live subscription of an account                                  nothing (its owner sees it
--                                                                      in the profile)
--   a subscription of the form in force or paused by a complaint       already
--   a request that waits                                               confirm with a new token, the
--                                                                      three days counted again, the
--                                                                      old token dead and the language
--                                                                      of this request
--   no live row (also when it only has ended or bounced ones)          a new request, confirm
-- A mail of either kind goes to an address at most once a day: the day is counted from the later of
-- the last mail of confirmation (lastConfirmMailAt) and the last "already subscribed"
-- (lastAlreadyMailAt) of the row, for both kinds, so after the one the other waits for its day too.
-- A step that mails nothing changes nothing and writes nothing. The request that mails is a line of
-- the journal (requested, with the version of the policy). The outcome does not depend on the actor:
-- the server turns every one into the same public answer. The address is trimmed and lower-cased
-- here. NEWSLETTER_LOCALE_INVALID: the language is not two lower-case letters (the server checks
-- the languages the shop has before it asks). The step takes the lock of the HMAC, then the lock of
-- the address, before it looks at the blocklist and the rows: a block of the address made at the
-- same time (newsletter_block_add, newsletter_not_me) is seen by the request, or sees its request.
-- p_manage_salt, p_manage_hash and p_unsubscribe_hash are for a new request: the salt, the sha256 of
-- the token of the page of management and the sha256 of the token of the unsubscribe button of the
-- mail clients, both tokens made from the salt; a request that finds a row keeps the links it has.
CREATE OR REPLACE FUNCTION cartlify.newsletter_request (
  p_email text,
  p_email_hmac text,
  p_locale text,
  p_confirm_hash text,
  p_manage_salt text,
  p_manage_hash text,
  p_unsubscribe_hash text,
  p_ip text,
  p_user_agent text
) RETURNS TABLE (outcome text, locale text, manage_salt text) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := now() AT TIME ZONE 'UTC';
  v_email text := lower(btrim(p_email));
  v_sub   cartlify.newsletter_subscriptions%ROWTYPE;
  v_id    integer;
  v_last  timestamp;
BEGIN
  IF p_locale IS NOT NULL AND p_locale !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'NEWSLETTER_LOCALE_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.hmac.' || coalesce(p_email_hmac, '')));
  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.' || coalesce(v_email, '')));

  IF EXISTS (
    SELECT 1 FROM cartlify.newsletter_form_blocklist AS b WHERE b."emailHmac" = p_email_hmac
  ) THEN
    RETURN QUERY SELECT 'nothing'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT s.*
  INTO v_sub
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s.email = v_email AND s.status IN ('pending', 'active', 'paused_complaint')
  FOR UPDATE;

  IF FOUND THEN
    -- one limit for the mails of both kinds: the later of the two last mails
    v_last := greatest(v_sub."lastConfirmMailAt", v_sub."lastAlreadyMailAt");

    IF v_sub.status = 'pending' THEN
      IF v_last IS NOT NULL AND v_last > v_now - interval '1 day' THEN
        RETURN QUERY SELECT 'nothing'::text, NULL::text, NULL::text;
        RETURN;
      END IF;

      UPDATE cartlify.newsletter_subscriptions AS s
      SET
        "confirmHash" = p_confirm_hash,
        "confirmExpiresAt" = v_now + interval '3 days',
        "lastConfirmMailAt" = v_now,
        locale = p_locale,
        "updatedAt" = v_now
      WHERE s.id = v_sub.id;

      PERFORM cartlify.newsletter_log_event (v_sub.id, 'requested', 'form', p_ip, p_user_agent, p_locale);

      RETURN QUERY SELECT 'confirm'::text, p_locale, v_sub."manageSalt"::text;
      RETURN;
    END IF;

    IF v_sub.source = 'account'
       OR (v_last IS NOT NULL AND v_last > v_now - interval '1 day') THEN
      RETURN QUERY SELECT 'nothing'::text, NULL::text, NULL::text;
      RETURN;
    END IF;

    UPDATE cartlify.newsletter_subscriptions AS s
    SET
      "lastAlreadyMailAt" = v_now,
      "updatedAt" = v_now
    WHERE s.id = v_sub.id;

    RETURN QUERY SELECT 'already'::text, v_sub.locale::text, v_sub."manageSalt"::text;
    RETURN;
  END IF;

  INSERT INTO cartlify.newsletter_subscriptions (
    email,
    "emailHmac",
    source,
    locale,
    status,
    "confirmHash",
    "confirmExpiresAt",
    "manageSalt",
    "manageHash",
    "unsubscribeHash",
    "lastConfirmMailAt",
    "createdAt",
    "updatedAt"
  )
  VALUES (
    v_email,
    p_email_hmac,
    'form',
    p_locale,
    'pending',
    p_confirm_hash,
    v_now + interval '3 days',
    p_manage_salt,
    p_manage_hash,
    p_unsubscribe_hash,
    v_now,
    v_now,
    v_now
  )
  RETURNING id INTO v_id;

  PERFORM cartlify.newsletter_log_event (v_id, 'requested', 'form', p_ip, p_user_agent, p_locale);

  RETURN QUERY SELECT 'confirm'::text, p_locale, p_manage_salt;
END;
$$;

-- The mail of the form that the provider did not take: the form marked the address when it decided to
-- mail it (lastConfirmMailAt for a confirmation, lastAlreadyMailAt for "you are already subscribed"),
-- so that an address is mailed once a day at most, and a mail that never left must not cost the person
-- their day. p_kind is confirm or already (NEWSLETTER_MAIL_KIND_INVALID otherwise). The mark of that
-- kind on the live row of the address (a request that waits, a subscription in force or paused) is
-- taken back, and only while it is a fresh one, set within the last 5 minutes: the mark of a mail that
-- went long ago is the truth about that mail, whatever a caller says. The other mark stays. Returns
-- true when a mark was taken back. Any actor, as the form: the server calls it for the request it
-- just answered. The step holds the lock of the address, the one every step on it takes.
CREATE OR REPLACE FUNCTION cartlify.newsletter_request_mail_failed (
  p_email text,
  p_kind text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now    timestamp := now() AT TIME ZONE 'UTC';
  v_email  text := lower(btrim(p_email));
  v_fresh  CONSTANT interval := interval '5 minutes';
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('confirm', 'already') THEN
    RAISE EXCEPTION 'NEWSLETTER_MAIL_KIND_INVALID';
  END IF;

  IF v_email IS NULL OR v_email = '' THEN
    RETURN false;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.' || v_email));

  IF p_kind = 'confirm' THEN
    UPDATE cartlify.newsletter_subscriptions AS s
    SET
      "lastConfirmMailAt" = NULL,
      "updatedAt" = v_now
    WHERE s.email = v_email
      AND s.status IN ('pending', 'active', 'paused_complaint')
      AND s."lastConfirmMailAt" > v_now - v_fresh;
  ELSE
    UPDATE cartlify.newsletter_subscriptions AS s
    SET
      "lastAlreadyMailAt" = NULL,
      "updatedAt" = v_now
    WHERE s.email = v_email
      AND s.status IN ('pending', 'active', 'paused_complaint')
      AND s."lastAlreadyMailAt" > v_now - v_fresh;
  END IF;

  RETURN FOUND;
END;
$$;

-- The link "confirm the subscription" of the mail: p_confirm_hash is the sha256 of its token. The
-- request that waits (and has not expired) becomes a subscription in force; the token dies with
-- it. confirmed (with the language of the subscription, empty for none) or invalid (the token is
-- unknown, was used, was replaced by a newer mail, or is older than its three days). The line of the
-- journal is confirmed, with the version of the privacy policy.
CREATE OR REPLACE FUNCTION cartlify.newsletter_confirm (
  p_confirm_hash text,
  p_ip text,
  p_user_agent text
) RETURNS TABLE (outcome text, locale text) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now timestamp := now() AT TIME ZONE 'UTC';
  v_sub cartlify.newsletter_subscriptions%ROWTYPE;
BEGIN
  p_confirm_hash := btrim(p_confirm_hash);

  IF p_confirm_hash IS NULL OR p_confirm_hash = '' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::text;
    RETURN;
  END IF;

  SELECT s.*
  INTO v_sub
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s."confirmHash" = p_confirm_hash AND s.status = 'pending' AND s."confirmExpiresAt" > v_now
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::text;
    RETURN;
  END IF;

  UPDATE cartlify.newsletter_subscriptions AS s
  SET
    status = 'active',
    "confirmHash" = NULL,
    "confirmExpiresAt" = NULL,
    "confirmedAt" = v_now,
    "updatedAt" = v_now
  WHERE s.id = v_sub.id;

  PERFORM cartlify.newsletter_log_event (v_sub.id, 'confirmed', 'form', p_ip, p_user_agent, v_sub.locale);

  RETURN QUERY SELECT 'confirmed'::text, v_sub.locale::text;
END;
$$;

-- The second button of the same mail, "this was not me, do not send more": p_confirm_hash is the
-- sha256 of the same token, which works for as long as the confirmation does. The HMAC of the
-- address goes to the blocklist as the person's own entry (an entry that exists stays), and the
-- request is removed with its lines: it goes pending, ended (not_me), its lines, the row (the
-- guards let a journal go only with an ended subscription). Returns true when it did so, false for
-- a token that is unknown, spent or expired (nothing changes). A subscription in force of the
-- address, if there is one, is not touched: the blocklist is for new requests. The step looks the
-- request up first, takes the lock of its HMAC and of its address (the order of newsletter_request
-- and newsletter_block_add, so a request of the address made at the same time is answered with
-- nothing, not given a new request beside the entry), then reads the request again with its row
-- locked, since another step may have changed it while this one waited.
CREATE OR REPLACE FUNCTION cartlify.newsletter_not_me (
  p_confirm_hash text,
  p_ip text,
  p_user_agent text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now timestamp := now() AT TIME ZONE 'UTC';
  v_sub cartlify.newsletter_subscriptions%ROWTYPE;
BEGIN
  p_confirm_hash := btrim(p_confirm_hash);

  IF p_confirm_hash IS NULL OR p_confirm_hash = '' THEN
    RETURN false;
  END IF;

  SELECT s.*
  INTO v_sub
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s."confirmHash" = p_confirm_hash AND s.status = 'pending' AND s."confirmExpiresAt" > v_now;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.hmac.' || coalesce(v_sub."emailHmac", '')));
  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.' || v_sub.email));

  SELECT s.*
  INTO v_sub
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s.id = v_sub.id
    AND s."confirmHash" = p_confirm_hash
    AND s.status = 'pending'
    AND s."confirmExpiresAt" > v_now
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_sub."emailHmac" IS NOT NULL THEN
    INSERT INTO cartlify.newsletter_form_blocklist ("emailHmac", "byPerson", "createdAt")
    VALUES (v_sub."emailHmac", true, v_now)
    ON CONFLICT ("emailHmac") DO NOTHING;
  END IF;

  UPDATE cartlify.newsletter_subscriptions AS s
  SET
    status = 'ended',
    "confirmHash" = NULL,
    "confirmExpiresAt" = NULL,
    "endedAt" = v_now,
    "endReason" = 'not_me',
    "updatedAt" = v_now
  WHERE s.id = v_sub.id;

  DELETE FROM cartlify.newsletter_subscription_events AS e WHERE e."subscriptionId" = v_sub.id;

  DELETE FROM cartlify.newsletter_subscriptions AS s WHERE s.id = v_sub.id;

  RETURN true;
END;
$$;

-- The page "manage the subscription" shows the subscription behind the link of a mail:
-- p_manage_hash is the sha256 of the token of management. The link works while the subscription is
-- in force or paused by a complaint (the server derives the token of every mail from the salt of
-- the row); for a request that waits, an ended or a stopped subscription, and for a token nobody
-- was given, it is NEWSLETTER_LINK_INVALID. can_change_locale: only a subscription of the form has
-- its language changed here, the one of an account is changed in the profile.
CREATE OR REPLACE FUNCTION cartlify.newsletter_manage_get (p_manage_hash text) RETURNS TABLE (
  email text,
  source text,
  locale text,
  status text,
  can_change_locale boolean
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  RETURN QUERY
  SELECT s.email::text, s.source::text, s.locale::text, s.status::text, s.source = 'form'
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s."manageHash" = btrim(p_manage_hash) AND s.status IN ('active', 'paused_complaint');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_LINK_INVALID';
  END IF;
END;
$$;

-- Changes the language of a subscription of the form from the page of management. Returns true
-- when it changed, false when the subscription has that language already (nothing is written).
-- NEWSLETTER_LOCALE_INVALID: not two lower-case letters (the page cannot choose "no language");
-- NEWSLETTER_LOCALE_NOT_ALLOWED: the subscription is the one of an account (its language is
-- changed in the profile); NEWSLETTER_LINK_INVALID: no subscription in force behind the link. The
-- line of the journal is locale_changed, in the new language.
CREATE OR REPLACE FUNCTION cartlify.newsletter_manage_set_locale (
  p_manage_hash text,
  p_locale text,
  p_ip text,
  p_user_agent text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now timestamp := now() AT TIME ZONE 'UTC';
  v_sub cartlify.newsletter_subscriptions%ROWTYPE;
BEGIN
  IF p_locale IS NULL OR p_locale !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'NEWSLETTER_LOCALE_INVALID';
  END IF;

  SELECT s.*
  INTO v_sub
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s."manageHash" = btrim(p_manage_hash) AND s.status IN ('active', 'paused_complaint')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_LINK_INVALID';
  END IF;

  IF v_sub.source <> 'form' THEN
    RAISE EXCEPTION 'NEWSLETTER_LOCALE_NOT_ALLOWED';
  END IF;

  IF v_sub.locale IS NOT DISTINCT FROM p_locale THEN
    RETURN false;
  END IF;

  UPDATE cartlify.newsletter_subscriptions AS s
  SET
    locale = p_locale,
    "updatedAt" = v_now
  WHERE s.id = v_sub.id;

  PERFORM cartlify.newsletter_log_event (
    v_sub.id, 'locale_changed', 'manage_page', p_ip, p_user_agent, p_locale
  );

  RETURN true;
END;
$$;

-- Ends the subscription behind the link of management, from the page of management (the place is
-- manage_page, the only one this step takes: the button of the mail client has a token and a function
-- of its own, newsletter_unsubscribe_one_click). Returns true when it ended the subscription now;
-- false for a link whose subscription is not in force any more (ended already, stopped, or only a
-- request), so a second tap or a double submit changes nothing. NEWSLETTER_LINK_INVALID: a token
-- nobody was given; NEWSLETTER_PLACE_INVALID: any other place. p_campaign_id is the campaign whose
-- mail the person came from (newsletter_unsubscribe_subscription counts it).
CREATE OR REPLACE FUNCTION cartlify.newsletter_manage_unsubscribe (
  p_manage_hash text,
  p_campaign_id integer,
  p_place text,
  p_ip text,
  p_user_agent text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_sub cartlify.newsletter_subscriptions%ROWTYPE;
BEGIN
  IF p_place IS NULL OR p_place <> 'manage_page' THEN
    RAISE EXCEPTION 'NEWSLETTER_PLACE_INVALID';
  END IF;

  SELECT s.*
  INTO v_sub
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s."manageHash" = btrim(p_manage_hash)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_LINK_INVALID';
  END IF;

  IF v_sub.status NOT IN ('active', 'paused_complaint') THEN
    RETURN false;
  END IF;

  PERFORM cartlify.newsletter_unsubscribe_subscription (
    v_sub.id, p_campaign_id, p_place, p_ip, p_user_agent
  );

  RETURN true;
END;
$$;

-- The button of the mail client (RFC 8058, the one-click unsubscribe): p_unsubscribe_hash is the
-- sha256 of the token of the unsubscribe that every mail of the subscription carries in the header
-- List-Unsubscribe. It is a token of its own, made from the salt of the row with a mark of its own, and
-- opens this and nothing else: not the page of management, not its export, not the language. Ends the
-- subscription in force or paused, the place of the line of the journal being mail_client; returns true
-- when it ended it now, false for a link whose subscription is not in force any more, so a second press
-- changes nothing. NEWSLETTER_LINK_INVALID: a token nobody was given (the token of the page of
-- management is one). p_campaign_id is the campaign whose mail the person came from
-- (newsletter_unsubscribe_subscription counts it). Any actor: the token in the hand is the key.
CREATE OR REPLACE FUNCTION cartlify.newsletter_unsubscribe_one_click (
  p_unsubscribe_hash text,
  p_campaign_id integer,
  p_ip text,
  p_user_agent text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_sub cartlify.newsletter_subscriptions%ROWTYPE;
BEGIN
  SELECT s.*
  INTO v_sub
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s."unsubscribeHash" = btrim(p_unsubscribe_hash)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_LINK_INVALID';
  END IF;

  IF v_sub.status NOT IN ('active', 'paused_complaint') THEN
    RETURN false;
  END IF;

  PERFORM cartlify.newsletter_unsubscribe_subscription (
    v_sub.id, p_campaign_id, 'mail_client', p_ip, p_user_agent
  );

  RETURN true;
END;
$$;

-- Puts a subscription paused by a complaint back in force, from the page of management. Returns
-- true when it did, false when the subscription was in force already. The line of the journal is
-- restored. (The server takes the address off the list of complaints of the provider.)
-- NEWSLETTER_LINK_INVALID: no subscription in force or paused behind the link.
CREATE OR REPLACE FUNCTION cartlify.newsletter_manage_resume (
  p_manage_hash text,
  p_ip text,
  p_user_agent text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now timestamp := now() AT TIME ZONE 'UTC';
  v_sub cartlify.newsletter_subscriptions%ROWTYPE;
BEGIN
  SELECT s.*
  INTO v_sub
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s."manageHash" = btrim(p_manage_hash) AND s.status IN ('active', 'paused_complaint')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_LINK_INVALID';
  END IF;

  IF v_sub.status = 'active' THEN
    RETURN false;
  END IF;

  UPDATE cartlify.newsletter_subscriptions AS s
  SET
    status = 'active',
    "updatedAt" = v_now
  WHERE s.id = v_sub.id;

  PERFORM cartlify.newsletter_log_event (
    v_sub.id, 'restored', 'manage_page', p_ip, p_user_agent, v_sub.locale
  );

  RETURN true;
END;
$$;

-- The data of the subscription behind the link and its journal, for the person to download:
-- {"subscriptions": [one]} (newsletter_export_subscriptions). NEWSLETTER_LINK_INVALID: no
-- subscription in force or paused behind the link.
CREATE OR REPLACE FUNCTION cartlify.newsletter_manage_export (p_manage_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_id integer;
BEGIN
  SELECT s.id
  INTO v_id
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s."manageHash" = btrim(p_manage_hash) AND s.status IN ('active', 'paused_complaint');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_LINK_INVALID';
  END IF;

  RETURN cartlify.newsletter_export_subscriptions (ARRAY[v_id]);
END;
$$;

-- An account subscribes its own address (from the profile, or at the registration). The owner of
-- the account or the system calls it (NEWSLETTER_FORBIDDEN); the address is the one of the account
-- and must be verified (NEWSLETTER_EMAIL_NOT_VERIFIED). The blocklist is for the form and is not
-- asked here. Returns
--   created    the address had no live subscription: a subscription of the account, in force at once;
--   converted  a request of the form was waiting on the address: it becomes the subscription of the
--              account in the same row (the history stays, the language is the one given here, and
--              the new salt and hash of the link of management replace the old, never mailed);
--   already    the address has a subscription in force or paused (of the form or of the account):
--              nothing changes.
-- p_manage_salt, p_manage_hash and p_unsubscribe_hash are the salt, the sha256 of the token of
-- management and the sha256 of the token of the unsubscribe the server derived for a new subscription
-- (or for the one a request is turned into); p_place is profile or registration
-- (NEWSLETTER_PLACE_INVALID);
-- p_locale is two lower-case letters or empty for no language (NEWSLETTER_LOCALE_INVALID). The
-- line of the journal is subscribed, with the version of the privacy policy.
CREATE OR REPLACE FUNCTION cartlify.newsletter_subscribe_account (
  p_user_id integer,
  p_locale text,
  p_manage_salt text,
  p_manage_hash text,
  p_unsubscribe_hash text,
  p_place text,
  p_ip text,
  p_user_agent text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := now() AT TIME ZONE 'UTC';
  v_email text := cartlify.newsletter_account_email (p_user_id);
  v_sub   cartlify.newsletter_subscriptions%ROWTYPE;
  v_id    integer;
BEGIN
  IF p_place IS NULL OR p_place NOT IN ('profile', 'registration') THEN
    RAISE EXCEPTION 'NEWSLETTER_PLACE_INVALID';
  END IF;

  IF p_locale IS NOT NULL AND p_locale !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'NEWSLETTER_LOCALE_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.' || v_email));

  SELECT s.*
  INTO v_sub
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s.email = v_email AND s.status IN ('pending', 'active', 'paused_complaint')
  FOR UPDATE;

  IF FOUND THEN
    IF v_sub.status <> 'pending' THEN
      RETURN 'already';
    END IF;

    UPDATE cartlify.newsletter_subscriptions AS s
    SET
      source = 'account',
      "userId" = p_user_id,
      "emailHmac" = NULL,
      locale = p_locale,
      status = 'active',
      "confirmHash" = NULL,
      "confirmExpiresAt" = NULL,
      "confirmedAt" = v_now,
      "manageSalt" = p_manage_salt,
      "manageHash" = p_manage_hash,
      "unsubscribeHash" = p_unsubscribe_hash,
      "updatedAt" = v_now
    WHERE s.id = v_sub.id;

    PERFORM cartlify.newsletter_log_event (v_sub.id, 'subscribed', p_place, p_ip, p_user_agent, p_locale);

    RETURN 'converted';
  END IF;

  INSERT INTO cartlify.newsletter_subscriptions (
    email,
    "userId",
    source,
    locale,
    status,
    "manageSalt",
    "manageHash",
    "unsubscribeHash",
    "confirmedAt",
    "createdAt",
    "updatedAt"
  )
  VALUES (
    v_email,
    p_user_id,
    'account',
    p_locale,
    'active',
    p_manage_salt,
    p_manage_hash,
    p_unsubscribe_hash,
    v_now,
    v_now,
    v_now
  )
  RETURNING id INTO v_id;

  PERFORM cartlify.newsletter_log_event (v_id, 'subscribed', p_place, p_ip, p_user_agent, p_locale);

  RETURN 'created';
END;
$$;

-- The subscription in force (or paused by a complaint) on the address of the account, whether the
-- account made it or the form did; no row when there is none (a request that waits is not one
-- yet). can_change_locale: the language of a subscription of the account is changed here, the one
-- of the form on its page of management. subscribed_at: when it came into force (utc). The owner
-- of the account or the system (NEWSLETTER_FORBIDDEN), an address the account proved
-- (NEWSLETTER_EMAIL_NOT_VERIFIED).
CREATE OR REPLACE FUNCTION cartlify.newsletter_profile_get (p_user_id integer) RETURNS TABLE (
  source text,
  locale text,
  status text,
  can_change_locale boolean,
  subscribed_at timestamp
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_email text := cartlify.newsletter_account_email (p_user_id);
BEGIN
  RETURN QUERY
  SELECT
    s.source::text,
    s.locale::text,
    s.status::text,
    s.source = 'account',
    COALESCE(s."confirmedAt", s."createdAt")
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s.email = v_email AND s.status IN ('active', 'paused_complaint');
END;
$$;

-- Ends the subscription in force (or paused) on the address of the account, whichever made it.
-- Returns true when it ended one, false when there was none (a request that waits is not ended
-- here). Afterwards the profile can subscribe the account anew (newsletter_subscribe_account). The
-- line of the journal is unsubscribed, at the profile. The owner of the account or the system
-- (NEWSLETTER_FORBIDDEN), an address the account proved (NEWSLETTER_EMAIL_NOT_VERIFIED).
CREATE OR REPLACE FUNCTION cartlify.newsletter_profile_unsubscribe (
  p_user_id integer,
  p_ip text,
  p_user_agent text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_email text := cartlify.newsletter_account_email (p_user_id);
  v_id    integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.' || v_email));

  SELECT s.id
  INTO v_id
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s.email = v_email AND s.status IN ('active', 'paused_complaint')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM cartlify.newsletter_end_subscription (
    v_id, 'unsubscribed', 'unsubscribed', 'profile', p_ip, p_user_agent
  );

  RETURN true;
END;
$$;

-- Changes the language of the subscription of the account from the profile. Returns true when it
-- changed, false when there is no subscription in force or it has that language already (nothing is
-- written). The language of a subscription made by the form is changed on its page of management
-- only (NEWSLETTER_LOCALE_NOT_ALLOWED). NEWSLETTER_LOCALE_INVALID: not two lower-case letters. The
-- owner of the account or the system (NEWSLETTER_FORBIDDEN), an address the account proved
-- (NEWSLETTER_EMAIL_NOT_VERIFIED). The line of the journal is locale_changed, in the new language.
CREATE OR REPLACE FUNCTION cartlify.newsletter_profile_set_locale (
  p_user_id integer,
  p_locale text,
  p_ip text,
  p_user_agent text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := now() AT TIME ZONE 'UTC';
  v_email text := cartlify.newsletter_account_email (p_user_id);
  v_sub   cartlify.newsletter_subscriptions%ROWTYPE;
BEGIN
  IF p_locale IS NULL OR p_locale !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'NEWSLETTER_LOCALE_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.' || v_email));

  SELECT s.*
  INTO v_sub
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s.email = v_email AND s.status IN ('active', 'paused_complaint')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_sub.source <> 'account' THEN
    RAISE EXCEPTION 'NEWSLETTER_LOCALE_NOT_ALLOWED';
  END IF;

  IF v_sub.locale IS NOT DISTINCT FROM p_locale THEN
    RETURN false;
  END IF;

  UPDATE cartlify.newsletter_subscriptions AS s
  SET
    locale = p_locale,
    "updatedAt" = v_now
  WHERE s.id = v_sub.id;

  PERFORM cartlify.newsletter_log_event (v_sub.id, 'locale_changed', 'profile', p_ip, p_user_agent, p_locale);

  RETURN true;
END;
$$;

-- Puts the subscription paused by a complaint back in force, from the profile. Returns true when
-- it did, false when there is none paused. The line of the journal is restored. (The server takes
-- the address off the list of complaints of the provider.) The owner of the account or the system
-- (NEWSLETTER_FORBIDDEN), an address the account proved (NEWSLETTER_EMAIL_NOT_VERIFIED).
CREATE OR REPLACE FUNCTION cartlify.newsletter_profile_resume (
  p_user_id integer,
  p_ip text,
  p_user_agent text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := now() AT TIME ZONE 'UTC';
  v_email text := cartlify.newsletter_account_email (p_user_id);
  v_sub   cartlify.newsletter_subscriptions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.' || v_email));

  SELECT s.*
  INTO v_sub
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s.email = v_email AND s.status = 'paused_complaint'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE cartlify.newsletter_subscriptions AS s
  SET
    status = 'active',
    "updatedAt" = v_now
  WHERE s.id = v_sub.id;

  PERFORM cartlify.newsletter_log_event (v_sub.id, 'restored', 'profile', p_ip, p_user_agent, v_sub.locale);

  RETURN true;
END;
$$;

-- The data of every subscription of the account that the person confirmed, with its journal, for the
-- export of the account: {"subscriptions": [...]}, oldest first (newsletter_export_subscriptions; a
-- request that was never confirmed is not given). The subscriptions are those the address of the
-- account has had (in force, ended, stopped), those that belong to the account (userId) and those of
-- the form that its deletion ended (endedUserId), which is how a deleted account, whose address is
-- not its own any more, is found. The owner of the account or the system (NEWSLETTER_FORBIDDEN, also
-- for an account that does not exist); an account that is not deleted must have proved its address
-- (NEWSLETTER_EMAIL_NOT_VERIFIED), a deleted one is looked up by its id only.
CREATE OR REPLACE FUNCTION cartlify.newsletter_profile_export (p_user_id integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_deleted timestamp;
  v_email   text;
BEGIN
  IF NOT (cartlify.is_system() OR cartlify.is_owner(p_user_id)) THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  SELECT u."deletedAt"
  INTO v_deleted
  FROM cartlify.users AS u
  WHERE u.id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  IF v_deleted IS NULL THEN
    v_email := cartlify.newsletter_account_email (p_user_id);
  END IF;

  RETURN cartlify.newsletter_export_subscriptions (
    ARRAY(
      SELECT s.id
      FROM cartlify.newsletter_subscriptions AS s
      WHERE s."userId" = p_user_id
         OR s."endedUserId" = p_user_id
         OR (v_email IS NOT NULL AND s.email = v_email)
      ORDER BY s.id
    )
  );
END;
$$;

-- The account is going away: ends what is in force (or paused) on its address, a subscription of
-- the account and one of the form alike (the journal line is account_deleted; the reason of the end
-- is account_deleted). The subscription of the form it ends names the account (endedUserId), as the
-- address will not be the account's after the deletion and the export of the deleted account finds
-- the subscription by it. Returns how many it ended. The email comes from users, so call it before the
-- email is made anonymous. A request that waits is left to its three days. The subscription of the
-- form sits on the address, not on the account, so it is ended only when the account proved the
-- address (an unverified account ends only what is its own). Callable by the owner of the account
-- (the line says profile), the system (system) and an admin or root with an id (admin, with their
-- id on the line); anyone else is NEWSLETTER_FORBIDDEN. An account that does not exist ends nothing.
CREATE OR REPLACE FUNCTION cartlify.newsletter_end_for_account (p_user_id integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_email    text;
  v_verified boolean;
  v_place    text;
  v_actor    integer;
  v_count    integer := 0;
  v_row      record;
BEGIN
  IF cartlify.is_owner(p_user_id) THEN
    v_place := 'profile';
  ELSIF cartlify.is_system() THEN
    v_place := 'system';
  ELSIF cartlify.is_admin() AND cartlify.current_actor_id() IS NOT NULL THEN
    v_place := 'admin';
    v_actor := cartlify.current_actor_id();
  ELSE
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  SELECT lower(btrim(u.email)), u."isVerified"
  INTO v_email, v_verified
  FROM cartlify.users AS u
  WHERE u.id = p_user_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.' || v_email));

  FOR v_row IN
    SELECT s.id, s.source
    FROM cartlify.newsletter_subscriptions AS s
    WHERE s.status IN ('active', 'paused_complaint')
      AND (s."userId" = p_user_id OR (v_verified AND s.email = v_email))
    ORDER BY s.id
    FOR UPDATE
  LOOP
    PERFORM cartlify.newsletter_end_subscription (
      v_row.id,
      'account_deleted',
      'account_deleted',
      v_place,
      NULL,
      NULL,
      NULL,
      v_actor,
      CASE WHEN v_row.source = 'form' THEN p_user_id END
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

------------------------------------------------------------
-- NEWSLETTERS: THE WEBHOOK, THE PEOPLE WHO RUN THEM, ROOT
------------------------------------------------------------
-- What SendGrid tells (newsletter_apply_event: the system), what the people who run the newsletters
-- do to the subscribers and to the blocklist (newsletter_admin_erase_address, newsletter_block_add:
-- a manager, i.e. root or an admin root allowed), and what only root does (newsletter_set_manager,
-- newsletter_locale_counts, newsletter_reset_locale). Each is a function that runs as the owner and
-- checks the actor itself (NEWSLETTER_FORBIDDEN). Taking an address off the blocklist is not a
-- function: a manager deletes the row, the policy of db/03 allows it. The cleanups of the retention
-- terms are with the others, above.

-- Removes a subscription and everything of it: a subscription that is live or in force is ended
-- first, with the reason given (the guard of the journal lets a line go only with an ended or
-- stopped subscription), then the lines of its journal and the row go, the mails of its campaigns
-- with it. Nothing is kept: the step for a request that was never confirmed (its address was
-- blocked). Internal step: runs with the rights of the caller,
-- which is a function of the newsletters running as the owner; the app has no execute right (db/01).
CREATE OR REPLACE FUNCTION cartlify.newsletter_erase_subscription (
  p_subscription_id integer,
  p_reason text
) RETURNS void LANGUAGE plpgsql
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now timestamp := now() AT TIME ZONE 'UTC';
BEGIN
  UPDATE cartlify.newsletter_subscriptions AS s
  SET
    status = 'ended',
    "confirmHash" = NULL,
    "confirmExpiresAt" = NULL,
    "endedAt" = v_now,
    "endReason" = p_reason::cartlify."NewsletterEndReason",
    "updatedAt" = v_now
  WHERE s.id = p_subscription_id AND s.status IN ('pending', 'active', 'paused_complaint');

  DELETE FROM cartlify.newsletter_subscription_events AS e WHERE e."subscriptionId" = p_subscription_id;

  DELETE FROM cartlify.newsletter_subscriptions AS s WHERE s.id = p_subscription_id;
END;
$$;

-- An event of SendGrid about a mail of a campaign, by the id of the row of the mail (the server
-- puts it into the mail, custom_args). Only the system reports (NEWSLETTER_FORBIDDEN). The event is
-- one of bounce (the address does not exist), dropped (SendGrid did not deliver) and spamreport
-- (the person marked the mail as spam); any other is NEWSLETTER_EVENT_INVALID, whoever the mail is.
-- Returns applied, or unknown for a mail this database has no row for, or one that SendGrid refused
-- (it has no outcome: the event is of some other mail, e.g. of another environment on the same
-- account of SendGrid) - never an error. A mail that waits (queued) counts as sent: SendGrid tells
-- of a mail only after it took it, and it can tell before the sending has written down that it
-- did (a bounce comes within a second), so the event is not lost; the row then gets the time the
-- event came as the time it was sent, which the check of the table wants of a mail with an
-- outcome (the sending that comes late writes only a row that still waits). What an event does:
--   bounce: the mail is bounced, the subscription stops (stopped_bounce, the reason bounced, a line
--     bounced from the webhook) if it is in force or paused, the campaign counts it as undelivered;
--   dropped: the mail is dropped and counted as undelivered; the subscription stays - unless
--     SendGrid says why (p_reason, the text of its report) and the reason is that the address is one it
--     knows as bounced ("Bounced Address") or as one that reports spam ("Spam Reporting Address", in
--     any case): then the subscription is dealt with as the event of that reason would deal with it
--     (the bounce below, the report below), and the campaign still counts the mail as undelivered, not
--     as a complaint; any other reason, or none, leaves the subscription;
--   spamreport: the mail is complained about and counted as a complaint, a subscription in force is
--     paused (paused_complaint, a line complaint); one that is paused already, ended or stopped is
--     left as it is.
-- The reason is read for the event dropped only; on the others it is ignored.
-- The first outcome of a mail is its outcome: an event for a mail that is bounced, dropped or
-- complained about already, the same again (SendGrid sends an event twice when a batch fails) or
-- another one, changes nothing and still answers applied, so nothing is counted twice. A
-- subscription that ended or stopped meanwhile is not touched (no line, no error), the mail and the
-- campaign are still told. The lines name the campaign whose mail caused them. Locks: the
-- subscription, then the mail, then the campaign, the order of the steps of a person.
CREATE OR REPLACE FUNCTION cartlify.newsletter_apply_event (
  p_recipient_id integer,
  p_event text,
  p_reason text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now       timestamp := now() AT TIME ZONE 'UTC';
  v_sub_id    integer;
  v_sub       cartlify.newsletter_subscriptions%ROWTYPE;
  v_recipient cartlify.newsletter_recipients%ROWTYPE;
  v_reason    text := lower(btrim(p_reason));
  -- what the event does to the subscription: the event itself, or the event its reason stands for
  v_effect    text;
BEGIN
  IF NOT cartlify.is_system() THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  IF p_event IS NULL OR p_event NOT IN ('bounce', 'dropped', 'spamreport') THEN
    RAISE EXCEPTION 'NEWSLETTER_EVENT_INVALID';
  END IF;

  v_effect := CASE
    WHEN p_event = 'dropped' AND v_reason = 'bounced address' THEN 'bounce'
    WHEN p_event = 'dropped' AND v_reason = 'spam reporting address' THEN 'spamreport'
    ELSE p_event
  END;

  SELECT r."subscriptionId" INTO v_sub_id FROM cartlify.newsletter_recipients AS r WHERE r.id = p_recipient_id;

  IF NOT FOUND THEN
    RETURN 'unknown';
  END IF;

  SELECT s.* INTO v_sub FROM cartlify.newsletter_subscriptions AS s WHERE s.id = v_sub_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'unknown';
  END IF;

  SELECT r.* INTO v_recipient FROM cartlify.newsletter_recipients AS r WHERE r.id = p_recipient_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'unknown';
  END IF;

  IF v_recipient.status IN ('bounced', 'dropped', 'complained') THEN
    RETURN 'applied';
  END IF;

  IF v_recipient.status NOT IN ('queued', 'sent') THEN
    RETURN 'unknown';
  END IF;

  UPDATE cartlify.newsletter_recipients AS r
  SET
    status = (
      CASE p_event WHEN 'bounce' THEN 'bounced' WHEN 'dropped' THEN 'dropped' ELSE 'complained' END
    )::cartlify."NewsletterRecipientStatus",
    "sentAt" = coalesce(r."sentAt", v_now),
    "updatedAt" = v_now
  WHERE r.id = v_recipient.id;

  UPDATE cartlify.newsletter_campaigns AS c
  SET
    "undeliveredCount" = c."undeliveredCount" + CASE WHEN p_event = 'spamreport' THEN 0 ELSE 1 END,
    "complaintCount" = c."complaintCount" + CASE WHEN p_event = 'spamreport' THEN 1 ELSE 0 END,
    "updatedAt" = v_now
  WHERE c.id = v_recipient."campaignId";

  IF v_effect = 'bounce' AND v_sub.status IN ('active', 'paused_complaint') THEN
    UPDATE cartlify.newsletter_subscriptions AS s
    SET
      status = 'stopped_bounce',
      "confirmHash" = NULL,
      "confirmExpiresAt" = NULL,
      "endedAt" = v_now,
      "endReason" = 'bounced',
      "updatedAt" = v_now
    WHERE s.id = v_sub.id;

    PERFORM cartlify.newsletter_log_event (
      v_sub.id, 'bounced', 'webhook', NULL, NULL, v_sub.locale, v_recipient."campaignId"
    );
  ELSIF v_effect = 'spamreport' AND v_sub.status = 'active' THEN
    UPDATE cartlify.newsletter_subscriptions AS s
    SET
      status = 'paused_complaint',
      "updatedAt" = v_now
    WHERE s.id = v_sub.id;

    PERFORM cartlify.newsletter_log_event (
      v_sub.id, 'complaint', 'webhook', NULL, NULL, v_sub.locale, v_recipient."campaignId"
    );
  END IF;

  RETURN 'applied';
END;
$$;

-- An admin erases an address on the word of the person (the request comes to support@): every
-- subscription the address ever had is made anonymous in place, and the row stays as the proof that
-- there was a consent (the dates, the states and the lines of the journal remain), without a trace of
-- who gave it. For each row of the address, whatever its state:
--   the address becomes the placeholder of the row (newsletter_erased_email), the HMAC of the address
--     and the confirmation link are emptied, the account that ended it is forgotten;
--   the salt and the hashes of the links of management and of the unsubscribe are replaced by random
--     ones that nobody holds, so no link of a mail the address was sent opens anything;
--   what is live (waiting, in force, paused) ends, with the reason removed_by_admin and the time now;
--     one that ended or was stopped keeps its state, its reason and its time;
--   the address and the browser of every line of its journal are emptied.
-- What the mails of the campaigns say of the row, the totals, and the blocklist are not touched: the
-- blocklist holds the HMAC of an address that asked for no more mail, which still should not get any.
-- A mail of a campaign still waiting to be sent to a subscription that ended is left out by the
-- sending. Only a manager (NEWSLETTER_FORBIDDEN, before the id is looked at). The id names any row of
-- the address; the rows are the ones that have the address of that row, and a row that is anonymous
-- already is not done again. Returns how many rows it made anonymous: 0 for an id this database has no
-- subscription for, or for an address that was erased already. The step takes the lock of the address
-- (the one every step on it takes) and then its rows, in the order of their ids.
CREATE OR REPLACE FUNCTION cartlify.newsletter_admin_erase_address (p_subscription_id integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now   timestamp := now() AT TIME ZONE 'UTC';
  v_email text;
  v_row   record;
  v_count integer := 0;
BEGIN
  IF NOT cartlify.newsletter_manager() THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  SELECT s.email INTO v_email FROM cartlify.newsletter_subscriptions AS s WHERE s.id = p_subscription_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.' || v_email));

  FOR v_row IN
    SELECT s.id
    FROM cartlify.newsletter_subscriptions AS s
    WHERE s.email = v_email AND s.email <> cartlify.newsletter_erased_email (s.id)
    ORDER BY s.id
    FOR UPDATE
  LOOP
    UPDATE cartlify.newsletter_subscriptions AS s
    SET
      email = cartlify.newsletter_erased_email (s.id),
      "emailHmac" = NULL,
      "confirmHash" = NULL,
      "confirmExpiresAt" = NULL,
      "endedUserId" = NULL,
      "manageSalt" = cartlify.newsletter_random_hex (),
      "manageHash" = cartlify.newsletter_random_hex (),
      "unsubscribeHash" = cartlify.newsletter_random_hex (),
      status = (
        CASE WHEN s.status IN ('pending', 'active', 'paused_complaint') THEN 'ended' ELSE s.status END
      )::cartlify."NewsletterSubscriptionStatus",
      "endedAt" = coalesce(s."endedAt", v_now),
      "endReason" = coalesce(s."endReason", 'removed_by_admin'::cartlify."NewsletterEndReason"),
      "updatedAt" = v_now
    WHERE s.id = v_row.id;

    UPDATE cartlify.newsletter_subscription_events AS e
    SET
      ip = NULL,
      "userAgent" = NULL
    WHERE e."subscriptionId" = v_row.id AND (e.ip IS NOT NULL OR e."userAgent" IS NOT NULL);

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- A manager blocks an address for the public form, on the word of the person: p_email_hmac is the
-- HMAC the server makes of the address (of the address trimmed and in lower case, the way this
-- database keeps it: newsletter_request lower-cases and trims the address itself, and the HMAC of
-- the server must be of the same text), p_reason a note (trimmed, cut to the 200 characters the
-- column holds, trimmed again where the cut fell on a space; empty is none). The entry names
-- the admin (blockedById is the actor, so root needs an account: NEWSLETTER_FORBIDDEN for root
-- without one, as for anybody who is not a manager). A request of that address that waits for its
-- confirmation is ended and removed with its journal, the way "this was not me" does (the button of
-- the mail it sent stops working); a subscription in force stays, the blocklist is for new
-- requests. An address that is blocked already is no error: the first entry stays, the waiting
-- request is removed all the same. Returns true when the entry was made now, false when it was
-- there. A value that is no HMAC is refused by the check of the table (23514). Taking the address
-- off the list is a DELETE of a manager (the policy of db/03). The step holds the lock of the HMAC
-- (the one newsletter_request and newsletter_not_me take before the lock of the address) from the
-- entry to its commit, so a request of the address that is made at the same time is either made
-- before the step and removed by it, or after it and answered with nothing: it cannot slip past.
CREATE OR REPLACE FUNCTION cartlify.newsletter_block_add (
  p_email_hmac text,
  p_reason text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_actor integer := cartlify.current_actor_id();
  v_added integer;
  v_row   record;
BEGIN
  IF NOT cartlify.newsletter_manager() OR v_actor IS NULL THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.hmac.' || coalesce(p_email_hmac, '')));

  INSERT INTO cartlify.newsletter_form_blocklist ("emailHmac", "blockedById", "byPerson", reason, "createdAt")
  VALUES (
    p_email_hmac,
    v_actor,
    false,
    nullif(btrim(left(btrim(p_reason), 200)), ''),
    now() AT TIME ZONE 'UTC'
  )
  ON CONFLICT ("emailHmac") DO NOTHING;

  GET DIAGNOSTICS v_added = ROW_COUNT;

  FOR v_row IN
    SELECT s.id, s.email
    FROM cartlify.newsletter_subscriptions AS s
    WHERE s."emailHmac" = p_email_hmac AND s.status = 'pending'
    ORDER BY s.id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter.' || v_row.email));

    PERFORM 1
    FROM cartlify.newsletter_subscriptions AS s
    WHERE s.id = v_row.id AND s.status = 'pending'
    FOR UPDATE;

    IF FOUND THEN
      PERFORM cartlify.newsletter_erase_subscription (v_row.id, 'removed_by_admin');
    END IF;
  END LOOP;

  RETURN v_added > 0;
END;
$$;

-- Root allows an admin to run the newsletters (p_value true) or takes the right away (false; no
-- value is false). Only root (NEWSLETTER_FORBIDDEN), also without an account. The right is the
-- column users."canManageNewsletters", which no statement of anybody changes (the guard of users,
-- db/05): this function runs as the owner for root, the one step the guard lets through. Allowing
-- an account that is not an admin, one that was deleted or one that does not exist is
-- NEWSLETTER_TARGET_NOT_ADMIN; taking the right away is allowed for any id and harmless. The right
-- is read from the database on every call (newsletter_manager), so it works and stops at once, in an
-- open session too. Returns true when the right changed, false when it was as asked. The line of the
-- audit log is the server's to write, and only when this says true.
CREATE OR REPLACE FUNCTION cartlify.newsletter_set_manager (
  p_admin_id integer,
  p_value boolean
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_on   boolean := coalesce(p_value, false);
  v_user record;
BEGIN
  IF NOT cartlify.is_root() THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  SELECT u.role, u."canManageNewsletters" AS allowed, u."deletedAt" AS deleted
  INTO v_user
  FROM cartlify.users AS u
  WHERE u.id = p_admin_id
  FOR UPDATE;

  IF NOT FOUND THEN
    IF v_on THEN
      RAISE EXCEPTION 'NEWSLETTER_TARGET_NOT_ADMIN';
    END IF;

    RETURN false;
  END IF;

  IF v_on AND (v_user.role <> 'ADMIN' OR v_user.deleted IS NOT NULL) THEN
    RAISE EXCEPTION 'NEWSLETTER_TARGET_NOT_ADMIN';
  END IF;

  IF v_user.allowed = v_on THEN
    RETURN false;
  END IF;

  UPDATE cartlify.users AS u
  SET
    "canManageNewsletters" = v_on,
    "updatedAt" = now() AT TIME ZONE 'UTC'
  WHERE u.id = p_admin_id;

  RETURN true;
END;
$$;

-- How many accounts and subscriptions have each language, for the warning root sees before turning
-- a language off. Only root (NEWSLETTER_FORBIDDEN). One row for each language that at least one
-- account that is not deleted or one subscription that is not ended has (waiting, in force, paused
-- or stopped by a bounce: an ended one is frozen as the proof of the consent and keeps its
-- language), in the order of the codes; the people with no language are no row.
CREATE OR REPLACE FUNCTION cartlify.newsletter_locale_counts () RETURNS TABLE (
  locale text,
  accounts integer,
  subscriptions integer
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
BEGIN
  IF NOT cartlify.is_root() THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  RETURN QUERY
  WITH of_accounts AS (
    SELECT u.locale::text AS code, count(*) AS n
    FROM cartlify.users AS u
    WHERE u."deletedAt" IS NULL AND u.locale IS NOT NULL
    GROUP BY u.locale
  ),
  of_subscriptions AS (
    SELECT s.locale::text AS code, count(*) AS n
    FROM cartlify.newsletter_subscriptions AS s
    WHERE s.status <> 'ended' AND s.locale IS NOT NULL
    GROUP BY s.locale
  )
  SELECT
    coalesce(a.code, b.code),
    coalesce(a.n, 0)::integer,
    coalesce(b.n, 0)::integer
  FROM of_accounts AS a
  FULL OUTER JOIN of_subscriptions AS b ON b.code = a.code
  ORDER BY 1;
END;
$$;

-- Root turned a language off: every account that is not deleted, and every subscription that is not
-- ended, with that language is left with none (the language of the shop is used for its mails). One
-- line of the journal of each subscription says so (locale_reset, from the admin place, with the id
-- of root). An ended subscription is frozen and keeps its language. Only root (NEWSLETTER_FORBIDDEN);
-- NEWSLETTER_LOCALE_INVALID for a code that is not two lower-case letters;
-- NEWSLETTER_LOCALE_STILL_ENABLED for a language that is still turned on or is the language of the
-- shop: the current value of the settings enabledLocales and shopLocale (the latest row of the key
-- in shop_settings) is read here, so the step is taken after the setting without the language is
-- written, in the same transaction, and a language in use is never emptied. With no row of a key
-- the key holds nothing. Everything in one call, so one transaction: the accounts and the
-- subscriptions change together or not at all. Returns how many accounts and subscriptions it
-- changed. The language that returns later brings no one back.
CREATE OR REPLACE FUNCTION cartlify.newsletter_reset_locale (p_locale text) RETURNS TABLE (
  accounts integer,
  subscriptions integer
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now     timestamp := now() AT TIME ZONE 'UTC';
  v_actor   integer := cartlify.current_actor_id();
  v_enabled jsonb;
  v_shop    jsonb;
BEGIN
  IF NOT cartlify.is_root() THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  IF p_locale IS NULL OR p_locale !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'NEWSLETTER_LOCALE_INVALID';
  END IF;

  SELECT s.value INTO v_enabled
  FROM cartlify.shop_settings AS s WHERE s.key = 'enabledLocales' ORDER BY s.id DESC LIMIT 1;

  SELECT s.value INTO v_shop
  FROM cartlify.shop_settings AS s WHERE s.key = 'shopLocale' ORDER BY s.id DESC LIMIT 1;

  IF coalesce(v_enabled @> to_jsonb(p_locale), false) OR coalesce(v_shop @> to_jsonb(p_locale), false) THEN
    RAISE EXCEPTION 'NEWSLETTER_LOCALE_STILL_ENABLED';
  END IF;

  UPDATE cartlify.users AS u
  SET
    locale = NULL,
    "updatedAt" = v_now
  WHERE u.locale = p_locale AND u."deletedAt" IS NULL;

  GET DIAGNOSTICS accounts = ROW_COUNT;

  WITH changed AS (
    UPDATE cartlify.newsletter_subscriptions AS s
    SET
      locale = NULL,
      "updatedAt" = v_now
    WHERE s.locale = p_locale AND s.status <> 'ended'
    RETURNING s.id
  ),
  logged AS (
    INSERT INTO cartlify.newsletter_subscription_events (
      "subscriptionId", event, place, ip, "userAgent", locale, "campaignId", "privacyVersion", "actorId", "createdAt"
    )
    SELECT
      c.id,
      'locale_reset'::cartlify."NewsletterEventKind",
      'admin'::cartlify."NewsletterEventPlace",
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      v_actor,
      v_now
    FROM changed AS c
    RETURNING 1
  )
  SELECT count(*)::integer INTO subscriptions FROM changed;

  RETURN NEXT;
END;
$$;

------------------------------------------------------------
-- NEWSLETTERS: THE SENDING
------------------------------------------------------------
-- The system (the admin context without a user id) sends the newsletters in passes
-- (src/jobs/newsletterPass.job.ts). A pass starts the campaigns whose time has come, takes the mails
-- that wait in portions, sends each one and writes how it went. Three steps are functions of the
-- database, because they take rows other sessions may take too, or touch tables the system may only
-- read: starting a campaign (newsletter_start_campaign), taking a portion of the mails
-- (newsletter_claim_recipients) and giving back the ones a pass did not send
-- (newsletter_release_recipients). The queue goes by the tries a mail has used, the fewest first, and by
-- id among the same: a mail that was refused, or found the provider busy, comes back behind the mails not
-- tried yet, so a few mails the provider refuses for themselves cannot keep the rest of a campaign
-- from going. The outcome of a mail is a plain update of the system (the policies
-- of db/03, the guard above). All three are for the system only (NEWSLETTER_FORBIDDEN).

-- Starts a scheduled campaign: it becomes sending, with the moment of the start, the data of the
-- products taken for it (p_snapshot, an object) and the number of mails planned; every subscription
-- in force now gets a row of a mail that waits (queued). A subscription made later, or one that is
-- paused, stopped or ended, gets none: the people are fixed at this moment. The language of a row is
-- the language of the subscription, the language of the shop (p_shop_locale) for one with none, as
-- long as the campaign has a subject in it; when it has not, the campaign's own rule decides:
-- shop_locale gives the person the language of the shop (if the campaign has a subject in it), skip
-- gives no row. The people are listed in the order of their subscriptions. The lock planning takes
-- (cartlify.newsletter_schedule) is taken first, so a start and a planning never read the limit of
-- the campaigns at the same time. The campaign is locked, so two starts at once give one winner; the
-- loser finds it already sending. The time (scheduledAt) is not checked here: the pass chooses the
-- campaigns whose time has come. The limit of the campaigns is not asked: a campaign that was
-- scheduled goes out. Returns the number of mails planned.
-- The subscriptions in force are locked for the start with a share lock on the key (FOR KEY SHARE):
-- a step that removes one, or replaces its links (the erasing of an address), waits for the start to
-- commit instead of taking the row from under the mails being made - which would end the start in the
-- foreign key of a mail (23503) - and a start that comes after such a step does not see the row in
-- force any more. A step that only changes the state, the language or a mark of the row does not
-- wait. The locks go after the lock of planning and before the lock of the campaign, the order of
-- the steps of a person (the subscription, then the campaign), so a person who unsubscribes naming
-- the campaign cannot wait for it while the start waits for them.
-- NEWSLETTER_LOCALE_INVALID: the language of the shop is not two lower-case letters;
-- NEWSLETTER_SNAPSHOT_INVALID: the data of the products is not an object;
-- NEWSLETTER_CAMPAIGN_NOT_FOUND: no such campaign;
-- NEWSLETTER_CAMPAIGN_NOT_SCHEDULED: it is not scheduled any more (cancelled, started, still a draft).
CREATE OR REPLACE FUNCTION cartlify.newsletter_start_campaign (
  p_campaign_id integer,
  p_snapshot jsonb,
  p_shop_locale text
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now      timestamp := now() AT TIME ZONE 'UTC';
  v_campaign cartlify.newsletter_campaigns%ROWTYPE;
  v_subjects jsonb;
  v_count    integer;
BEGIN
  IF NOT cartlify.is_system() THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  IF p_shop_locale IS NULL OR p_shop_locale !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'NEWSLETTER_LOCALE_INVALID';
  END IF;

  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'NEWSLETTER_SNAPSHOT_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cartlify.newsletter_schedule'));

  PERFORM 1
  FROM cartlify.newsletter_subscriptions AS s
  WHERE s.status = 'active'
  ORDER BY s.id
  FOR KEY SHARE OF s;

  SELECT c.* INTO v_campaign FROM cartlify.newsletter_campaigns AS c WHERE c.id = p_campaign_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_CAMPAIGN_NOT_FOUND';
  END IF;

  IF v_campaign.status <> 'scheduled' THEN
    RAISE EXCEPTION 'NEWSLETTER_CAMPAIGN_NOT_SCHEDULED';
  END IF;

  -- a language the campaign has a subject in: a text that is not blank
  v_subjects := v_campaign.content -> 'subject';

  INSERT INTO cartlify.newsletter_recipients ("campaignId", "subscriptionId", locale, "createdAt", "updatedAt")
  SELECT p_campaign_id, s.id, pick.locale, v_now, v_now
  FROM cartlify.newsletter_subscriptions AS s
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN jsonb_typeof(v_subjects -> coalesce(s.locale, p_shop_locale)) = 'string'
             AND btrim(v_subjects ->> coalesce(s.locale, p_shop_locale)) <> ''
          THEN coalesce(s.locale, p_shop_locale)
        WHEN v_campaign."missingLocale" = 'shop_locale'
             AND jsonb_typeof(v_subjects -> p_shop_locale) = 'string'
             AND btrim(v_subjects ->> p_shop_locale) <> ''
          THEN p_shop_locale
        ELSE NULL
      END AS locale
  ) AS pick
  WHERE s.status = 'active' AND pick.locale IS NOT NULL
  ORDER BY s.id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE cartlify.newsletter_campaigns AS c
  SET
    status = 'sending',
    "startedAt" = v_now,
    "productsSnapshot" = p_snapshot,
    "plannedCount" = v_count,
    "updatedAt" = v_now
  WHERE c.id = p_campaign_id;

  RETURN v_count;
END;
$$;

-- Takes a portion of the mails that wait, for a pass to send: up to p_limit rows of campaigns that
-- are sending (a campaign that was stopped or finished is never taken from), the mails with the
-- fewest tries used first and by id among those with the same, both in the choice of the rows and
-- in the order they come back in, each leased to the caller: it gets one more try counted and the
-- time of the lease. A row that is leased
-- is left to its holder for p_lease_minutes; if the holder did not finish it by then (a crash, a
-- failure to be tried again), another call takes it again, and this is also how a mail the provider
-- failed on is tried again later (the lease is the pause between the tries). Rows other sessions hold
-- at this moment are passed over (SKIP LOCKED), so two calls never take the same row.
-- p_campaign_ids narrows the call to those campaigns (NULL: all).
-- What the sender needs comes back: the row, its campaign, the language, the address and the salt of
-- the token of the subscription (the token itself is made by the server), whether this is the
-- last try (the p_max_attempts-th): a mail that fails again is then given up, not left for another,
-- and previous_try, the time the mail was taken before this call (the database clock, the one that
-- writes the lease), empty for a mail taken for the first time. With it the sender can tell whether
-- the campaign had a mail taken by the provider since: the rows of such mails (status sent) carry
-- the database clock in updatedAt from the moment they were written down.
-- Before the portion is taken, two kinds of rows are put away, for the campaigns in question:
-- a mail that has been tried p_max_attempts times and not finished (a lease that ran out each time:
-- the process died on it) is rejected and counted in the campaign (rejectedCount), so one bad row
-- cannot keep a campaign sending for ever; and a mail whose subscription is not in force any more
-- (unsubscribed, bounced, complained about meanwhile) is skipped, never returned and counted in no
-- total of the campaign. The subscription is read without a lock (the steps of a person lock
-- subscription, then mail, then campaign; this one never takes a lock back). A p_limit below one
-- takes nothing, the rest is still put away.
-- The settings are the caller's to give and are checked before anything is done:
-- NEWSLETTER_LEASE_INVALID: p_lease_minutes is not from 1 minute to 1440 (a day);
-- NEWSLETTER_ATTEMPTS_INVALID: p_max_attempts is not from 1 to 20;
-- NEWSLETTER_LIMIT_INVALID: p_limit is over 1000 (a portion has a top).
CREATE OR REPLACE FUNCTION cartlify.newsletter_claim_recipients (
  p_limit integer,
  p_campaign_ids integer[],
  p_lease_minutes integer,
  p_max_attempts integer
) RETURNS TABLE (
  recipient_id integer,
  campaign_id integer,
  locale text,
  email text,
  manage_salt text,
  last_attempt boolean,
  previous_try timestamp
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_now          timestamp := now() AT TIME ZONE 'UTC';
  v_lease        interval;
  v_max_attempts integer := p_max_attempts;
BEGIN
  IF NOT cartlify.is_system() THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  IF p_lease_minutes IS NULL OR p_lease_minutes < 1 OR p_lease_minutes > 1440 THEN
    RAISE EXCEPTION 'NEWSLETTER_LEASE_INVALID';
  END IF;

  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'NEWSLETTER_ATTEMPTS_INVALID';
  END IF;

  IF p_limit > 1000 THEN
    RAISE EXCEPTION 'NEWSLETTER_LIMIT_INVALID';
  END IF;

  v_lease := make_interval(mins => p_lease_minutes);

  -- a mail whose tries are used up, and whose last lease ran out without an answer
  WITH worn AS (
    SELECT r.id
    FROM cartlify.newsletter_recipients AS r
    JOIN cartlify.newsletter_campaigns AS c ON c.id = r."campaignId"
    WHERE r.status = 'queued'
      AND c.status = 'sending'
      AND r.attempts >= v_max_attempts
      AND r."updatedAt" <= v_now - v_lease
      AND (p_campaign_ids IS NULL OR r."campaignId" = ANY (p_campaign_ids))
    ORDER BY r.id
    FOR UPDATE OF r SKIP LOCKED
  ),
  given_up AS (
    UPDATE cartlify.newsletter_recipients AS r
    SET
      status = 'rejected',
      "updatedAt" = v_now
    FROM worn
    WHERE r.id = worn.id
    RETURNING r."campaignId"
  )
  UPDATE cartlify.newsletter_campaigns AS c
  SET
    "rejectedCount" = c."rejectedCount" + g.total,
    "updatedAt" = v_now
  FROM (
    SELECT u."campaignId", count(*)::integer AS total FROM given_up AS u GROUP BY u."campaignId"
  ) AS g
  WHERE c.id = g."campaignId";

  -- a mail whose subscription is not in force any more
  WITH left_out AS (
    SELECT r.id
    FROM cartlify.newsletter_recipients AS r
    JOIN cartlify.newsletter_campaigns AS c ON c.id = r."campaignId"
    JOIN cartlify.newsletter_subscriptions AS s ON s.id = r."subscriptionId"
    WHERE r.status = 'queued'
      AND c.status = 'sending'
      AND s.status <> 'active'
      AND (r.attempts = 0 OR r."updatedAt" <= v_now - v_lease)
      AND (p_campaign_ids IS NULL OR r."campaignId" = ANY (p_campaign_ids))
    ORDER BY r.id
    FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE cartlify.newsletter_recipients AS r
  SET
    status = 'skipped',
    "updatedAt" = v_now
  FROM left_out
  WHERE r.id = left_out.id;

  IF p_limit IS NULL OR p_limit < 1 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT r.id, r.attempts AS tried, r."updatedAt" AS tried_at
    FROM cartlify.newsletter_recipients AS r
    JOIN cartlify.newsletter_campaigns AS c ON c.id = r."campaignId"
    JOIN cartlify.newsletter_subscriptions AS s ON s.id = r."subscriptionId"
    WHERE r.status = 'queued'
      AND c.status = 'sending'
      AND s.status = 'active'
      AND r.attempts < v_max_attempts
      AND (r.attempts = 0 OR r."updatedAt" <= v_now - v_lease)
      AND (p_campaign_ids IS NULL OR r."campaignId" = ANY (p_campaign_ids))
    ORDER BY r.attempts, r.id
    LIMIT p_limit
    FOR UPDATE OF r SKIP LOCKED
  ),
  leased AS (
    UPDATE cartlify.newsletter_recipients AS r
    SET
      attempts = r.attempts + 1,
      "updatedAt" = v_now
    FROM picked
    WHERE r.id = picked.id
    RETURNING
      r.id,
      r."campaignId",
      r."subscriptionId",
      r.locale,
      r.attempts,
      CASE WHEN picked.tried > 0 THEN picked.tried_at END AS previous_try
  )
  SELECT
    l.id,
    l."campaignId",
    l.locale::text,
    s.email::text,
    s."manageSalt"::text,
    l.attempts >= v_max_attempts,
    l.previous_try
  FROM leased AS l
  JOIN cartlify.newsletter_subscriptions AS s ON s.id = l."subscriptionId"
  ORDER BY l.attempts, l.id;
END;
$$;

-- Gives back mails a pass took and did not try, or found the provider busy for (it was told to stop,
-- the provider refused its key, the campaign was stopped meanwhile): each one still waiting loses the
-- try its lease counted and is free to be taken again at once, in its place in the queue, as if it had
-- not been taken. Without it an outage of the provider would use up the tries of the mails at the head
-- of the queue, one pass after another. A mail the provider refused is not given back: it keeps its
-- try and waits out its lease (the sender simply does not call this for it). Rows no longer waiting are
-- left alone. Returns how many were given back.
CREATE OR REPLACE FUNCTION cartlify.newsletter_release_recipients (p_recipient_ids integer[]) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_temp AS $$
DECLARE
  v_released integer;
BEGIN
  IF NOT cartlify.is_system() THEN
    RAISE EXCEPTION 'NEWSLETTER_FORBIDDEN';
  END IF;

  UPDATE cartlify.newsletter_recipients AS r
  SET
    attempts = greatest(r.attempts - 1, 0),
    "updatedAt" = r."createdAt"
  WHERE r.id = ANY (p_recipient_ids) AND r.status = 'queued' AND r.attempts > 0;

  GET DIAGNOSTICS v_released = ROW_COUNT;

  RETURN v_released;
END;
$$;

COMMIT;
