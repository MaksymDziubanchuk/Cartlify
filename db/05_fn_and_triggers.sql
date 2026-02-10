BEGIN;

------------------------------------------------------------
-- Roles and context functions
------------------------------------------------------------
-- Set context
-- DROP FUNCTION IF EXISTS cartlify.set_current_context (cartlify."Role", integer, uuid);
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

REVOKE ALL ON FUNCTION cartlify.set_current_context (cartlify."Role", integer, uuid)
FROM
  PUBLIC;

GRANT
EXECUTE ON FUNCTION cartlify.set_current_context (cartlify."Role", integer, uuid) TO cartlify_owner,
cartlify_app;

-- Get actor user id
-- DROP FUNCTION IF EXISTS cartlify.current_actor_id ();
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

-- Get guest id
-- DROP FUNCTION IF EXISTS cartlify.current_guest_id ();
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

-- Get actor role
-- DROP FUNCTION IF EXISTS cartlify.current_actor_role ();
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

-- Is actor admin
-- DROP FUNCTION IF EXISTS cartlify.is_admin ();
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

-- Is actor root
-- DROP FUNCTION IF EXISTS cartlify.is_root ();
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

-- Is actor owner
-- DROP FUNCTION IF EXISTS cartlify.is_owner (integer);
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

-- Is owner or admin
-- DROP FUNCTION IF EXISTS cartlify.is_owner_or_admin (integer)
CREATE OR REPLACE FUNCTION cartlify.is_owner_or_admin (p_user_id integer) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN cartlify.is_admin() OR cartlify.is_owner(p_user_id);
END;
$$;

------------------------------------------------------------
-- USERS
------------------------------------------------------------
-- "users" GET user for login
-- DROP FUNCTION IF EXISTS cartlify.auth_get_user_for_login (text)
CREATE OR REPLACE FUNCTION cartlify.auth_get_user_for_login (p_email text) RETURNS TABLE (
  id int,
  password_hash text,
  role cartlify."Role",
  is_verified boolean,
  auth_provider cartlify."AuthProvider"
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
DECLARE
  prev_role text;
  prev_uid  text;
  prev_gid  text;
BEGIN
  prev_role := current_setting('cartlify.role', true);
  prev_uid  := current_setting('cartlify.user_id', true);
  prev_gid  := current_setting('cartlify.guest_id', true);

  -- adding ADMIN context
  PERFORM cartlify.set_current_context('ADMIN'::cartlify."Role", NULL, NULL);

  RETURN QUERY
  SELECT u.id, u."passwordHash", u.role, u."isVerified", u."authProvider"
  FROM cartlify.users u
  WHERE u.email = lower(btrim(p_email))
  LIMIT 1;

  -- restore previous context
  PERFORM set_config('cartlify.role',     COALESCE(prev_role, ''), true);
  PERFORM set_config('cartlify.user_id',  COALESCE(prev_uid,  ''), true);
  PERFORM set_config('cartlify.guest_id', COALESCE(prev_gid,  ''), true);
END;
$$;

REVOKE ALL ON FUNCTION cartlify.auth_get_user_for_login (text)
FROM
  PUBLIC;

GRANT
EXECUTE ON FUNCTION cartlify.auth_get_user_for_login (text) TO cartlify_app,
cartlify_owner;

------------------------------------------------------------
-- USERS TOKENS
------------------------------------------------------------
-- "users token" GET new for verify
-- DROP FUNCTION IF EXISTS cartlify.auth_resend_verify (text, text, timestamptz);
CREATE OR REPLACE FUNCTION cartlify.auth_resend_verify (
  p_email text,
  p_token text,
  p_expires_at timestamptz
) RETURNS TABLE (user_id int, token text, expires_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
DECLARE
  v_prev_role text;
  v_prev_user_id text;
  v_prev_guest_id text;

  v_user_id int;
  v_is_verified boolean;

  v_token text;
  v_expires_at timestamptz;
BEGIN
  -- normalize + validate inputs
  p_email := lower(btrim(p_email));
  p_token := btrim(p_token);

  IF p_email IS NULL OR p_email = '' THEN RETURN; END IF;
  IF p_token IS NULL OR p_token = '' THEN RETURN; END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN RETURN; END IF;

  -- save current context
  v_prev_role := current_setting('cartlify.role', true);
  v_prev_user_id := current_setting('cartlify.user_id', true);
  v_prev_guest_id := current_setting('cartlify.guest_id', true);

  BEGIN
    -- TEMP: become admin-context to pass users_select under FORCE RLS
    PERFORM cartlify.set_current_context('ADMIN'::cartlify."Role", NULL, NULL);

    -- find user
    SELECT u.id, u."isVerified"
      INTO v_user_id, v_is_verified
    FROM cartlify.users u
    WHERE u.email = p_email
    LIMIT 1;

    IF v_user_id IS NULL OR v_is_verified IS TRUE THEN
      -- restore context and return 0 rows
      PERFORM set_config('cartlify.role',     COALESCE(v_prev_role, ''), true);
      PERFORM set_config('cartlify.user_id',  COALESCE(v_prev_user_id, ''), true);
      PERFORM set_config('cartlify.guest_id', COALESCE(v_prev_guest_id, ''), true);
      RETURN;
    END IF;

    -- reuse existing active verify token if present
    SELECT ut.token, ut."expiresAt"
      INTO v_token, v_expires_at
    FROM cartlify.user_tokens ut
    WHERE ut."userId" = v_user_id
      AND ut.type = 'VERIFY_EMAIL'::cartlify."UserTokenType"
      AND ut."usedAt" IS NULL
      AND ut."expiresAt" > now()
    ORDER BY ut."expiresAt" DESC
    LIMIT 1;

    IF v_token IS NULL THEN
      INSERT INTO cartlify.user_tokens ("userId", type, token, "expiresAt", "usedAt")
      VALUES (v_user_id, 'VERIFY_EMAIL'::cartlify."UserTokenType", p_token, p_expires_at, NULL);

      v_token := p_token;
      v_expires_at := p_expires_at;
    END IF;

    -- restore original context before returning
    PERFORM set_config('cartlify.role',     COALESCE(v_prev_role, ''), true);
    PERFORM set_config('cartlify.user_id',  COALESCE(v_prev_user_id, ''), true);
    PERFORM set_config('cartlify.guest_id', COALESCE(v_prev_guest_id, ''), true);

    user_id := v_user_id;
    token := v_token;
    expires_at := v_expires_at;
    RETURN NEXT;
    RETURN;

  EXCEPTION WHEN unique_violation THEN
    -- race: if insert collided, try fetch active token and return it
    SELECT ut.token, ut."expiresAt"
      INTO v_token, v_expires_at
    FROM cartlify.user_tokens ut
    WHERE ut."userId" = v_user_id
      AND ut.type = 'VERIFY_EMAIL'::cartlify."UserTokenType"
      AND ut."usedAt" IS NULL
      AND ut."expiresAt" > now()
    ORDER BY ut."expiresAt" DESC
    LIMIT 1;

    PERFORM set_config('cartlify.role',     COALESCE(v_prev_role, ''), true);
    PERFORM set_config('cartlify.user_id',  COALESCE(v_prev_user_id, ''), true);
    PERFORM set_config('cartlify.guest_id', COALESCE(v_prev_guest_id, ''), true);

    IF v_token IS NOT NULL THEN
      user_id := v_user_id;
      token := v_token;
      expires_at := v_expires_at;
      RETURN NEXT;
    END IF;
    RETURN;

  WHEN OTHERS THEN
    -- always restore context
    PERFORM set_config('cartlify.role',     COALESCE(v_prev_role, ''), true);
    PERFORM set_config('cartlify.user_id',  COALESCE(v_prev_user_id, ''), true);
    PERFORM set_config('cartlify.guest_id', COALESCE(v_prev_guest_id, ''), true);
    RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION cartlify.auth_resend_verify (text, text, timestamptz)
FROM
  PUBLIC;

GRANT
EXECUTE ON FUNCTION cartlify.auth_resend_verify (text, text, timestamptz) TO cartlify_owner,
cartlify_app;

-- "user_tokens" MAKE GUEST verify
-- DROP FUNCTION IF EXISTS cartlify.auth_verify_email (text);
CREATE OR REPLACE FUNCTION cartlify.auth_verify_email (p_token text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify,
  pg_catalog AS $$
DECLARE
  v_prev_role text;
  v_prev_user_id text;
  v_prev_guest_id text;

  v_user_id int;
BEGIN
  p_token := btrim(p_token);
  IF p_token IS NULL OR p_token = '' THEN
    RETURN false;
  END IF;

  v_prev_role := current_setting('cartlify.role', true);
  v_prev_user_id := current_setting('cartlify.user_id', true);
  v_prev_guest_id := current_setting('cartlify.guest_id', true);

  BEGIN
    PERFORM cartlify.set_current_context('ADMIN'::cartlify."Role", NULL, NULL);

    SELECT ut."userId"
      INTO v_user_id
    FROM cartlify.user_tokens ut
    WHERE ut.token = p_token
      AND ut.type = 'VERIFY_EMAIL'::cartlify."UserTokenType"
      AND ut."usedAt" IS NULL
      AND ut."expiresAt" > now()
    LIMIT 1;

    IF v_user_id IS NULL THEN
      PERFORM set_config('cartlify.role',     COALESCE(v_prev_role, ''), true);
      PERFORM set_config('cartlify.user_id',  COALESCE(v_prev_user_id, ''), true);
      PERFORM set_config('cartlify.guest_id', COALESCE(v_prev_guest_id, ''), true);
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

    PERFORM set_config('cartlify.role',     COALESCE(v_prev_role, ''), true);
    PERFORM set_config('cartlify.user_id',  COALESCE(v_prev_user_id, ''), true);
    PERFORM set_config('cartlify.guest_id', COALESCE(v_prev_guest_id, ''), true);

    RETURN true;

  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('cartlify.role',     COALESCE(v_prev_role, ''), true);
    PERFORM set_config('cartlify.user_id',  COALESCE(v_prev_user_id, ''), true);
    PERFORM set_config('cartlify.guest_id', COALESCE(v_prev_guest_id, ''), true);
    RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION cartlify.auth_verify_email (text)
FROM
  PUBLIC;

GRANT
EXECUTE ON FUNCTION cartlify.auth_verify_email (text) TO cartlify_owner,
cartlify_app;

------------------------------------------------------------
-- ORDERS
------------------------------------------------------------
-- "orders" CALC total
-- DROP FUNCTION IF EXISTS cartlify.recalc_order_total (integer)
CREATE OR REPLACE FUNCTION cartlify.recalc_order_total (p_order_id integer) RETURNS void LANGUAGE plpgsql AS $$
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

------------------------------------------------------------
-- ORDERS AND ORDER ITEMS
------------------------------------------------------------
-- "order_items" CALC totalPrice
-- DROP FUNCTION IF EXISTS cartlify.order_items_before_ins_upd ()
CREATE OR REPLACE FUNCTION cartlify.order_items_before_ins_upd () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_confirmed boolean;
BEGIN

  SELECT o."confirmed"
  INTO v_confirmed
  FROM cartlify.orders AS o
  WHERE o.id = NEW."orderId";

  IF v_confirmed THEN
    RAISE EXCEPTION 'Order % is already confirmed; items cannot be changed', NEW."orderId"
      USING ERRCODE = 'check_violation';
  END IF;

  NEW."totalPrice" := NEW."unitPrice" * NEW."quantity";

  RETURN NEW;
  
END;
$$;

DROP TRIGGER IF EXISTS trg_order_items_before_ins_upd ON cartlify.order_items;

CREATE TRIGGER trg_order_items_before_ins_upd BEFORE INSERT
OR
UPDATE ON cartlify.order_items FOR EACH ROW
EXECUTE FUNCTION cartlify.order_items_before_ins_upd ();

-- 'orders' RECALC total
-- DROP FUNCTION IF EXISTS cartlify.order_items_after_mod ()
CREATE OR REPLACE FUNCTION cartlify.order_items_after_mod () RETURNS trigger LANGUAGE plpgsql AS $$
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
AFTER INSERT
OR
UPDATE
OR DELETE ON cartlify.order_items FOR EACH ROW
EXECUTE FUNCTION cartlify.order_items_after_mod ();

-- 'orders' CONFIRMING
-- DROP FUNCTION IF EXISTS cartlify.orders_before_update ()
CREATE OR REPLACE FUNCTION cartlify.orders_before_update () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN

  IF OLD."confirmed" THEN
    IF NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."confirmed" IS DISTINCT FROM OLD."confirmed"
       OR NEW."total" IS DISTINCT FROM OLD."total"
       OR NEW."shippingAddress" IS DISTINCT FROM OLD."shippingAddress"
       OR COALESCE(NEW."note", '') IS DISTINCT FROM COALESCE(OLD."note", '')
    THEN
      RAISE EXCEPTION 'Confirmed order % can only change status', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  IF NOT OLD."confirmed" AND NEW."confirmed" THEN

    IF NEW."shippingAddress" IS NULL
       OR btrim(NEW."shippingAddress") = '' THEN
      RAISE EXCEPTION 'Cannot confirm order % without shipping address', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;

    PERFORM cartlify.recalc_order_total(OLD.id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_before_update ON cartlify.orders;

CREATE TRIGGER trg_orders_before_update BEFORE
UPDATE ON cartlify.orders FOR EACH ROW
EXECUTE FUNCTION cartlify.orders_before_update ();

------------------------------------------------------------
-- PRODUCTS
------------------------------------------------------------
-- 'product' CALC avgRating
-- DROP FUNCTION IF EXISTS cartlify.recalc_product_rating (integer)
CREATE OR REPLACE FUNCTION cartlify.recalc_product_rating (p_product_id integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_avg   numeric(3, 2);
  v_count integer;
BEGIN
  SELECT
    COALESCE(AVG(r.rating)::numeric(3, 2), 0),
    COUNT(*)::integer
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

-- DROP FUNCTION IF EXISTS cartlify.reviews_after_mod_rating ()
CREATE OR REPLACE FUNCTION cartlify.reviews_after_mod_rating () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_product_id integer;
BEGIN
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
AFTER INSERT
OR
UPDATE
OR DELETE ON cartlify.reviews FOR EACH ROW
EXECUTE FUNCTION cartlify.reviews_after_mod_rating ();

------------------------------------------------------------
-- REVIEWS 
------------------------------------------------------------
-- PREVENT RATING CHANGE
CREATE OR REPLACE FUNCTION cartlify.reviews_lock_rating_and_keys () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."rating" IS DISTINCT FROM OLD."rating" THEN
    RAISE EXCEPTION 'REVIEW_RATING_UPDATE_FORBIDDEN';
  END IF;

  IF NEW."userId" IS DISTINCT FROM OLD."userId" THEN
    RAISE EXCEPTION 'REVIEW_USER_CHANGE_FORBIDDEN';
  END IF;

  IF NEW."productId" IS DISTINCT FROM OLD."productId" THEN
    RAISE EXCEPTION 'REVIEW_PRODUCT_CHANGE_FORBIDDEN';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reviews_lock_rating_and_keys ON cartlify.reviews;

CREATE TRIGGER trg_reviews_lock_rating_and_keys BEFORE
UPDATE ON cartlify.reviews FOR EACH ROW
EXECUTE FUNCTION cartlify.reviews_lock_rating_and_keys ();

-- 'reviews' CALC upVotes & downVotes
-- DROP FUNCTION IF EXISTS cartlify.recalc_review_votes (integer)
CREATE OR REPLACE FUNCTION cartlify.recalc_review_votes (p_review_id integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_up   integer;
  v_down integer;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE rv."action" = true),
    COUNT(*) FILTER (WHERE rv."action" = false)
  INTO v_up, v_down
  FROM cartlify.review_votes AS rv
  WHERE rv."reviewId" = p_review_id;

  UPDATE cartlify.reviews AS r
  SET
    "upVotes"   = COALESCE(v_up, 0),
    "downVotes" = COALESCE(v_down, 0)
  WHERE r.id = p_review_id;
END;
$$;

-- DROP FUNCTION IF EXISTS cartlify.review_votes_after_mod ()
CREATE OR REPLACE FUNCTION cartlify.review_votes_after_mod () RETURNS trigger LANGUAGE plpgsql AS $$
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
AFTER INSERT
OR
UPDATE
OR DELETE ON cartlify.review_votes FOR EACH ROW
EXECUTE FUNCTION cartlify.review_votes_after_mod ();

-- 'products' CALC popularity
-- DROP FUNCTION IF EXISTS cartlify.recalc_product_popularity (integer)
CREATE OR REPLACE FUNCTION cartlify.recalc_product_popularity (p_product_id integer) RETURNS void LANGUAGE plpgsql AS $$
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


  IF v_override IS NOT NULL
     AND v_override_until IS NOT NULL
     AND v_now < v_override_until THEN
    UPDATE cartlify.products AS p
    SET "popularity" = v_override
    WHERE p.id = p_product_id;

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
  WHERE p.id = p_product_id;
END;
$$;

-- ADD TO RAILWAY ONCE A WEEK!!!
--psql "$MIGRATION_DATABASE_URL" \
-- -c 'SELECT cartlify.recalc_all_products_popularity();'
-- 'products' RECALC ALL popularity
-- DROP FUNCTION IF EXISTS cartlify.recalc_all_products_popularity ()
CREATE OR REPLACE FUNCTION cartlify.recalc_all_products_popularity () RETURNS void LANGUAGE plpgsql AS $$
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

--
-- DROP FUNCTION IF EXISTS cartlify.products_after_views_change ()
CREATE OR REPLACE FUNCTION cartlify.products_after_views_change () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."views" IS DISTINCT FROM OLD."views" THEN
    PERFORM cartlify.recalc_product_popularity(NEW.id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_after_views_change ON cartlify.products;

CREATE TRIGGER trg_products_after_views_change
AFTER
UPDATE ON cartlify.products FOR EACH ROW
EXECUTE FUNCTION cartlify.products_after_views_change ();

--
-- DROP FUNCTION IF EXISTS cartlify.favorites_after_mod_popularity ()
CREATE OR REPLACE FUNCTION cartlify.favorites_after_mod_popularity () RETURNS trigger LANGUAGE plpgsql AS $$
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
AFTER INSERT
OR DELETE ON cartlify.favorites FOR EACH ROW
EXECUTE FUNCTION cartlify.favorites_after_mod_popularity ();

--
-- DROP FUNCTION IF EXISTS cartlify.order_items_after_mod_popularity ()
CREATE OR REPLACE FUNCTION cartlify.order_items_after_mod_popularity () RETURNS trigger LANGUAGE plpgsql AS $$
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
AFTER INSERT
OR
UPDATE
OR DELETE ON cartlify.order_items FOR EACH ROW
EXECUTE FUNCTION cartlify.order_items_after_mod_popularity ();

--
-- DROP FUNCTION IF EXISTS cartlify.reviews_after_mod_popularity ()
CREATE OR REPLACE FUNCTION cartlify.reviews_after_mod_popularity () RETURNS trigger LANGUAGE plpgsql AS $$
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
AFTER INSERT
OR
UPDATE
OR DELETE ON cartlify.reviews FOR EACH ROW
EXECUTE FUNCTION cartlify.reviews_after_mod_popularity ();

--
-- DROP FUNCTION IF EXISTS cartlify.orders_after_update_popularity ()
CREATE OR REPLACE FUNCTION cartlify.orders_after_update_popularity () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_product_id integer;
BEGIN

  IF NEW."confirmed" IS DISTINCT FROM OLD."confirmed"
     OR NEW."status" IS DISTINCT FROM OLD."status" THEN

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
AFTER
UPDATE ON cartlify.orders FOR EACH ROW
EXECUTE FUNCTION cartlify.orders_after_update_popularity ();

------------------------------------------------------------
-- CHAT THREADS
------------------------------------------------------------
--'chat_threads' UPDATE last message info
-- DROP FUNCTION IF EXISTS cartlify.chat_messages_after_insert ()
CREATE OR REPLACE FUNCTION cartlify.chat_messages_after_insert () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_preview text;
BEGIN
  v_preview := left(replace(NEW.content, E'\n', ' '), 200);

  UPDATE cartlify.chat_threads AS t
  SET
    "lastMessageAt"      = NEW."createdAt",
    "lastMessagePreview" = v_preview,
    "unreadCount"        = CASE
    WHEN NEW."senderType" <> 'user'
        THEN t."unreadCount" + 1
    ELSE t."unreadCount"
        END
  WHERE t.id = NEW."threadId";

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_messages_after_insert ON cartlify.chat_messages;

CREATE TRIGGER trg_chat_messages_after_insert
AFTER INSERT ON cartlify.chat_messages FOR EACH ROW
EXECUTE FUNCTION cartlify.chat_messages_after_insert ();

------------------------------------------------------------
-- PRODUCT PRICE CHANGE LOGS
------------------------------------------------------------
--'product_price_change_logs' ADD column
-- DROP FUNCTION IF EXISTS cartlify.log_product_price_change (
--   integer,
--   integer,
--   numeric,
--   numeric,
--   cartlify."PriceChangeMode",
--   numeric
-- )
CREATE OR REPLACE FUNCTION cartlify.log_product_price_change (
  p_product_id integer,
  p_actor_id integer,
  p_old_price numeric,
  p_new_price numeric,
  p_mode cartlify."PriceChangeMode",
  p_value numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN

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
    "createdAt"
  )
  VALUES (
    p_product_id,
    p_actor_id,
    p_old_price,
    p_new_price,
    p_mode,
    p_value,
    now()
  );
END;
$$;

------------------------------------------------------------
-- ADMIN AUDIT LOG
------------------------------------------------------------
-- 'AdminAuditLog' ADD column
-- DROP FUNCTION IF EXISTS cartlify.log_admin_action (
--   integer,
--   cartlify."Role",
--   cartlify."AdminAuditEntityType",
--   integer,
--   cartlify."AdminAuditAction",
--   jsonb
--   --text,
--   --text
-- )
CREATE OR REPLACE FUNCTION cartlify.log_admin_action (
  p_actor_id integer,
  p_actor_role cartlify."Role",
  p_entity_type cartlify."AdminAuditEntityType",
  p_entity_id integer,
  p_action cartlify."AdminAuditAction",
  p_changes jsonb
  --p_ip          text,
  --p_user_agent  text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN

  IF p_changes IS NOT NULL AND jsonb_typeof(p_changes) <> 'array' THEN
    RAISE EXCEPTION 'log_admin_action: p_changes must be JSON array'
      USING HINT = 'Очікується масив обʼєктів {field, old, new}';
  END IF;

  INSERT INTO cartlify.admin_audit_log (
    "actorId",
    "actorRole",
    "entityType",
    "entityId",
    action,
    meta,
    --ip,
    --"userAgent",
    "createdAt"
  )
  VALUES (
    p_actor_id,
    p_actor_role,
    p_entity_type,
    p_entity_id,
    p_action,
    p_changes,    
    --p_ip,
    --p_user_agent,
    now()
  );
END;
$$;

----------------------------------------
-- GUEST DATA -> USER
----------------------------------------
-- DROP FUNCTION IF EXISTS cartlify.migrate_guest_data_to_user (uuid, integer)
CREATE OR REPLACE FUNCTION cartlify.migrate_guest_data_to_user (p_guest_id uuid, p_user_id integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
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

  -- CHAT THREADS: migrate guest -> user
  UPDATE cartlify.chat_threads
  SET "userId"  = p_user_id,
      "guestId" = NULL
  WHERE "guestId" = p_guest_id;
END;
$$;

COMMIT;