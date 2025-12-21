-- "orders" CALC total
CREATE OR REPLACE FUNCTION cartlify.recalc_order_total(p_order_id integer)
RETURNS void
LANGUAGE plpgsql
AS $$
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

-- "order_items" CALC totalPrice
CREATE OR REPLACE FUNCTION cartlify.order_items_before_ins_upd()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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

CREATE TRIGGER trg_order_items_before_ins_upd
BEFORE INSERT OR UPDATE ON cartlify.order_items
FOR EACH ROW
EXECUTE FUNCTION cartlify.order_items_before_ins_upd();

-- 'orders' RECALC total
CREATE OR REPLACE FUNCTION cartlify.order_items_after_mod()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
AFTER INSERT OR UPDATE OR DELETE ON cartlify.order_items
FOR EACH ROW
EXECUTE FUNCTION cartlify.order_items_after_mod();

-- 'orders' CONFIRMING
CREATE OR REPLACE FUNCTION cartlify.orders_before_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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

CREATE TRIGGER trg_orders_before_update
BEFORE UPDATE ON cartlify.orders
FOR EACH ROW
EXECUTE FUNCTION cartlify.orders_before_update();

-- 'product' CALC avgRating
CREATE OR REPLACE FUNCTION cartlify.recalc_product_rating(p_product_id integer)
RETURNS void
LANGUAGE plpgsql
AS $$
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

CREATE OR REPLACE FUNCTION cartlify.reviews_after_mod()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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

DROP TRIGGER IF EXISTS trg_reviews_after_mod ON cartlify.reviews;

CREATE TRIGGER trg_reviews_after_mod
AFTER INSERT OR UPDATE OR DELETE ON cartlify.reviews
FOR EACH ROW
EXECUTE FUNCTION cartlify.reviews_after_mod();

-- 'reviews' CALC upVotes & downVotes
CREATE OR REPLACE FUNCTION cartlify.recalc_review_votes(p_review_id integer)
RETURNS void
LANGUAGE plpgsql
AS $$
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

CREATE OR REPLACE FUNCTION cartlify.review_votes_after_mod()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
AFTER INSERT OR UPDATE OR DELETE ON cartlify.review_votes
FOR EACH ROW
EXECUTE FUNCTION cartlify.review_votes_after_mod();

-- 'products' CALC popularity
CREATE OR REPLACE FUNCTION cartlify.recalc_product_popularity(p_product_id integer)
RETURNS void
LANGUAGE plpgsql
AS $$
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
CREATE OR REPLACE FUNCTION cartlify.recalc_all_products_popularity()
RETURNS void
LANGUAGE plpgsql
AS $$
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
CREATE OR REPLACE FUNCTION cartlify.products_after_views_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."views" IS DISTINCT FROM OLD."views" THEN
    PERFORM cartlify.recalc_product_popularity(NEW.id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_after_views_change ON cartlify.products;

CREATE TRIGGER trg_products_after_views_change
AFTER UPDATE ON cartlify.products
FOR EACH ROW
EXECUTE FUNCTION cartlify.products_after_views_change();

--
CREATE OR REPLACE FUNCTION cartlify.favorites_after_mod_popularity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
AFTER INSERT OR DELETE ON cartlify.favorites
FOR EACH ROW
EXECUTE FUNCTION cartlify.favorites_after_mod_popularity();

--
CREATE OR REPLACE FUNCTION cartlify.order_items_after_mod_popularity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
AFTER INSERT OR UPDATE OR DELETE ON cartlify.order_items
FOR EACH ROW
EXECUTE FUNCTION cartlify.order_items_after_mod_popularity();

--
CREATE OR REPLACE FUNCTION cartlify.reviews_after_mod()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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

DROP TRIGGER IF EXISTS trg_reviews_after_mod ON cartlify.reviews;

CREATE TRIGGER trg_reviews_after_mod
AFTER INSERT OR UPDATE OR DELETE ON cartlify.reviews
FOR EACH ROW
EXECUTE FUNCTION cartlify.reviews_after_mod();

--
CREATE OR REPLACE FUNCTION cartlify.orders_after_update_popularity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
AFTER UPDATE ON cartlify.orders
FOR EACH ROW
EXECUTE FUNCTION cartlify.orders_after_update_popularity();

--'chat_threads' UPDATE last message info
CREATE OR REPLACE FUNCTION cartlify.chat_messages_after_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
AFTER INSERT ON cartlify.chat_messages
FOR EACH ROW
EXECUTE FUNCTION cartlify.chat_messages_after_insert();

--'product_price_change_logs' ADD column
CREATE OR REPLACE FUNCTION cartlify.log_product_price_change(
  p_product_id integer,
  p_actor_id   integer,
  p_old_price  numeric,
  p_new_price  numeric,
  p_mode       "PriceChangeMode",
  p_value      numeric
)
RETURNS void
LANGUAGE plpgsql
AS $$
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

-- 'AdminAuditLog' ADD column
CREATE OR REPLACE FUNCTION cartlify.log_admin_action(
  p_actor_id    integer,
  p_actor_role  "Role",
  p_entity_type "AdminAuditEntityType",
  p_entity_id   integer,
  p_action      "AdminAuditAction",
  p_changes     jsonb,      
  --p_ip          text,
  --p_user_agent  text
)
RETURNS void
LANGUAGE plpgsql
AS $$
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