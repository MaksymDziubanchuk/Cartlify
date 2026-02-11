BEGIN;

----------------------------------------
-- USERS
----------------------------------------
-- USERS: enable RLS
ALTER TABLE cartlify.users ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.users FORCE ROW LEVEL SECURITY;

-- reset (safe rerun)
DROP POLICY IF EXISTS users_select ON cartlify.users;

DROP POLICY IF EXISTS users_update ON cartlify.users;

DROP POLICY IF EXISTS users_insert ON cartlify.users;

DROP POLICY IF EXISTS users_delete ON cartlify.users;

-- SELECT: owner OR admin/owner
CREATE POLICY users_select ON cartlify.users FOR
SELECT
  USING (cartlify.is_owner_or_admin (id));

-- UPDATE:
-- - owner can update self but role must stay same as actor role
-- - root can update anyone (including role changes)
CREATE POLICY users_update ON cartlify.users
FOR UPDATE
  USING (
    cartlify.is_owner (id)
    OR cartlify.is_root ()
  )
WITH
  CHECK (
    (
      cartlify.is_owner (id)
      AND role = cartlify.current_actor_role ()
    )
    OR cartlify.is_root ()
  );

-- INSERT:
-- - registration can only create USER
-- - root can create USER/ADMIN
CREATE POLICY users_insert ON cartlify.users FOR INSERT
WITH
  CHECK (
    role = 'USER'
    OR (
      cartlify.is_root ()
      AND role IN ('USER', 'ADMIN')
    )
  );

-- DELETE: only root
CREATE POLICY users_delete ON cartlify.users FOR DELETE USING (cartlify.is_root ());

----------------------------------------
-- USERS TOKENS
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.user_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.user_tokens FORCE ROW LEVEL SECURITY;

-- reset (safe rerun)
DROP POLICY IF EXISTS user_tokens_select ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_insert ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_update ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_delete ON cartlify.user_tokens;

-- SELECT (owner or admin/root)
CREATE POLICY user_tokens_select ON cartlify.user_tokens FOR
SELECT
  USING (cartlify.is_owner_or_admin ("userId"));

-- INSERT (cannot create for other user)
CREATE POLICY user_tokens_insert ON cartlify.user_tokens FOR INSERT
WITH
  CHECK (
    cartlify.is_owner_or_admin ("userId")
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND type = 'VERIFY_EMAIL'
      AND "usedAt" IS NULL
      AND "expiresAt" > now()
      AND "expiresAt" <= now() + interval '48 hours'
    )
  );

-- UPDATE (cannot move token to other user)
CREATE POLICY user_tokens_update ON cartlify.user_tokens
FOR UPDATE
  USING (cartlify.is_owner_or_admin ("userId"))
WITH
  CHECK (cartlify.is_owner_or_admin ("userId"));

-- DELETE (owner or admin/root)
CREATE POLICY user_tokens_delete ON cartlify.user_tokens FOR DELETE USING (cartlify.is_owner_or_admin ("userId"));

----------------------------------------
-- LOGIN LOGS
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.login_logs ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.login_logs FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS login_logs_select ON cartlify.login_logs;

DROP POLICY IF EXISTS login_logs_insert ON cartlify.login_logs;

DROP POLICY IF EXISTS login_logs_update_deny ON cartlify.login_logs;

DROP POLICY IF EXISTS login_logs_delete_deny ON cartlify.login_logs;

-- SELECT (owner or admin/root)
CREATE POLICY login_logs_select ON cartlify.login_logs FOR
SELECT
  USING (cartlify.is_owner_or_admin ("userId"));

-- INSERT (owner only)
CREATE POLICY login_logs_insert ON cartlify.login_logs FOR INSERT
WITH
  CHECK (cartlify.is_owner ("userId"));

-- UPDATE (deny for all)
CREATE POLICY login_logs_update_deny ON cartlify.login_logs
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- DELETE (deny for all)
CREATE POLICY login_logs_delete_deny ON cartlify.login_logs FOR DELETE USING (false);

----------------------------------------
-- CATEGORIES
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.categories ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.categories FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS categories_select ON cartlify.categories;

DROP POLICY IF EXISTS categories_insert ON cartlify.categories;

DROP POLICY IF EXISTS categories_update ON cartlify.categories;

DROP POLICY IF EXISTS categories_delete ON cartlify.categories;

-- SELECT (public)
CREATE POLICY categories_select ON cartlify.categories FOR
SELECT
  USING (true);

-- INSERT (admin/root)
CREATE POLICY categories_insert ON cartlify.categories FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

-- UPDATE (admin/root)
CREATE POLICY categories_update ON cartlify.categories
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (cartlify.is_admin ());

-- DELETE (admin/root)
CREATE POLICY categories_delete ON cartlify.categories FOR DELETE USING (cartlify.is_admin ());

----------------------------------------
-- PRODUCTS
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.products ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.products NO FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS products_select ON cartlify.products;

DROP POLICY IF EXISTS products_insert ON cartlify.products;

DROP POLICY IF EXISTS products_update_admin ON cartlify.products;

DROP POLICY IF EXISTS products_update_computed ON cartlify.products;

DROP POLICY IF EXISTS products_delete ON cartlify.products;

-- SELECT (public)
CREATE POLICY products_select ON cartlify.products FOR
SELECT
  USING (true);

-- INSERT (admin/root)
CREATE POLICY products_insert ON cartlify.products FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

-- UPDATE (admin/root) - full update
CREATE POLICY products_update_admin ON cartlify.products
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (cartlify.is_admin ());

-- UPDATE (GUEST/USER/ADMIN/ROOT) - allow ONLY computed fields (for views + triggers)
-- allows changing: views, popularity, avgRating, reviewsCount, updatedAt
CREATE POLICY products_update_computed ON cartlify.products
FOR UPDATE
  USING (true)
WITH
  CHECK (
    cartlify.current_actor_role () IN ('GUEST', 'USER')
    AND (
      (to_jsonb(products) - 'views' - 'updatedAt') = (
        SELECT
          (to_jsonb(p) - 'views' - 'updatedAt')
        FROM
          cartlify.products p
        WHERE
          p.id = id
      )
    )
  );

-- DELETE (admin/root)
CREATE POLICY products_delete ON cartlify.products FOR DELETE USING (cartlify.is_admin ());

----------------------------------------
-- PRODUCT IMAGES
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.product_images ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.product_images FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS product_images_select ON cartlify.product_images;

DROP POLICY IF EXISTS product_images_insert ON cartlify.product_images;

DROP POLICY IF EXISTS product_images_update ON cartlify.product_images;

DROP POLICY IF EXISTS product_images_delete ON cartlify.product_images;

-- SELECT (public)
CREATE POLICY product_images_select ON cartlify.product_images FOR
SELECT
  USING (true);

-- INSERT (admin/root)
CREATE POLICY product_images_insert ON cartlify.product_images FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

-- UPDATE (admin/root)
CREATE POLICY product_images_update ON cartlify.product_images
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (cartlify.is_admin ());

-- DELETE (admin/root)
CREATE POLICY product_images_delete ON cartlify.product_images FOR DELETE USING (cartlify.is_admin ());

----------------------------------------
-- REVIEWS
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.reviews ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.reviews FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS reviews_select ON cartlify.reviews;

DROP POLICY IF EXISTS reviews_insert ON cartlify.reviews;

DROP POLICY IF EXISTS reviews_update_owner_comment_null ON cartlify.reviews;

DROP POLICY IF EXISTS reviews_delete ON cartlify.reviews;

-- SELECT (public)
CREATE POLICY reviews_select ON cartlify.reviews FOR
SELECT
  USING (true);

-- INSERT (user only)
CREATE POLICY reviews_insert ON cartlify.reviews FOR INSERT
WITH
  CHECK (
    cartlify.current_actor_role () = 'USER'
    AND (
      "rating" IS NOT NULL
      OR (
        "comment" IS NOT NULL
        AND btrim("comment") <> ''
      )
    )
  );

-- UPDATE (only owner can update with rules)
CREATE POLICY reviews_update_owner_comment_null ON cartlify.reviews USING (
  cartlify.is_owner ("userId")
  AND (
    "rating" IS NULL
    OR "comment" IS NULL
    OR btrim("comment") = ''
  )
)
WITH
  CHECK (
    cartlify.is_owner ("userId")
    AND (
      "rating" IS NOT NULL
      OR (
        "comment" IS NOT NULL
        AND btrim("comment") <> ''
      )
    )
  );

-- DELETE (owner or admin/root)
CREATE POLICY reviews_delete ON cartlify.reviews FOR DELETE USING (cartlify.is_owner_or_admin ("userId"));

----------------------------------------
-- REVIEW VOTES
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.review_votes ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.review_votes FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS review_votes_select ON cartlify.review_votes;

DROP POLICY IF EXISTS review_votes_insert ON cartlify.review_votes;

DROP POLICY IF EXISTS review_votes_update ON cartlify.review_votes;

DROP POLICY IF EXISTS review_votes_delete ON cartlify.review_votes;

-- SELECT (public)
CREATE POLICY review_votes_select ON cartlify.review_votes FOR
SELECT
  USING (true);

-- INSERT (user only)
CREATE POLICY review_votes_insert ON cartlify.review_votes FOR INSERT
WITH
  CHECK (cartlify.current_actor_role () = 'USER');

-- UPDATE (vote owner only)  -- switch UP <-> DOWN
CREATE POLICY review_votes_update ON cartlify.review_votes
FOR UPDATE
  USING (cartlify.is_owner ("userId"))
WITH
  CHECK (cartlify.is_owner ("userId"));

-- DELETE (owner only)
CREATE POLICY review_votes_delete ON cartlify.review_votes FOR DELETE USING (cartlify.is_owner ("userId"));

----------------------------------------
-- FAVORITES
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.favorites ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.favorites FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS favorites_select ON cartlify.favorites;

DROP POLICY IF EXISTS favorites_insert ON cartlify.favorites;

DROP POLICY IF EXISTS favorites_update ON cartlify.favorites;

DROP POLICY IF EXISTS favorites_delete ON cartlify.favorites;

-- SELECT (owner or admin/root)
CREATE POLICY favorites_select ON cartlify.favorites FOR
SELECT
  USING (
    cartlify.is_owner_or_admin ("userId")
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND "guestId" = cartlify.current_guest_id ()
    )
  );

-- INSERT (owner only)
CREATE POLICY favorites_insert ON cartlify.favorites FOR INSERT
WITH
  CHECK (
    (
      cartlify.current_actor_role () IN ('USER', 'ADMIN', 'ROOT')
      AND cartlify.is_owner ("userId")
      AND "guestId" IS NULL
    )
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND "guestId" = cartlify.current_guest_id ()
      AND "userId" IS NULL
    )
  );

-- UPDATE (guest to user only)
CREATE POLICY favorites_update ON cartlify.favorites
FOR UPDATE
  USING (
    cartlify.current_actor_role () IN ('USER', 'ADMIN', 'ROOT')
    AND "userId" IS NULL
    AND "guestId" IS NOT NULL
  )
WITH
  CHECK (
    "userId" = cartlify.current_actor_id ()
    AND "guestId" IS NULL
  );

-- DELETE (owner only)
CREATE POLICY favorites_delete ON cartlify.favorites FOR DELETE USING (
  cartlify.is_owner ("userId")
  OR (
    cartlify.current_actor_role () = 'GUEST'
    AND "guestId" = cartlify.current_guest_id ()
  )
);

----------------------------------------
-- ORDERS
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.orders ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.orders FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS orders_select ON cartlify.orders;

DROP POLICY IF EXISTS orders_insert ON cartlify.orders;

DROP POLICY IF EXISTS orders_update ON cartlify.orders;

DROP POLICY IF EXISTS orders_delete ON cartlify.orders;

-- SELECT (owner or admin/root)
CREATE POLICY orders_select ON cartlify.orders FOR
SELECT
  USING (cartlify.is_owner_or_admin ("userId"));

-- INSERT (owner only, USER role)
CREATE POLICY orders_insert ON cartlify.orders FOR INSERT
WITH
  CHECK (
    cartlify.current_actor_role () = 'USER'
    AND cartlify.is_owner ("userId")
  );

-- UPDATE (owner only) 
CREATE POLICY orders_update ON cartlify.orders
FOR UPDATE
  USING (
    cartlify.is_owner ("userId")
    AND confirmed = false
  )
WITH
  CHECK (cartlify.is_owner ("userId"));

-- DELETE (owner only, USER role, not confirmed)
CREATE POLICY orders_delete ON cartlify.orders FOR DELETE USING (
  cartlify.current_actor_role () = 'USER'
  AND cartlify.is_owner ("userId")
  AND confirmed = false
);

----------------------------------------
-- ORDER ITEMS
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.order_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.order_items FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS order_items_select ON cartlify.order_items;

DROP POLICY IF EXISTS order_items_insert ON cartlify.order_items;

DROP POLICY IF EXISTS order_items_update ON cartlify.order_items;

DROP POLICY IF EXISTS order_items_delete ON cartlify.order_items;

-- SELECT (via parent order)
CREATE POLICY order_items_select ON cartlify.order_items FOR
SELECT
  USING (
    EXISTS (
      SELECT
        1
      FROM
        cartlify.orders o
      WHERE
        o.id = "orderId"
        AND cartlify.is_owner_or_admin (o."userId")
    )
  );

-- INSERT (owner only, forbidden if confirmed)
CREATE POLICY order_items_insert ON cartlify.order_items FOR INSERT
WITH
  CHECK (
    cartlify.current_actor_role () = 'USER'
    AND EXISTS (
      SELECT
        1
      FROM
        cartlify.orders o
      WHERE
        o.id = "orderId"
        AND cartlify.is_owner (o."userId")
        AND o.confirmed = false
    )
  );

-- UPDATE (same as insert)
CREATE POLICY order_items_update ON cartlify.order_items
FOR UPDATE
  USING (
    cartlify.current_actor_role () = 'USER'
    AND EXISTS (
      SELECT
        1
      FROM
        cartlify.orders o
      WHERE
        o.id = "orderId"
        AND cartlify.is_owner (o."userId")
        AND o.confirmed = false
    )
  )
WITH
  CHECK (
    cartlify.current_actor_role () = 'USER'
    AND EXISTS (
      SELECT
        1
      FROM
        cartlify.orders o
      WHERE
        o.id = "orderId"
        AND cartlify.is_owner (o."userId")
        AND o.confirmed = false
    )
  );

-- DELETE (owner only, forbidden if confirmed)
CREATE POLICY order_items_delete ON cartlify.order_items FOR DELETE USING (
  cartlify.current_actor_role () = 'USER'
  AND EXISTS (
    SELECT
      1
    FROM
      cartlify.orders o
    WHERE
      o.id = "orderId"
      AND cartlify.is_owner (o."userId")
      AND o.confirmed = false
  )
);

----------------------------------------
-- CHAT THREADS
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.chat_threads ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.chat_threads FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS chat_threads_select ON cartlify.chat_threads;

DROP POLICY IF EXISTS chat_threads_insert ON cartlify.chat_threads;

DROP POLICY IF EXISTS chat_threads_update ON cartlify.chat_threads;

DROP POLICY IF EXISTS chat_threads_delete ON cartlify.chat_threads;

-- SELECT (owner or admin/root)
CREATE POLICY chat_threads_select ON cartlify.chat_threads FOR
SELECT
  USING (
    cartlify.is_owner_or_admin ("userId")
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND "guestId" = cartlify.current_guest_id ()
    )
  );

-- INSERT (owner only)
CREATE POLICY chat_threads_insert ON cartlify.chat_threads FOR INSERT
WITH
  CHECK (
    (
      cartlify.current_actor_role () IN ('USER', 'ADMIN', 'ROOT')
      AND cartlify.is_owner ("userId")
      AND "guestId" IS NULL
    )
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND "guestId" = cartlify.current_guest_id ()
      AND "userId" IS NULL
    )
  );

-- UPDATE (owner or admin/root)
CREATE POLICY chat_threads_update ON cartlify.chat_threads
FOR UPDATE
  USING (
    cartlify.is_owner_or_admin ("userId")
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND "guestId" = cartlify.current_guest_id ()
    )
    OR (
      cartlify.current_actor_role () IN ('USER', 'ADMIN', 'ROOT')
      AND "userId" IS NULL
      AND "guestId" IS NOT NULL
    )
  )
WITH
  CHECK (
    cartlify.is_owner_or_admin ("userId")
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND "guestId" = cartlify.current_guest_id ()
    )
    OR (
      "userId" = cartlify.current_actor_id ()
      AND "guestId" IS NULL
    )
  );

-- DELETE (deny for all)
CREATE POLICY chat_threads_delete ON cartlify.chat_threads FOR DELETE USING (false);

----------------------------------------
-- CHAT MESSAGES
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.chat_messages ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.chat_messages FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS chat_messages_select ON cartlify.chat_messages;

DROP POLICY IF EXISTS chat_messages_insert ON cartlify.chat_messages;

DROP POLICY IF EXISTS chat_messages_update ON cartlify.chat_messages;

DROP POLICY IF EXISTS chat_messages_delete ON cartlify.chat_messages;

-- SELECT (via parent thread)
CREATE POLICY chat_messages_select ON cartlify.chat_messages FOR
SELECT
  USING (
    EXISTS (
      SELECT
        1
      FROM
        cartlify.chat_threads t
      WHERE
        t.id = "threadId"
        AND (
          cartlify.is_owner_or_admin (t."userId")
          OR (
            cartlify.current_actor_role () = 'GUEST'
            AND t."guestId" = cartlify.current_guest_id ()
          )
        )
    )
  );

-- INSERT (via parent thread)
CREATE POLICY chat_messages_insert ON cartlify.chat_messages FOR INSERT
WITH
  CHECK (
    EXISTS (
      SELECT
        1
      FROM
        cartlify.chat_threads t
      WHERE
        t.id = "threadId"
        AND (
          cartlify.is_owner_or_admin (t."userId")
          OR (
            cartlify.current_actor_role () = 'GUEST'
            AND t."guestId" = cartlify.current_guest_id ()
          )
        )
    )
  );

-- UPDATE (deny for all)
CREATE POLICY chat_messages_update ON cartlify.chat_messages
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- DELETE (deny for all)
CREATE POLICY chat_messages_delete ON cartlify.chat_messages FOR DELETE USING (false);

----------------------------------------
-- PRODUCT PRICE CHANGE LOGS
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.product_price_change_logs ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.product_price_change_logs FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS ppcl_select ON cartlify.product_price_change_logs;

DROP POLICY IF EXISTS ppcl_insert ON cartlify.product_price_change_logs;

DROP POLICY IF EXISTS ppcl_update_deny ON cartlify.product_price_change_logs;

DROP POLICY IF EXISTS ppcl_delete_deny ON cartlify.product_price_change_logs;

-- SELECT (admin/root)
CREATE POLICY ppcl_select ON cartlify.product_price_change_logs FOR
SELECT
  USING (cartlify.is_admin ());

-- INSERT (admin/root)
CREATE POLICY ppcl_insert ON cartlify.product_price_change_logs FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

-- UPDATE (deny for all)
CREATE POLICY ppcl_update_deny ON cartlify.product_price_change_logs
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- DELETE (deny for all)
CREATE POLICY ppcl_delete_deny ON cartlify.product_price_change_logs FOR DELETE USING (false);

----------------------------------------
-- ADMIN AUDIT LOG
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.admin_audit_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.admin_audit_log FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS aal_select ON cartlify.admin_audit_log;

DROP POLICY IF EXISTS aal_insert ON cartlify.admin_audit_log;

DROP POLICY IF EXISTS aal_update_deny ON cartlify.admin_audit_log;

DROP POLICY IF EXISTS aal_delete_deny ON cartlify.admin_audit_log;

-- SELECT (admin/root)
CREATE POLICY aal_select ON cartlify.admin_audit_log FOR
SELECT
  USING (cartlify.is_admin ());

-- INSERT (admin/root)
CREATE POLICY aal_insert ON cartlify.admin_audit_log FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

-- UPDATE (deny for all)
CREATE POLICY aal_update_deny ON cartlify.admin_audit_log
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- DELETE (deny for all)
CREATE POLICY aal_delete_deny ON cartlify.admin_audit_log FOR DELETE USING (false);

COMMIT;