BEGIN;

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
CREATE OR REPLACE FUNCTION cartlify.auth_get_user_for_login (p_email text) RETURNS TABLE (
  id int,
  password_hash text,
  role cartlify."Role",
  is_verified boolean,
  auth_provider cartlify."AuthProvider"
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
BEGIN

  RETURN QUERY
  SELECT u.id, u."passwordHash", u.role, u."isVerified", u."authProvider"
  FROM cartlify.users u
  WHERE u.email = lower(btrim(p_email))
  LIMIT 1;

END;
$$;

-- AUTH AND USERS fetch public user profile fields by user id
CREATE OR REPLACE FUNCTION cartlify.users_get_public_profile (p_user_id int) RETURNS TABLE (
  id int,
  email text,
  created_at timestamptz,
  updated_at timestamptz,
  name text,
  avatar_url text
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
BEGIN

  -- fetch only allowed fields
  RETURN QUERY
  SELECT
    u.id,
    u.email,
    u."createdAt",
    u."updatedAt",
    u.name,
    u."avatarUrl"
  FROM cartlify.users u
  WHERE u.id = p_user_id
  LIMIT 1;

END;
$$;

------------------------------------------------------------
-- AUTH AND USER TOKENS
------------------------------------------------------------
-- AUTH AND USER TOKENS === system functions === 
-- AUTH AND USER TOKENS create or reuse active email verification token
CREATE OR REPLACE FUNCTION cartlify.auth_resend_verify (
  p_email text,
  p_token text,
  p_expires_at timestamptz
) RETURNS TABLE (user_id int, token text, expires_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
DECLARE
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

  BEGIN

    -- find user
    SELECT u.id, u."isVerified"
      INTO v_user_id, v_is_verified
    FROM cartlify.users u
    WHERE u.email = p_email
    LIMIT 1;

    IF v_user_id IS NULL OR v_is_verified IS TRUE THEN
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

    IF v_token IS NOT NULL THEN
      user_id := v_user_id;
      token := v_token;
      expires_at := v_expires_at;
      RETURN NEXT;
    END IF;
    RETURN;

  WHEN OTHERS THEN
    RAISE;
  END;
END;
$$;

-- AUTH AND USER TOKENS consume email verification token and mark user as verified
CREATE OR REPLACE FUNCTION cartlify.auth_verify_email (p_token text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
DECLARE
  v_user_id int;
BEGIN
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

------------------------------------------------------------
-- PRODUCTS
------------------------------------------------------------
-- PRODUCTS === system functions === 
-- PRODUCTS recalc product rating from reviews
CREATE OR REPLACE FUNCTION cartlify.recalc_product_rating (p_product_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
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

-- PRODUCTS add stock to product inventory
CREATE OR REPLACE FUNCTION cartlify.add_product_stock (p_product_id integer, p_delta integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
DECLARE
  v_role text;
  v_stock integer;
BEGIN
  IF p_delta IS NULL OR p_delta <= 0 THEN
    RAISE EXCEPTION 'STOCK_DELTA_INVALID';
  END IF;

  v_role := cartlify.current_actor_role();

  IF v_role NOT IN ('ADMIN', 'ROOT') THEN
    RAISE EXCEPTION 'STOCK_ADD_FORBIDDEN';
  END IF;

  -- lock product row
  SELECT p."stock"
  INTO v_stock
  FROM cartlify.products AS p
  WHERE p.id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  v_stock := v_stock + p_delta;

  UPDATE cartlify.products AS p
  SET "stock" = v_stock
  WHERE p.id = p_product_id;

  RETURN v_stock;
END;
$$;

-- PRODUCTS reserve product stock for order confirmation
CREATE OR REPLACE FUNCTION cartlify.reserve_product_stock (p_product_id int, p_qty int) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
BEGIN
  -- validate input
  IF p_product_id IS NULL OR p_product_id <= 0 THEN
    RAISE EXCEPTION 'PRODUCT_ID_INVALID';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'RESERVE_QTY_INVALID';
  END IF;

  -- reserve only available stock
  UPDATE cartlify.products p
  SET "reservedStock" = p."reservedStock" + p_qty
  WHERE p.id = p_product_id
    AND p."deletedAt" IS NULL
    AND (p.stock - p."reservedStock") >= p_qty;

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
CREATE OR REPLACE FUNCTION cartlify.release_product_stock (p_product_id int, p_qty int) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
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

-- PRODUCTS consume reserved stock after payment
CREATE OR REPLACE FUNCTION cartlify.consume_product_stock (p_product_id integer, p_qty integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
DECLARE
  v_role           text;
  v_stock          integer;
  v_reserved_stock integer;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'STOCK_QTY_INVALID';
  END IF;

  v_role := cartlify.current_actor_role();

  IF v_role NOT IN ('USER', 'ADMIN', 'ROOT') THEN
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

  RETURN v_stock;
END;
$$;

-- PRODUCTS recalc product popularity score
CREATE OR REPLACE FUNCTION cartlify.recalc_product_popularity (p_product_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
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
-- PRODUCTS recalc popularity for all products
CREATE OR REPLACE FUNCTION cartlify.recalc_all_products_popularity () RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
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
-- PRODUCTS sync product rating after review rating change
CREATE OR REPLACE FUNCTION cartlify.reviews_after_mod_rating () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_product_id integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."rating" IS NOT DISTINCT FROM OLD."rating" THEN
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
AFTER INSERT
OR DELETE
OR
UPDATE OF "rating" ON cartlify.reviews FOR EACH ROW
EXECUTE FUNCTION cartlify.reviews_after_mod_rating ();

-- PRODUCTS sync product views after product update
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

-- PRODUCTS sync popularity after favorites change
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

-- PRODUCTS sync popularity after order items change
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

-- PRODUCTS sync popularity after review changes
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

-- PRODUCTS sync popularity after order status change
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
-- ORDERS AND ITEMS
------------------------------------------------------------
-- ORDERS AND ITEMS === system functions ===
-- ORDERS AND ITEMS recalc order total from order items
CREATE OR REPLACE FUNCTION cartlify.recalc_order_total (p_order_id integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
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
-- ORDERS AND ITEMS confirm order and reserve product stock
CREATE OR REPLACE FUNCTION cartlify.confirm_order (p_order_id integer, p_reserve_for interval) RETURNS void LANGUAGE plpgsql
SET
  search_path = cartlify AS $$
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
  IF v_actor_role <> 'USER' OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_CONFIRM_FORBIDDEN';
  END IF;

  -- validate reservation duration
  IF p_reserve_for IS NULL OR p_reserve_for <= interval '0 seconds' THEN
    RAISE EXCEPTION 'ORDER_RESERVATION_DURATION_INVALID';
  END IF;

  -- lock order row
  SELECT o."userId", o.confirmed, o.status
  INTO v_user_id, v_confirmed, v_status
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id
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

  IF v_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'ORDER_STATUS_NOT_PENDING';
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
CREATE OR REPLACE FUNCTION cartlify.unconfirm_order (p_order_id integer) RETURNS void LANGUAGE plpgsql
SET
  search_path = cartlify AS $$
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
  IF v_actor_role <> 'USER' OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_UNCONFIRM_FORBIDDEN';
  END IF;

  -- lock order row
  SELECT o."userId", o.confirmed, o.status
  INTO v_user_id, v_confirmed, v_status
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  -- only owner can unconfirm
  IF v_user_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'ORDER_UNCONFIRM_FORBIDDEN';
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
    status = 'pending',
    "reservationExpiresAt" = NULL
  WHERE o.id = p_order_id;
END;
$$;

-- ORDERS AND ITEMS pay order and consume reserved stock
CREATE OR REPLACE FUNCTION cartlify.pay_order (p_order_id integer) RETURNS void LANGUAGE plpgsql
SET
  search_path = cartlify AS $$
DECLARE
  v_actor_role     text;
  v_actor_id       integer;

  v_user_id        integer;
  v_confirmed      boolean;
  v_status         text;
  v_reserve_until  timestamptz;

  r record;
BEGIN
  v_actor_role := cartlify.current_actor_role();
  v_actor_id   := cartlify.current_actor_id();

  -- only real USER
  IF v_actor_role <> 'USER' OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_PAY_FORBIDDEN';
  END IF;

  -- lock order row
  SELECT o."userId", o.confirmed, o.status, o."reservationExpiresAt"
  INTO v_user_id, v_confirmed, v_status, v_reserve_until
  FROM cartlify.orders AS o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  -- only owner can pay
  IF v_user_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'ORDER_PAY_FORBIDDEN';
  END IF;

  -- order must be confirmed first
  IF NOT v_confirmed THEN
    RAISE EXCEPTION 'ORDER_NOT_CONFIRMED';
  END IF;

  -- only waiting orders can be paid
  IF v_status IS DISTINCT FROM 'waiting' THEN
    RAISE EXCEPTION 'ORDER_STATUS_NOT_WAITING';
  END IF;

  -- reservation must exist
  IF v_reserve_until IS NULL THEN
    RAISE EXCEPTION 'ORDER_RESERVATION_MISSING';
  END IF;

  -- reservation must still be active
  IF v_reserve_until < clock_timestamp() THEN
    RAISE EXCEPTION 'ORDER_RESERVATION_EXPIRED';
  END IF;

  -- lock all order items
  PERFORM 1
  FROM cartlify.order_items AS oi
  WHERE oi."orderId" = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_ITEMS_REQUIRED';
  END IF;

  -- finalize reserved stock (deterministic lock order by productId)
  FOR r IN
    SELECT oi."productId" AS product_id,
           SUM(oi.quantity)::integer AS qty
    FROM cartlify.order_items AS oi
    WHERE oi."orderId" = p_order_id
    GROUP BY oi."productId"
    ORDER BY oi."productId"
  LOOP
    PERFORM cartlify.consume_product_stock(r.product_id, r.qty);
  END LOOP;

  -- mark order as paid and clear reservation deadline
  UPDATE cartlify.orders AS o
  SET
    status = 'paid',
    "reservationExpiresAt" = NULL
  WHERE o.id = p_order_id;
END;
$$;

-- ORDERS AND ITEMS === system actions ===
-- ORDERS AND ITEMS expire order reservation and release reserved stock
CREATE OR REPLACE FUNCTION cartlify.expire_order_reservation (p_order_id integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = cartlify AS $$
DECLARE
  v_confirmed      boolean;
  v_status         text;
  v_reserve_until  timestamptz;

  r record;
BEGIN

  BEGIN
    -- lock order row
    SELECT o.confirmed, o.status, o."reservationExpiresAt"
    INTO v_confirmed, v_status, v_reserve_until
    FROM cartlify.orders AS o
    WHERE o.id = p_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- stale job or nothing to expire
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
      status = 'pending',
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
-- ORDERS AND ITEMS calculate order item total price before insert or update
CREATE OR REPLACE FUNCTION cartlify.order_items_before_ins_upd () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_confirmed boolean;
BEGIN

  SELECT o."confirmed"
  INTO v_confirmed
  FROM cartlify.orders AS o
  WHERE o.id = NEW."orderId"
  FOR UPDATE;

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

-- ORDERS AND ITEMS recalc order total after order items change
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

-- ORDERS AND ITEMS guard order updates and recalc total before confirmation
CREATE OR REPLACE FUNCTION cartlify.orders_before_update () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN

  IF OLD."confirmed" THEN
    IF NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."total" IS DISTINCT FROM OLD."total"
       OR NEW."shippingAddress" IS DISTINCT FROM OLD."shippingAddress"
       OR COALESCE(NEW."note", '') IS DISTINCT FROM COALESCE(OLD."note", '')
    THEN
      RAISE EXCEPTION 'Confirmed order % can only change status or confirming', OLD.id
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
-- REVIEWS AND VOTES
------------------------------------------------------------
-- REVIEWS AND VOTES === system functions ===
-- REVIEWS AND VOTES recalc review vote counters
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

CREATE TRIGGER trg_reviews_lock_rating_and_keys BEFORE
UPDATE ON cartlify.reviews FOR EACH ROW
EXECUTE FUNCTION cartlify.reviews_lock_rating_and_keys ();

-- REVIEWS AND VOTES sync review vote counters after vote changes
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

------------------------------------------------------------
-- CHAT
------------------------------------------------------------
-- CHAT === triggers & functions ===
-- CHAT sync thread updated time after message insert
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
-- PRICE CHANGE LOGS
------------------------------------------------------------
-- PRICE CHANGE LOGS === system functions ===
-- PRICE CHANGE LOGS insert product price change log entry
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
-- ADMIN AUDIT LOG === system functions ===
-- ADMIN AUDIT LOG insert admin audit log entry
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

------------------------------------------------------------
-- MIGRATION AND MAINTENANCE
------------------------------------------------------------
-- MIGRATION AND MAINTENANCE === system functions ===
-- MIGRATION AND MAINTENANCE migrate guest data to user after authentication
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