BEGIN;

-- everything below is created and owned by cartlify_owner, whoever runs the script
SET LOCAL ROLE cartlify_owner;

----------------------------------------
-- USERS
----------------------------------------
-- USERS: enable RLS
ALTER TABLE cartlify.users ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.users FORCE ROW LEVEL SECURITY;

-- reset (safe rerun)
DROP POLICY IF EXISTS users_select ON cartlify.users;

DROP POLICY IF EXISTS users_update ON cartlify.users;

DROP POLICY IF EXISTS users_update_owner ON cartlify.users;

DROP POLICY IF EXISTS users_update_owner_avatar ON cartlify.users;

DROP POLICY IF EXISTS users_insert ON cartlify.users;

DROP POLICY IF EXISTS users_select_owner ON cartlify.users;

DROP POLICY IF EXISTS users_delete ON cartlify.users;

-- SELECT: owner OR admin/owner
CREATE POLICY users_select ON cartlify.users FOR
SELECT
  USING (cartlify.is_owner_or_admin (id));

-- SELECT: only for cartlify_owner
CREATE POLICY users_select_owner ON cartlify.users FOR
SELECT
  TO cartlify_owner USING (true);

-- UPDATE:
-- - owner can update self but role must stay same as actor role, and never changes the own role:
--   root took a role away, the access token of the account still holds the old one some minutes
-- - owner cannot change email
-- - owner cannot change isVerified, except unverified LOCAL account taken over by oauth provider
-- - owner cannot change deletedAt, and a deleted account cannot be changed by its owner at all:
--   its access token lives on for a few minutes, it must not fill the emptied row again
-- - root can update anyone (including role changes and the deletion)
CREATE POLICY users_update ON cartlify.users
FOR UPDATE
  USING (
    (
      cartlify.is_owner (id)
      AND "deletedAt" IS NULL
    )
    OR cartlify.is_root ()
  )
WITH
  CHECK (
    (
      cartlify.is_owner (id)
      AND role = cartlify.current_actor_role ()
      AND "deletedAt" IS NULL
      AND EXISTS (
        SELECT
          1
        FROM
          cartlify.users u
        WHERE
          u.id = users.id
          AND u.email = users.email
          AND u.role = users.role
          AND (
            u."isVerified" = users."isVerified"
            OR (
              u."authProvider" = 'LOCAL'
              AND users."authProvider" <> 'LOCAL'
              AND users."isVerified" = true
              AND users."passwordHash" IS NULL
            )
          )
      )
    )
    OR cartlify.is_root ()
  );

-- UPDATE cartlify_owner - email verification only, other fields stay the same
CREATE POLICY users_update_owner ON cartlify.users
FOR UPDATE
  TO cartlify_owner USING ("isVerified" = false)
WITH
  CHECK (
    "isVerified" = true
    AND (
      (to_jsonb(users) - 'isVerified' - 'updatedAt') = (
        SELECT
          to_jsonb(u) - 'isVerified' - 'updatedAt'
        FROM
          cartlify.users u
        WHERE
          u.id = users.id
      )
    )
  );

-- UPDATE cartlify_owner for remove_user_avatar only: the avatar of an account goes, nothing else
-- of the row changes but the time of the change
CREATE POLICY users_update_owner_avatar ON cartlify.users
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  CHECK (
    "avatarUrl" IS NULL
    AND "publicId" IS NULL
    AND (
      (to_jsonb(users) - 'avatarUrl' - 'publicId' - 'updatedAt') = (
        SELECT
          to_jsonb(u) - 'avatarUrl' - 'publicId' - 'updatedAt'
        FROM
          cartlify.users u
        WHERE
          u.id = users.id
      )
    )
  );

-- INSERT:
-- - registration can only create unverified USER
-- - admin context (oauth sign-in) can create verified USER
-- - root can create USER/ADMIN
CREATE POLICY users_insert ON cartlify.users FOR INSERT
WITH
  CHECK (
    (
      role = 'USER'
      AND (
        "isVerified" = false
        OR cartlify.is_admin ()
      )
    )
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

DROP POLICY IF EXISTS user_tokens_select_owner ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_insert_owner ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_insert ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_update ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_update_owner ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_delete ON cartlify.user_tokens;

-- SELECT (owner or admin/root)
CREATE POLICY user_tokens_select ON cartlify.user_tokens FOR
SELECT
  USING (cartlify.is_owner_or_admin ("userId"));

-- SELECT cartlify_owner: the email verification links, open and used; a function that marks
-- a link used has to see the row after the change as well, postgres checks it against SELECT
CREATE POLICY user_tokens_select_owner ON cartlify.user_tokens FOR
SELECT
  TO cartlify_owner USING (type = 'VERIFY_EMAIL');

-- INSERT (cannot create for other user): a user writes the own sessions and, at the registration,
-- the own verification link; a password reset link comes only from the system (the admin context
-- without a user id), one of the user's own would reset the password without knowing it
CREATE POLICY user_tokens_insert ON cartlify.user_tokens FOR INSERT
WITH
  CHECK (
    cartlify.is_system ()
    OR (
      cartlify.is_owner ("userId")
      AND type IN ('REFRESH_TOKEN', 'VERIFY_EMAIL')
    )
  );

-- INSERT cartlify_owner
CREATE POLICY user_tokens_insert_owner ON cartlify.user_tokens FOR INSERT TO cartlify_owner
WITH
  CHECK (
    type = 'VERIFY_EMAIL'
    AND "usedAt" IS NULL
    AND "expiresAt" > now()
  );

-- UPDATE (cannot move token to other user): a token keeps its user and its kind, a closed token
-- stays closed (logout, rotation and reset end a session for good); a session gets its hash and
-- deadline once it is made, every other link keeps them and is only closed
CREATE POLICY user_tokens_update ON cartlify.user_tokens
FOR UPDATE
  USING (cartlify.is_owner_or_admin ("userId"))
WITH
  CHECK (
    cartlify.is_owner_or_admin ("userId")
    AND EXISTS (
      SELECT
        1
      FROM
        cartlify.user_tokens AS t
      WHERE
        t.id = user_tokens.id
        AND t."userId" = user_tokens."userId"
        AND t.type = user_tokens.type
        AND (
          t."usedAt" IS NULL
          OR user_tokens."usedAt" IS NOT NULL
        )
        AND (
          user_tokens.type = 'REFRESH_TOKEN'
          OR (
            t.token = user_tokens.token
            AND t."expiresAt" = user_tokens."expiresAt"
          )
        )
    )
  );

-- UPDATE cartlify_owner
CREATE POLICY user_tokens_update_owner ON cartlify.user_tokens
FOR UPDATE
  TO cartlify_owner USING (
    type = 'VERIFY_EMAIL'
    AND "usedAt" IS NULL
    AND "expiresAt" > now()
  )
WITH
  CHECK (
    type = 'VERIFY_EMAIL'
    AND "usedAt" IS NOT NULL
  );

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

DROP POLICY IF EXISTS login_logs_update_owner ON cartlify.login_logs;

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

-- UPDATE cartlify_owner for anonymize_login_logs only: a line of a deleted account takes the email
-- the account has now, nothing else of it changes
CREATE POLICY login_logs_update_owner ON cartlify.login_logs
FOR UPDATE
  TO cartlify_owner USING (
    EXISTS (
      SELECT
        1
      FROM
        cartlify.users AS u
      WHERE
        u.id = login_logs."userId"
        AND u."deletedAt" IS NOT NULL
    )
  )
WITH
  CHECK (
    EXISTS (
      SELECT
        1
      FROM
        cartlify.users AS u
      WHERE
        u.id = login_logs."userId"
        AND u."deletedAt" IS NOT NULL
        AND u.email = login_logs.email
    )
    AND (to_jsonb(login_logs) - 'email') = (
      SELECT
        to_jsonb(l) - 'email'
      FROM
        cartlify.login_logs AS l
      WHERE
        l.id = login_logs.id
    )
  );

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

ALTER TABLE cartlify.products FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS products_select ON cartlify.products;

DROP POLICY IF EXISTS products_insert ON cartlify.products;

DROP POLICY IF EXISTS products_update_admin ON cartlify.products;

DROP POLICY IF EXISTS products_update_computed ON cartlify.products;

DROP POLICY IF EXISTS products_update_owner ON cartlify.products;

DROP POLICY IF EXISTS products_delete ON cartlify.products;

-- SELECT (public)
CREATE POLICY products_select ON cartlify.products FOR
SELECT
  USING (true);

-- INSERT (admin/root): a new product starts with no reserve, rating, reviews, popularity or views,
-- the database counts them from what happens to it
CREATE POLICY products_insert ON cartlify.products FOR INSERT
WITH
  CHECK (
    cartlify.is_admin ()
    AND "reservedStock" = 0
    AND "avgRating" = 0
    AND "reviewsCount" = 0
    AND popularity = 0
    AND views = 0
  );

-- UPDATE (admin/root) - every field but the ones the database counts: the reserve (what the
-- waiting orders hold), the rating and the count of reviews (the reviews), the popularity (what
-- people do; an admin sets popularityOverride instead). A visit of an admin adds one view like any
-- other. The steps of the database change these through products_update_owner
CREATE POLICY products_update_admin ON cartlify.products
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (
    cartlify.is_admin ()
    AND EXISTS (
      SELECT
        1
      FROM
        cartlify.products AS p
      WHERE
        p.id = products.id
        AND p."reservedStock" = products."reservedStock"
        AND p."avgRating" = products."avgRating"
        AND p."reviewsCount" = products."reviewsCount"
        AND p.popularity = products.popularity
        AND products.views IN (p.views, p.views + 1)
    )
  );

-- UPDATE (GUEST/USER)
-- allows changing: views, updatedAt
-- views step is limited to +1 by trg_products_before_views_change
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
          p.id = products.id
      )
    )
  );

-- UPDATE cartlify_owner
CREATE POLICY products_update_owner ON cartlify.products
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  CHECK (
    (
      "avgRating" >= 0
      AND "avgRating" <= 5
      AND "reviewsCount" >= 0
      AND (
        (
          to_jsonb(products) - 'avgRating' - 'reviewsCount' - 'updatedAt'
        ) = (
          SELECT
            to_jsonb(p) - 'avgRating' - 'reviewsCount' - 'updatedAt'
          FROM
            cartlify.products p
          WHERE
            p.id = products.id
        )
      )
    )
    OR (
      "stock" >= 0
      AND "reservedStock" >= 0
      AND "reservedStock" <= "stock"
      AND (
        (
          to_jsonb(products) - 'stock' - 'reservedStock' - 'updatedAt'
        ) = (
          SELECT
            to_jsonb(p) - 'stock' - 'reservedStock' - 'updatedAt'
          FROM
            cartlify.products p
          WHERE
            p.id = products.id
        )
      )
    )
    OR (
      "popularity" >= 0
      AND (
        (to_jsonb(products) - 'popularity' - 'updatedAt') = (
          SELECT
            to_jsonb(p) - 'popularity' - 'updatedAt'
          FROM
            cartlify.products p
          WHERE
            p.id = products.id
        )
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

DROP POLICY IF EXISTS reviews_update_owner_votes ON cartlify.reviews;

DROP POLICY IF EXISTS reviews_delete ON cartlify.reviews;

-- SELECT (public)
CREATE POLICY reviews_select ON cartlify.reviews FOR
SELECT
  USING (true);

-- INSERT (user only, own review)
CREATE POLICY reviews_insert ON cartlify.reviews FOR INSERT
WITH
  CHECK (
    cartlify.current_actor_role () = 'USER'
    AND cartlify.is_owner ("userId")
    AND (
      "rating" IS NOT NULL
      OR (
        "comment" IS NOT NULL
        AND btrim("comment") <> ''
      )
    )
  );

-- UPDATE (only owner can update with rules)
CREATE POLICY reviews_update_owner_comment_null ON cartlify.reviews
FOR UPDATE
  USING (
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
    -- the author adds the missing rating or comment and nothing else: the votes are counted
    -- from review_votes (reviews_update_owner_votes)
    AND (to_jsonb(reviews) - 'rating' - 'comment' - 'updatedAt') = (
      SELECT
        to_jsonb(r) - 'rating' - 'comment' - 'updatedAt'
      FROM
        cartlify.reviews AS r
      WHERE
        r.id = reviews.id
    )
  );

-- UPDATE vote counters by system functions
CREATE POLICY reviews_update_owner_votes ON cartlify.reviews
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  CHECK (
    "upVotes" >= 0
    AND "downVotes" >= 0
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

DROP POLICY IF EXISTS review_votes_select_owner ON cartlify.review_votes;

DROP POLICY IF EXISTS review_votes_insert ON cartlify.review_votes;

DROP POLICY IF EXISTS review_votes_update ON cartlify.review_votes;

DROP POLICY IF EXISTS review_votes_delete ON cartlify.review_votes;

-- SELECT (the voter, admin/root): who voted how belongs to the voter, everybody else reads
-- the counts the review keeps (upVotes, downVotes)
CREATE POLICY review_votes_select ON cartlify.review_votes FOR
SELECT
  USING (cartlify.is_owner_or_admin ("userId"));

-- SELECT cartlify_owner for system functions: the counts of a review take every vote
CREATE POLICY review_votes_select_owner ON cartlify.review_votes FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT (user only, own vote, on the review of another user)
CREATE POLICY review_votes_insert ON cartlify.review_votes FOR INSERT
WITH
  CHECK (
    cartlify.current_actor_role () = 'USER'
    AND cartlify.is_owner ("userId")
    AND NOT EXISTS (
      SELECT 1
      FROM cartlify.reviews AS r
      WHERE r.id = review_votes."reviewId"
        AND r."userId" = review_votes."userId"
    )
  );

-- UPDATE (vote owner only)  -- switch UP <-> DOWN, never onto an own review
CREATE POLICY review_votes_update ON cartlify.review_votes
FOR UPDATE
  USING (cartlify.is_owner ("userId"))
WITH
  CHECK (
    cartlify.is_owner ("userId")
    AND NOT EXISTS (
      SELECT 1
      FROM cartlify.reviews AS r
      WHERE r.id = review_votes."reviewId"
        AND r."userId" = review_votes."userId"
    )
  );

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

DROP POLICY IF EXISTS favorites_select_owner ON cartlify.favorites;

DROP POLICY IF EXISTS favorites_insert ON cartlify.favorites;

DROP POLICY IF EXISTS favorites_update_owner ON cartlify.favorites;

DROP POLICY IF EXISTS favorites_delete ON cartlify.favorites;

DROP POLICY IF EXISTS favorites_delete_owner ON cartlify.favorites;

-- SELECT (owner or admin/root, or guest owner)
CREATE POLICY favorites_select ON cartlify.favorites FOR
SELECT
  USING (
    cartlify.is_owner_or_admin ("userId")
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND "guestId" = cartlify.current_guest_id ()
    )
  );

-- SELECT cartlify_owner for system functions
CREATE POLICY favorites_select_owner ON cartlify.favorites FOR
SELECT
  TO cartlify_owner USING (true);

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

-- UPDATE cartlify_owner for migrate_guest_data_to_user only:
-- a guest row may only become a user row, nothing else about a favorite changes
CREATE POLICY favorites_update_owner ON cartlify.favorites
FOR UPDATE
  TO cartlify_owner USING ("userId" IS NULL)
WITH
  CHECK (
    "userId" IS NOT NULL
    AND "guestId" IS NULL
  );

-- DELETE (owner or guest owner)
CREATE POLICY favorites_delete ON cartlify.favorites FOR DELETE USING (
  cartlify.is_owner ("userId")
  OR (
    cartlify.current_actor_role () = 'GUEST'
    AND "guestId" = cartlify.current_guest_id ()
  )
);

-- DELETE cartlify_owner for migrate_guest_data_to_user only:
-- guest rows the user already has as their own favorites are dropped before the move
CREATE POLICY favorites_delete_owner ON cartlify.favorites FOR DELETE TO cartlify_owner USING ("userId" IS NULL);

----------------------------------------
-- ORDERS
----------------------------------------
-- enable RLS
ALTER TABLE cartlify.orders ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.orders FORCE ROW LEVEL SECURITY;

-- reset policies (safe rerun)
DROP POLICY IF EXISTS orders_select ON cartlify.orders;

DROP POLICY IF EXISTS orders_select_owner ON cartlify.orders;

DROP POLICY IF EXISTS orders_insert ON cartlify.orders;

DROP POLICY IF EXISTS orders_update ON cartlify.orders;

DROP POLICY IF EXISTS orders_update_admin_shipping_status ON cartlify.orders;

DROP POLICY IF EXISTS orders_update_owner ON cartlify.orders;

DROP POLICY IF EXISTS orders_update_owner_cancel ON cartlify.orders;

DROP POLICY IF EXISTS orders_delete ON cartlify.orders;

-- SELECT (owner or admin/root)
CREATE POLICY orders_select ON cartlify.orders FOR
SELECT
  USING (cartlify.is_owner_or_admin ("userId"));

-- SELECT cartlify_owner for system functions
CREATE POLICY orders_select_owner ON cartlify.orders FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT (owner only, USER role)
CREATE POLICY orders_insert ON cartlify.orders FOR INSERT
WITH
  CHECK (
    cartlify.current_actor_role () = 'USER'
    AND cartlify.is_owner ("userId")
    AND confirmed = false
    AND status = 'pending'
    AND "reservationExpiresAt" IS NULL
    AND "paymentId" IS NULL
    AND "paymentProvider" IS NULL
  );

-- UPDATE (owner only, order stays unconfirmed; confirmation goes through cartlify.confirm_order)
-- a plain update of the owner writes the shipping data and the note; the status, the total and
-- the dates change only through the steps of the database (functions and triggers)
CREATE POLICY orders_update ON cartlify.orders
FOR UPDATE
  USING (
    cartlify.is_owner ("userId")
    AND confirmed = false
  )
WITH
  CHECK (
    cartlify.is_owner ("userId")
    AND "paymentId" IS NULL
    AND "paymentProvider" IS NULL
    AND confirmed = false
    AND status IN ('pending', 'unconfirmed')
    AND "reservationExpiresAt" IS NULL
    AND (
      (
        to_jsonb(orders) - 'shippingAddress' - 'recipientFirstName' - 'recipientLastName' - 'recipientPhone' - 'note' - 'updatedAt'
      ) = (
        SELECT
          to_jsonb(o) - 'shippingAddress' - 'recipientFirstName' - 'recipientLastName' - 'recipientPhone' - 'note' - 'updatedAt'
        FROM
          cartlify.orders AS o
        WHERE
          o.id = orders.id
      )
    )
  );

-- UPDATE cartlify_owner
CREATE POLICY orders_update_owner ON cartlify.orders
FOR UPDATE
  TO cartlify_owner USING (
    confirmed = false
    OR (
      confirmed = true
      AND status = 'waiting'
      AND "reservationExpiresAt" IS NOT NULL
    )
  )
WITH
  CHECK (
    (
      "total" >= 0
      AND (
        (to_jsonb(orders) - 'total' - 'updatedAt') = (
          SELECT
            to_jsonb(o) - 'total' - 'updatedAt'
          FROM
            cartlify.orders o
          WHERE
            o.id = orders.id
        )
      )
    )
    OR (
      confirmed = false
      AND status = 'pending'
      AND "reservationExpiresAt" IS NULL
      AND (
        (
          to_jsonb(orders) - 'confirmed' - 'status' - 'reservationExpiresAt' - 'updatedAt'
        ) = (
          SELECT
            to_jsonb(o) - 'confirmed' - 'status' - 'reservationExpiresAt' - 'updatedAt'
          FROM
            cartlify.orders o
          WHERE
            o.id = orders.id
        )
      )
    )
    OR (
      confirmed = false
      AND status = 'unconfirmed'
      AND "reservationExpiresAt" IS NULL
      AND (
        (
          to_jsonb(orders) - 'confirmed' - 'status' - 'reservationExpiresAt' - 'updatedAt'
        ) = (
          SELECT
            to_jsonb(o) - 'confirmed' - 'status' - 'reservationExpiresAt' - 'updatedAt'
          FROM
            cartlify.orders AS o
          WHERE
            o.id = orders.id
        )
      )
    )
    OR (
      confirmed = true
      AND status = 'waiting'
      AND "reservationExpiresAt" IS NOT NULL
      AND "paymentId" IS NULL
      AND "paymentProvider" IS NULL
      AND "total" >= 0
      AND cartlify.is_owner ("userId")
      AND (
        (
          to_jsonb(orders) - 'confirmed' - 'status' - 'reservationExpiresAt' - 'total' - 'updatedAt'
        ) = (
          SELECT
            to_jsonb(o) - 'confirmed' - 'status' - 'reservationExpiresAt' - 'total' - 'updatedAt'
          FROM
            cartlify.orders AS o
          WHERE
            o.id = orders.id
        )
      )
    )
    -- pay_order: the payment and who took it are set together, nothing else but the state changes
    OR (
      confirmed = true
      AND status = 'paid'
      AND "reservationExpiresAt" IS NULL
      AND "paymentId" IS NOT NULL
      AND "paymentProvider" IS NOT NULL
      AND "total" >= 0
      AND (
        (
          to_jsonb(orders) - 'confirmed' - 'status' - 'reservationExpiresAt' - 'paymentId' - 'paymentProvider' - 'total' - 'updatedAt'
        ) = (
          SELECT
            to_jsonb(o) - 'confirmed' - 'status' - 'reservationExpiresAt' - 'paymentId' - 'paymentProvider' - 'total' - 'updatedAt'
          FROM
            cartlify.orders AS o
          WHERE
            o.id = orders.id
        )
      )
    )
  );

-- UPDATE (admin/root) - allow only shipping status change
-- a cancel is not a status change here: it goes through cartlify.cancel_paid_order with the stock return
CREATE POLICY orders_update_admin_shipping_status ON cartlify.orders
FOR UPDATE
  USING (
    cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
    AND status IN ('paid', 'shipped')
  )
WITH
  CHECK (
    cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
    AND status IN ('shipped', 'delivered')
    AND (
      (to_jsonb(orders) - 'status' - 'updatedAt') = (
        SELECT
          (to_jsonb(o) - 'status' - 'updatedAt')
        FROM
          cartlify.orders o
        WHERE
          o.id = orders.id
      )
    )
  );

-- UPDATE cartlify_owner for cancel_paid_order only: a paid or shipped order of the admin context
-- becomes cancelled and nothing else changes; the rows it reaches are the ones the admin policy
-- above reaches already, so it opens no other order to the system functions
CREATE POLICY orders_update_owner_cancel ON cartlify.orders
FOR UPDATE
  TO cartlify_owner USING (
    cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
    AND status IN ('paid', 'shipped')
  )
WITH
  CHECK (
    cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
    AND status = 'cancelled'
    AND (
      (to_jsonb(orders) - 'status' - 'updatedAt') = (
        SELECT
          (to_jsonb(o) - 'status' - 'updatedAt')
        FROM
          cartlify.orders o
        WHERE
          o.id = orders.id
      )
    )
  );

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

DROP POLICY IF EXISTS order_items_select_owner ON cartlify.order_items;

DROP POLICY IF EXISTS order_items_insert ON cartlify.order_items;

DROP POLICY IF EXISTS order_items_update ON cartlify.order_items;

DROP POLICY IF EXISTS order_items_update_owner ON cartlify.order_items;

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

-- SELECT cartlify_owner
CREATE POLICY order_items_select_owner ON cartlify.order_items FOR
SELECT
  TO cartlify_owner USING (true);

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

-- UPDATE cartlify_owner - row locks only, for unconfirm/pay/expire
CREATE POLICY order_items_update_owner ON cartlify.order_items
FOR UPDATE
  TO cartlify_owner USING (
    EXISTS (
      SELECT
        1
      FROM
        cartlify.orders o
      WHERE
        o.id = "orderId"
        AND (
          (
            o.confirmed = true
            AND o.status = 'waiting'
          )
          OR (
            o.confirmed = false
            AND o.status IN ('pending', 'unconfirmed')
          )
        )
    )
  )
WITH
  CHECK (false);

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

DROP POLICY IF EXISTS chat_threads_select_owner ON cartlify.chat_threads;

DROP POLICY IF EXISTS chat_threads_update_owner ON cartlify.chat_threads;

-- SELECT (owner or admin/root, or guest owner)
CREATE POLICY chat_threads_select ON cartlify.chat_threads FOR
SELECT
  USING (
    cartlify.is_owner_or_admin ("userId")
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND "guestId" = cartlify.current_guest_id ()
    )
  );

-- SELECT cartlify_owner for migrate_guest_data_to_user only: guest threads, the ones it moves
CREATE POLICY chat_threads_select_owner ON cartlify.chat_threads FOR
SELECT
  TO cartlify_owner USING ("userId" IS NULL);

-- INSERT (owner only); a chat that asks for an admin at once asks now: the admin queue goes by
-- adminRequestedAt, an earlier time would put it before the ones that waited longer (a minute is
-- left for the clock of the server)
CREATE POLICY chat_threads_insert ON cartlify.chat_threads FOR INSERT
WITH
  CHECK (
    (
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
    )
    AND (
      "adminRequestedAt" IS NULL
      OR "adminRequestedAt" >= (now() AT TIME ZONE 'UTC') - interval '1 minute'
    )
  );

-- UPDATE (owner, admin/root, or guest owner). A chat keeps its user or guest (the guest chat of a
-- login moves through chat_threads_update_owner), a closed chat is history and stays closed, and a
-- request for an admin is made now, never earlier (the queue goes by adminRequestedAt)
CREATE POLICY chat_threads_update ON cartlify.chat_threads
FOR UPDATE
  USING (
    cartlify.is_owner_or_admin ("userId")
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND "guestId" = cartlify.current_guest_id ()
    )
  )
WITH
  CHECK (
    (
      cartlify.is_owner_or_admin ("userId")
      OR (
        cartlify.current_actor_role () = 'GUEST'
        AND "guestId" = cartlify.current_guest_id ()
      )
    )
    AND EXISTS (
      SELECT
        1
      FROM
        cartlify.chat_threads AS t
      WHERE
        t.id = chat_threads.id
        AND t."userId" IS NOT DISTINCT FROM chat_threads."userId"
        AND t."guestId" IS NOT DISTINCT FROM chat_threads."guestId"
        AND (
          t.status <> 'closed'
          OR chat_threads.status = 'closed'
        )
        AND (
          chat_threads."adminRequestedAt" IS NULL
          OR chat_threads."adminRequestedAt" IS NOT DISTINCT FROM t."adminRequestedAt"
          OR chat_threads."adminRequestedAt" >= (now() AT TIME ZONE 'UTC') - interval '1 minute'
        )
    )
  );

-- UPDATE cartlify_owner for migrate_guest_data_to_user only:
-- a guest thread may only become a user thread
CREATE POLICY chat_threads_update_owner ON cartlify.chat_threads
FOR UPDATE
  TO cartlify_owner USING ("userId" IS NULL)
WITH
  CHECK (
    "userId" IS NOT NULL
    AND "guestId" IS NULL
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

-- INSERT (via parent thread, sender must match the actor)
-- - user writes as user with own id, in own thread
-- - guest writes as guest, in own bot thread
-- - admin/root writes as admin with own id, in admin thread only
-- - bot messages are stored by the server in the customer context, in bot thread only
CREATE POLICY chat_messages_insert ON cartlify.chat_messages FOR INSERT
WITH
  CHECK (
    EXISTS (
      SELECT
        1
      FROM
        cartlify.chat_threads t
      WHERE
        t.id = chat_messages."threadId"
        -- a closed chat is history and takes no new message
        AND t.status = 'open'
        AND (
          (
            cartlify.current_actor_role () = 'USER'
            AND t."userId" = cartlify.current_actor_id ()
            AND (
              (
                chat_messages."senderType" = 'user'
                AND chat_messages."senderId" = cartlify.current_actor_id ()
              )
              OR (
                chat_messages."senderType" = 'bot'
                AND chat_messages."senderId" IS NULL
                AND t.type = 'bot'
              )
            )
          )
          OR (
            cartlify.current_actor_role () = 'GUEST'
            AND t."guestId" = cartlify.current_guest_id ()
            AND t.type = 'bot'
            AND chat_messages."senderType" IN ('guest', 'bot')
            AND chat_messages."senderId" IS NULL
          )
          OR (
            cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
            AND t.type = 'admin'
            AND chat_messages."senderType" = 'admin'
            AND chat_messages."senderId" = cartlify.current_actor_id ()
          )
        )
    )
  );

-- UPDATE (allowed readers can change only isRead)
-- other columns are locked by trg_chat_messages_before_update
CREATE POLICY chat_messages_update ON cartlify.chat_messages
FOR UPDATE
  USING (
    (
      cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
      AND "senderType" IN ('user', 'guest')
      AND EXISTS (
        SELECT
          1
        FROM
          cartlify.chat_threads t
        WHERE
          t.id = "threadId"
          AND t.type = 'admin'
      )
    )
    OR (
      cartlify.current_actor_role () = 'USER'
      AND "senderType" IN ('bot', 'admin')
      AND EXISTS (
        SELECT
          1
        FROM
          cartlify.chat_threads t
        WHERE
          t.id = "threadId"
          AND t."userId" = cartlify.current_actor_id ()
      )
    )
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND "senderType" = 'bot'
      AND EXISTS (
        SELECT
          1
        FROM
          cartlify.chat_threads t
        WHERE
          t.id = "threadId"
          AND t.type = 'bot'
          AND t."guestId" = cartlify.current_guest_id ()
      )
    )
  )
WITH
  CHECK (
    "isRead" = true
    AND (
      (
        cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
        AND "senderType" IN ('user', 'guest')
        AND EXISTS (
          SELECT
            1
          FROM
            cartlify.chat_threads t
          WHERE
            t.id = "threadId"
            AND t.type = 'admin'
        )
      )
      OR (
        cartlify.current_actor_role () = 'USER'
        AND "senderType" IN ('bot', 'admin')
        AND EXISTS (
          SELECT
            1
          FROM
            cartlify.chat_threads t
          WHERE
            t.id = "threadId"
            AND t."userId" = cartlify.current_actor_id ()
        )
      )
      OR (
        cartlify.current_actor_role () = 'GUEST'
        AND "senderType" = 'bot'
        AND EXISTS (
          SELECT
            1
          FROM
            cartlify.chat_threads t
          WHERE
            t.id = "threadId"
            AND t.type = 'bot'
            AND t."guestId" = cartlify.current_guest_id ()
        )
      )
    )
  );

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

DROP POLICY IF EXISTS ppcl_insert_owner ON cartlify.product_price_change_logs;

DROP POLICY IF EXISTS ppcl_update_deny ON cartlify.product_price_change_logs;

DROP POLICY IF EXISTS ppcl_delete_deny ON cartlify.product_price_change_logs;

-- SELECT (admin/root)
CREATE POLICY ppcl_select ON cartlify.product_price_change_logs FOR
SELECT
  USING (cartlify.is_admin ());

-- INSERT (deny for all): a line comes only from cartlify.log_product_price_change, which names
-- the admin of the context as the one who changed the price
CREATE POLICY ppcl_insert ON cartlify.product_price_change_logs FOR INSERT
WITH
  CHECK (false);

-- INSERT cartlify_owner for log_product_price_change: the line of a signed-in admin, in their name
CREATE POLICY ppcl_insert_owner ON cartlify.product_price_change_logs FOR INSERT TO cartlify_owner
WITH
  CHECK (
    cartlify.is_admin ()
    AND "actorId" = cartlify.current_actor_id ()
  );

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

-- INSERT (admin/root): a line names who did it. A signed-in admin writes in their own name and
-- with their own role; the system (the admin context without an id) writes what nobody signed in
-- did, such as the refund of a late payment, in the name of the one it concerns
CREATE POLICY aal_insert ON cartlify.admin_audit_log FOR INSERT
WITH
  CHECK (
    cartlify.is_system ()
    OR (
      cartlify.is_admin ()
      AND "actorId" = cartlify.current_actor_id ()
      AND "actorRole" = cartlify.current_actor_role ()
    )
  );

-- UPDATE (deny for all)
CREATE POLICY aal_update_deny ON cartlify.admin_audit_log
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- DELETE (deny for all)
CREATE POLICY aal_delete_deny ON cartlify.admin_audit_log FOR DELETE USING (false);

COMMIT;