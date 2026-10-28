BEGIN;

-- Row level security of every table: RLS is switched on and forced (the owner obeys it too), then
-- the policies are written per command. A row passes when any policy that fits the role of the
-- statement lets it. A policy without TO fits every role; TO cartlify_owner fits only the system
-- functions (security definer, owned by cartlify_owner). A command with no policy is refused to
-- everybody, so "DELETE: none" below means that nobody may delete.
--
-- A policy says WHO may touch which rows (an INSERT policy also checks the values of the new row)
-- and reads nothing but the context set by cartlify.set_current_context (role, user id, guest id).
-- "Admin/root" in the comments also covers the system, the admin context without a user id
-- (cartlify.is_system()).
-- WHICH COLUMNS an UPDATE may change is decided by the guard triggers trg_<table>_update_columns
-- (db/05, section UPDATE GUARDS), not by the policy: a check here would read the row as it was at
-- the start of the statement, and an update that waited for a lock would be judged against a stale
-- row. So an update policy that has no check of its own ends with CHECK (true). An UPDATE is
-- checked against the SELECT policies of the role after the change as well.
--
-- Grants on the tables are in db/01, the context helpers (is_admin, is_owner, ...) in db/05.
-- Every policy is dropped before it is created, so the script can run again.

-- A busy table makes the script wait for its lock, and every request of the app waits behind the
-- script. After 5 s the script stops; the workflow (db-run-sql.yml) runs it again.
SET LOCAL lock_timeout = '5s';

-- The tables and the policies below belong to cartlify_owner, whoever runs the script.
SET LOCAL ROLE cartlify_owner;

----------------------------------------
-- USERS
----------------------------------------
-- Read: the account itself, admin/root. Write: the account changes its own row, root changes any
-- row. The columns an owner may not touch are held by the guard trg_users_update_columns.
ALTER TABLE cartlify.users ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_select ON cartlify.users;

DROP POLICY IF EXISTS users_update ON cartlify.users;

DROP POLICY IF EXISTS users_update_owner ON cartlify.users;

DROP POLICY IF EXISTS users_update_owner_avatar ON cartlify.users;

DROP POLICY IF EXISTS users_insert ON cartlify.users;

DROP POLICY IF EXISTS users_select_owner ON cartlify.users;

DROP POLICY IF EXISTS users_delete ON cartlify.users;

-- SELECT: the account itself, admin/root
CREATE POLICY users_select ON cartlify.users FOR
SELECT
  USING (cartlify.is_owner_or_admin (id));

-- SELECT for the system functions: they read any account
CREATE POLICY users_select_owner ON cartlify.users FOR
SELECT
  TO cartlify_owner USING (true);

-- UPDATE (who): the owner of a live account, and root. A deleted account is closed to its owner:
-- its access token lives on for a few minutes and must not fill the emptied row again.
-- UPDATE (what), by the guard:
-- - the owner never changes the email, deletedAt or the role, and writes the row only while its
--   role is the role of the context: when root takes a role away, the access token that still
--   holds the old one can no longer write the row
-- - the owner does not change isVerified, except an OAuth provider taking over an unverified
--   LOCAL account
-- - root may change anything, role changes and the deletion included
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
  -- the columns an update may change: trg_users_update_columns (db/05)
  CHECK (true);

-- UPDATE for the system functions, only on an unverified account: auth_verify_email marks it
-- verified, nothing else changes but updatedAt
CREATE POLICY users_update_owner ON cartlify.users
FOR UPDATE
  TO cartlify_owner USING ("isVerified" = false)
WITH
  -- the columns an update may change: trg_users_update_columns (db/05)
  CHECK (true);

-- UPDATE for remove_user_avatar: the avatar of an account goes (avatarUrl and publicId empty),
-- nothing else of the row changes but updatedAt
CREATE POLICY users_update_owner_avatar ON cartlify.users
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  -- the columns an update may change: trg_users_update_columns (db/05)
  CHECK (true);

-- INSERT:
-- - a registration creates an unverified USER
-- - the admin context (an OAuth sign-in) may create a verified USER
-- - root creates a USER or an ADMIN
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

-- DELETE: root only
CREATE POLICY users_delete ON cartlify.users FOR DELETE USING (cartlify.is_root ());

----------------------------------------
-- USER TOKENS
----------------------------------------
-- The sessions (REFRESH_TOKEN) and the one-time links (VERIFY_EMAIL, RESET_PASSWORD). Read: the
-- owner, admin/root. Write: a user writes own sessions and, at the registration, the own
-- verification link; a password reset link comes only from the system. What an update may change:
-- trg_user_tokens_update_columns.
ALTER TABLE cartlify.user_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.user_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_tokens_select ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_select_owner ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_insert_owner ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_insert ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_update ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_update_owner ON cartlify.user_tokens;

DROP POLICY IF EXISTS user_tokens_delete ON cartlify.user_tokens;

-- SELECT: the owner, admin/root
CREATE POLICY user_tokens_select ON cartlify.user_tokens FOR
SELECT
  USING (cartlify.is_owner_or_admin ("userId"));

-- SELECT for the system functions: the verification links, open and used. A function that closes
-- a link must see the row after the change as well, as postgres checks it against SELECT
CREATE POLICY user_tokens_select_owner ON cartlify.user_tokens FOR
SELECT
  TO cartlify_owner USING (type = 'VERIFY_EMAIL');

-- INSERT: the system writes any token. A user writes only own tokens, and only sessions and
-- verification links: a reset link of the user's own would reset the password without knowing it.
CREATE POLICY user_tokens_insert ON cartlify.user_tokens FOR INSERT
WITH
  CHECK (
    cartlify.is_system ()
    OR (
      cartlify.is_owner ("userId")
      AND type IN ('REFRESH_TOKEN', 'VERIFY_EMAIL')
    )
  );

-- INSERT for auth_resend_verify: a new verification link, unused and not expired
CREATE POLICY user_tokens_insert_owner ON cartlify.user_tokens FOR INSERT TO cartlify_owner
WITH
  CHECK (
    type = 'VERIFY_EMAIL'
    AND "usedAt" IS NULL
    AND "expiresAt" > now()
  );

-- UPDATE (who): the owner, admin/root. The guard: a token keeps its user, its kind, its session
-- and its browser; a closed token stays closed (a logout, a rotation or a reset ends a session for
-- good); a session may get its hash and deadline after the row is made, every other link keeps
-- them and is only closed; a session is marked revoked only as it is closed.
CREATE POLICY user_tokens_update ON cartlify.user_tokens
FOR UPDATE
  USING (cartlify.is_owner_or_admin ("userId"))
WITH
  -- the columns an update may change: trg_user_tokens_update_columns (db/05)
  CHECK (true);

-- UPDATE for auth_verify_email and auth_resend_verify: an open verification link is closed
CREATE POLICY user_tokens_update_owner ON cartlify.user_tokens
FOR UPDATE
  TO cartlify_owner USING (
    type = 'VERIFY_EMAIL'
    AND "usedAt" IS NULL
    AND "expiresAt" > now()
  )
WITH
  -- the columns an update may change: trg_user_tokens_update_columns (db/05)
  CHECK (true);

-- DELETE: the owner, admin/root
CREATE POLICY user_tokens_delete ON cartlify.user_tokens FOR DELETE USING (cartlify.is_owner_or_admin ("userId"));

----------------------------------------
-- LOGIN LOGS
----------------------------------------
-- The history of sign-ins. Read: the account itself, admin/root. Write: an account adds the line
-- of its own sign-in. No role changes or removes a line (the *_deny policies), except the two
-- narrow exceptions for system functions below.
ALTER TABLE cartlify.login_logs ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.login_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS login_logs_select ON cartlify.login_logs;

DROP POLICY IF EXISTS login_logs_insert ON cartlify.login_logs;

DROP POLICY IF EXISTS login_logs_update_deny ON cartlify.login_logs;

DROP POLICY IF EXISTS login_logs_update_owner ON cartlify.login_logs;

DROP POLICY IF EXISTS login_logs_update_owner_network ON cartlify.login_logs;

DROP POLICY IF EXISTS login_logs_delete_deny ON cartlify.login_logs;

-- SELECT: the account itself, admin/root
CREATE POLICY login_logs_select ON cartlify.login_logs FOR
SELECT
  USING (cartlify.is_owner_or_admin ("userId"));

-- INSERT: the own line only
CREATE POLICY login_logs_insert ON cartlify.login_logs FOR INSERT
WITH
  CHECK (cartlify.is_owner ("userId"));

-- UPDATE: denied to every role. Policies are joined with OR, so the two narrow policies below
-- still let their functions through.
CREATE POLICY login_logs_update_deny ON cartlify.login_logs
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- UPDATE exception 1, for anonymize_login_logs: a line of a deleted account takes the email the
-- account has now, nothing else of the line changes
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
  -- the columns an update may change: trg_login_logs_update_columns (db/05)
  CHECK (true);

-- UPDATE exception 2, for cleanup_login_log_addresses: the address and the browser of an old
-- login are emptied, nothing else changes (the guard trg_login_logs_update_columns)
CREATE POLICY login_logs_update_owner_network ON cartlify.login_logs
FOR UPDATE
  TO cartlify_owner USING (
    "ipAddress" IS NOT NULL
    OR "userAgent" IS NOT NULL
  )
WITH
  CHECK (true);

-- DELETE: denied to every role
CREATE POLICY login_logs_delete_deny ON cartlify.login_logs FOR DELETE USING (false);

----------------------------------------
-- CATEGORIES
----------------------------------------
-- Read by everybody, written by admin/root. A category never goes into its own branch: the
-- trigger trg_categories_before_parent_change (db/05) refuses a cycle.
ALTER TABLE cartlify.categories ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.categories FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS categories_select ON cartlify.categories;

DROP POLICY IF EXISTS categories_insert ON cartlify.categories;

DROP POLICY IF EXISTS categories_update ON cartlify.categories;

DROP POLICY IF EXISTS categories_delete ON cartlify.categories;

CREATE POLICY categories_select ON cartlify.categories FOR
SELECT
  USING (true);

CREATE POLICY categories_insert ON cartlify.categories FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY categories_update ON cartlify.categories
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY categories_delete ON cartlify.categories FOR DELETE USING (cartlify.is_admin ());

----------------------------------------
-- PRODUCTS
----------------------------------------
-- Read by everybody. Written by admin/root, except the numbers the database keeps itself: stock,
-- reservedStock, avgRating, reviewsCount and popularity move only through system functions and
-- triggers, and a view of the product adds one to views. Which columns each role may change:
-- trg_products_update_columns.
ALTER TABLE cartlify.products ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.products FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_select ON cartlify.products;

DROP POLICY IF EXISTS products_insert ON cartlify.products;

DROP POLICY IF EXISTS products_update_admin ON cartlify.products;

DROP POLICY IF EXISTS products_update_computed ON cartlify.products;

DROP POLICY IF EXISTS products_update_owner ON cartlify.products;

DROP POLICY IF EXISTS products_delete ON cartlify.products;

CREATE POLICY products_select ON cartlify.products FOR
SELECT
  USING (true);

-- INSERT: admin/root. A new product starts with no stock, reserve, rating, reviews, popularity or
-- views: the database counts them from what happens to it (the stock comes with the batches of a
-- delivery, receive_product_batch). It starts with no sale either: a sale is set on a product that
-- is in the catalog (the check of the end of a sale in db/05 runs on UPDATE only).
CREATE POLICY products_insert ON cartlify.products FOR INSERT
WITH
  CHECK (
    cartlify.is_admin ()
    AND "stock" = 0
    AND "reservedStock" = 0
    AND "avgRating" = 0
    AND "reviewsCount" = 0
    AND popularity = 0
    AND views = 0
    AND "salePrice" IS NULL
    AND "saleEndsAt" IS NULL
  );

-- UPDATE (who): admin/root. The guard leaves out what the database counts: stock (what the
-- batches have left: a delivery, a sale, a write-off, a cancel), reservedStock (what the waiting
-- orders hold), avgRating and reviewsCount (the reviews), popularity (what people do; an admin
-- sets popularityOverride instead). views may grow by one, as for anybody.
CREATE POLICY products_update_admin ON cartlify.products
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  -- the columns an update may change: trg_products_update_columns (db/05)
  CHECK (true);

-- UPDATE by any role: a view of the product. The guard lets a guest or a user change only views
-- and updatedAt, and trg_products_before_views_change allows views to grow by one only.
CREATE POLICY products_update_computed ON cartlify.products
FOR UPDATE
  USING (true)
WITH
  -- the columns an update may change: trg_products_update_columns (db/05)
  CHECK (true);

-- UPDATE for the system functions: the numbers the database counts, one group at a time (rating
-- and reviews, stock and reserve, popularity)
CREATE POLICY products_update_owner ON cartlify.products
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  -- the columns an update may change: trg_products_update_columns (db/05)
  CHECK (true);

CREATE POLICY products_delete ON cartlify.products FOR DELETE USING (cartlify.is_admin ());

----------------------------------------
-- PRODUCT BATCHES
----------------------------------------
-- The batches a product came in with, and what each cost. For the shop, never for a buyer: only
-- admin/root read them. Only the functions of the database write them: receive_product_batch
-- brings a batch in; a sale, write_off_product_stock and a cancel of an order change what is left.
ALTER TABLE cartlify.product_batches ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.product_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_batches_select ON cartlify.product_batches;

DROP POLICY IF EXISTS product_batches_select_owner ON cartlify.product_batches;

DROP POLICY IF EXISTS product_batches_insert_owner ON cartlify.product_batches;

DROP POLICY IF EXISTS product_batches_update_owner ON cartlify.product_batches;

DROP POLICY IF EXISTS product_batches_delete_deny ON cartlify.product_batches;

CREATE POLICY product_batches_select ON cartlify.product_batches FOR
SELECT
  USING (cartlify.is_admin ());

-- SELECT for the system functions and for the check that the stock equals the batches
CREATE POLICY product_batches_select_owner ON cartlify.product_batches FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT for the system functions: a batch comes in whole, nothing taken out of it yet
CREATE POLICY product_batches_insert_owner ON cartlify.product_batches FOR INSERT TO cartlify_owner
WITH
  CHECK (remaining = quantity);

-- UPDATE for the system functions: a sale, a write-off or a cancel changes only what the batch
-- has left
CREATE POLICY product_batches_update_owner ON cartlify.product_batches
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  -- the columns an update may change: trg_product_batches_update_columns (db/05)
  CHECK (true);

-- DELETE: denied to every role. A batch goes only with its product, when that is removed for
-- good (the foreign key cascade)
CREATE POLICY product_batches_delete_deny ON cartlify.product_batches FOR DELETE USING (false);

----------------------------------------
-- ORDER BATCH ALLOCATIONS
----------------------------------------
-- The units a paid order took from each batch: the cost of the goods it sold. History: pay_order
-- writes the lines (through consume_product_stock), nobody changes or removes them, a cancel of
-- the order leaves them too. Read: admin/root.
ALTER TABLE cartlify.order_batch_allocations ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.order_batch_allocations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_batch_allocations_select ON cartlify.order_batch_allocations;

DROP POLICY IF EXISTS order_batch_allocations_select_owner ON cartlify.order_batch_allocations;

DROP POLICY IF EXISTS order_batch_allocations_insert_owner ON cartlify.order_batch_allocations;

DROP POLICY IF EXISTS order_batch_allocations_update_deny ON cartlify.order_batch_allocations;

DROP POLICY IF EXISTS order_batch_allocations_delete_deny ON cartlify.order_batch_allocations;

CREATE POLICY order_batch_allocations_select ON cartlify.order_batch_allocations FOR
SELECT
  USING (cartlify.is_admin ());

-- SELECT for the system functions
CREATE POLICY order_batch_allocations_select_owner ON cartlify.order_batch_allocations FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT for the system functions: the payment of an order
CREATE POLICY order_batch_allocations_insert_owner ON cartlify.order_batch_allocations FOR INSERT TO cartlify_owner
WITH
  CHECK (quantity > 0);

-- UPDATE: denied to every role
CREATE POLICY order_batch_allocations_update_deny ON cartlify.order_batch_allocations
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- DELETE: denied to every role
CREATE POLICY order_batch_allocations_delete_deny ON cartlify.order_batch_allocations FOR DELETE USING (false);

----------------------------------------
-- PRODUCT IMAGES
----------------------------------------
-- Read by everybody, written by admin/root.
ALTER TABLE cartlify.product_images ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.product_images FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_images_select ON cartlify.product_images;

DROP POLICY IF EXISTS product_images_insert ON cartlify.product_images;

DROP POLICY IF EXISTS product_images_update ON cartlify.product_images;

DROP POLICY IF EXISTS product_images_delete ON cartlify.product_images;

CREATE POLICY product_images_select ON cartlify.product_images FOR
SELECT
  USING (true);

CREATE POLICY product_images_insert ON cartlify.product_images FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY product_images_update ON cartlify.product_images
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY product_images_delete ON cartlify.product_images FOR DELETE USING (cartlify.is_admin ());

----------------------------------------
-- REVIEWS
----------------------------------------
-- Read by everybody. A review has a rating, a comment or both. A USER writes a review as
-- themselves and may fill in the part that is still missing later; nothing else of it changes
-- (trg_reviews_update_columns and trg_reviews_lock_rating_and_keys, db/05). The vote counters are
-- written by the database. A review is deleted by its author or by admin/root.
ALTER TABLE cartlify.reviews ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.reviews FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reviews_select ON cartlify.reviews;

DROP POLICY IF EXISTS reviews_insert ON cartlify.reviews;

DROP POLICY IF EXISTS reviews_update_owner_comment_null ON cartlify.reviews;

DROP POLICY IF EXISTS reviews_update_owner_votes ON cartlify.reviews;

DROP POLICY IF EXISTS reviews_delete ON cartlify.reviews;

CREATE POLICY reviews_select ON cartlify.reviews FOR
SELECT
  USING (true);

-- INSERT: a USER, as themselves, with a rating or a comment that is not empty
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

-- UPDATE (who): the author, while the rating or the comment is still missing
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
  -- the columns an update may change: trg_reviews_update_columns (db/05)
  CHECK (true);

-- UPDATE for the system functions: the vote counters upVotes and downVotes, recounted from
-- review_votes
CREATE POLICY reviews_update_owner_votes ON cartlify.reviews
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  -- the columns an update may change: trg_reviews_update_columns (db/05)
  CHECK (true);

-- DELETE: the author, admin/root
CREATE POLICY reviews_delete ON cartlify.reviews FOR DELETE USING (cartlify.is_owner_or_admin ("userId"));

----------------------------------------
-- REVIEW VOTES
----------------------------------------
-- A vote UP or DOWN under the review of another user: only a USER votes, never on their own
-- review. Read: the voter and admin/root (who voted how belongs to the voter); everybody else
-- reads the counts kept on the review (upVotes, downVotes), which a trigger recounts from every
-- vote.
ALTER TABLE cartlify.review_votes ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.review_votes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS review_votes_select ON cartlify.review_votes;

DROP POLICY IF EXISTS review_votes_select_owner ON cartlify.review_votes;

DROP POLICY IF EXISTS review_votes_insert ON cartlify.review_votes;

DROP POLICY IF EXISTS review_votes_update ON cartlify.review_votes;

DROP POLICY IF EXISTS review_votes_delete ON cartlify.review_votes;

CREATE POLICY review_votes_select ON cartlify.review_votes FOR
SELECT
  USING (cartlify.is_owner_or_admin ("userId"));

-- SELECT for the system functions: the counts of a review take every vote
CREATE POLICY review_votes_select_owner ON cartlify.review_votes FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT: a USER, as themselves, on the review of another user
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

-- UPDATE: the voter switches UP <-> DOWN, never onto an own review; the columns an update may
-- change: trg_review_votes_update_columns (db/05)
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

-- DELETE: the voter
CREATE POLICY review_votes_delete ON cartlify.review_votes FOR DELETE USING (cartlify.is_owner ("userId"));

----------------------------------------
-- FAVORITES
----------------------------------------
-- A product that a user, or a guest by guestId, keeps for later. Read: the owner, admin/root.
-- Written and removed by the owner. When a guest signs in, migrate_guest_data_to_user gives the
-- guest's rows to the user. A product removed from the catalog cannot be added
-- (refuse_removed_product).
ALTER TABLE cartlify.favorites ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.favorites FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS favorites_select ON cartlify.favorites;

DROP POLICY IF EXISTS favorites_select_owner ON cartlify.favorites;

DROP POLICY IF EXISTS favorites_insert ON cartlify.favorites;

DROP POLICY IF EXISTS favorites_update_owner ON cartlify.favorites;

DROP POLICY IF EXISTS favorites_delete ON cartlify.favorites;

DROP POLICY IF EXISTS favorites_delete_owner ON cartlify.favorites;

-- SELECT: the owner (a user, or a guest by guestId), admin/root
CREATE POLICY favorites_select ON cartlify.favorites FOR
SELECT
  USING (
    cartlify.is_owner_or_admin ("userId")
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND "guestId" = cartlify.current_guest_id ()
    )
  );

-- SELECT for the system functions (the migration of a guest, the clean-up of guests)
CREATE POLICY favorites_select_owner ON cartlify.favorites FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT: a user (or admin/root) for themselves, a guest for their guestId, never both
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

-- UPDATE for migrate_guest_data_to_user: a guest row may only become a user row. No other
-- update exists: a favorite is never edited.
CREATE POLICY favorites_update_owner ON cartlify.favorites
FOR UPDATE
  TO cartlify_owner USING ("userId" IS NULL)
WITH
  CHECK (
    "userId" IS NOT NULL
    AND "guestId" IS NULL
  );

-- DELETE: the owner (a user, or a guest by guestId)
CREATE POLICY favorites_delete ON cartlify.favorites FOR DELETE USING (
  cartlify.is_owner ("userId")
  OR (
    cartlify.current_actor_role () = 'GUEST'
    AND "guestId" = cartlify.current_guest_id ()
  )
);

-- DELETE for the system functions, guest rows only: migrate_guest_data_to_user drops the guest
-- favorites that the user already has, cleanup_guest_data drops the favorites of guests who left
CREATE POLICY favorites_delete_owner ON cartlify.favorites FOR DELETE TO cartlify_owner USING ("userId" IS NULL);

----------------------------------------
-- ORDERS
----------------------------------------
-- An order is a cart while it is not confirmed (pending, unconfirmed), then waiting for payment,
-- paid, shipped, delivered, or cancelled. Read: the buyer, admin/root. The buyer changes no column
-- of an order with a plain UPDATE: the confirmation, the total, the payment, the dates and the
-- cancel are steps of the database (functions and triggers), and the shipping steps belong to
-- admin/root. What each role may change: trg_orders_update_columns. Where the order goes is
-- written in order_deliveries.
ALTER TABLE cartlify.orders ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.orders FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orders_select ON cartlify.orders;

DROP POLICY IF EXISTS orders_select_owner ON cartlify.orders;

DROP POLICY IF EXISTS orders_insert ON cartlify.orders;

DROP POLICY IF EXISTS orders_update ON cartlify.orders;

DROP POLICY IF EXISTS orders_update_admin_shipping_status ON cartlify.orders;

DROP POLICY IF EXISTS orders_update_owner ON cartlify.orders;

DROP POLICY IF EXISTS orders_update_owner_cancel ON cartlify.orders;

DROP POLICY IF EXISTS orders_delete ON cartlify.orders;

CREATE POLICY orders_select ON cartlify.orders FOR
SELECT
  USING (cartlify.is_owner_or_admin ("userId"));

-- SELECT for the system functions
CREATE POLICY orders_select_owner ON cartlify.orders FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT: a USER, a new cart of their own: not confirmed, no reservation, payment or dates
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
    AND "paidAt" IS NULL
    AND "cancelledAt" IS NULL
  );

-- UPDATE (who): the buyer, while the order is not confirmed. The guard refuses every column the
-- buyer would change with a plain update, so the policy is there for the lock only: the trigger of
-- the items takes the row of the order FOR UPDATE, and a row that no update policy reaches is
-- hidden from that.
CREATE POLICY orders_update ON cartlify.orders
FOR UPDATE
  USING (
    cartlify.is_owner ("userId")
    AND confirmed = false
  )
WITH
  -- the columns an update may change: trg_orders_update_columns (db/05)
  CHECK (true);

-- UPDATE for the system functions, on an order that is not confirmed or is waiting for payment:
-- confirm, pay, unconfirm, expire the reservation, cancel the payment, recount the total (the
-- guard lists what each step may change)
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
  -- the columns an update may change: trg_orders_update_columns (db/05)
  CHECK (true);

-- UPDATE (who): admin/root, on a paid, shipped or delivered order. The guard lets only the status
-- move, one step on or one step back (paid, shipped, delivered). A cancel is not a status change
-- here: it goes through cancel_paid_order, which returns the stock.
CREATE POLICY orders_update_admin_shipping_status ON cartlify.orders
FOR UPDATE
  USING (
    cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
    AND status IN ('paid', 'shipped', 'delivered')
  )
WITH
  -- the columns an update may change: trg_orders_update_columns (db/05)
  CHECK (true);

-- UPDATE for cancel_paid_order: a paid or shipped order of the admin context becomes cancelled,
-- with the time of the cancel, and nothing else changes. The rows it reaches are the ones the
-- admin policy above reaches already, so it opens no other order to the system functions.
CREATE POLICY orders_update_owner_cancel ON cartlify.orders
FOR UPDATE
  TO cartlify_owner USING (
    cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
    AND status IN ('paid', 'shipped')
  )
WITH
  -- the columns an update may change: trg_orders_update_columns (db/05)
  CHECK (true);

-- DELETE: a USER, an own order that is not confirmed
CREATE POLICY orders_delete ON cartlify.orders FOR DELETE USING (
  cartlify.current_actor_role () = 'USER'
  AND cartlify.is_owner ("userId")
  AND confirmed = false
);

----------------------------------------
-- ORDER DELIVERIES
----------------------------------------
-- Where and to whom an order goes, one row per order. Read: through the parent order. The buyer
-- writes it while the order is not confirmed; confirm_order sets the price and nobody else does;
-- admin/root correct the person and the address of a paid order until it is sent. What each role
-- may change: trg_order_deliveries_update_columns.
ALTER TABLE cartlify.order_deliveries ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.order_deliveries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_deliveries_select ON cartlify.order_deliveries;

DROP POLICY IF EXISTS order_deliveries_select_owner ON cartlify.order_deliveries;

DROP POLICY IF EXISTS order_deliveries_insert ON cartlify.order_deliveries;

DROP POLICY IF EXISTS order_deliveries_update ON cartlify.order_deliveries;

DROP POLICY IF EXISTS order_deliveries_update_admin ON cartlify.order_deliveries;

DROP POLICY IF EXISTS order_deliveries_update_owner ON cartlify.order_deliveries;

-- No delete policy is created for this table; this line only removes one that a draft of this
-- script may have left on a database.
DROP POLICY IF EXISTS order_deliveries_delete ON cartlify.order_deliveries;

-- SELECT: through the parent order (the buyer, admin/root)
CREATE POLICY order_deliveries_select ON cartlify.order_deliveries FOR
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

-- SELECT for the system functions
CREATE POLICY order_deliveries_select_owner ON cartlify.order_deliveries FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT: a USER, for an own order that is not confirmed, with no price yet
CREATE POLICY order_deliveries_insert ON cartlify.order_deliveries FOR INSERT
WITH
  CHECK (
    "price" = 0
    AND cartlify.current_actor_role () = 'USER'
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

-- UPDATE: a USER, while the order is not confirmed
CREATE POLICY order_deliveries_update ON cartlify.order_deliveries
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
  -- the columns an update may change: trg_order_deliveries_update_columns (db/05)
  CHECK (true);

-- UPDATE: admin/root, while the order is paid and not sent yet. The guard leaves out the method
-- and the price.
CREATE POLICY order_deliveries_update_admin ON cartlify.order_deliveries
FOR UPDATE
  USING (
    cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
    AND EXISTS (
      SELECT
        1
      FROM
        cartlify.orders o
      WHERE
        o.id = "orderId"
        AND o.status = 'paid'
    )
  )
WITH
  -- the columns an update may change: trg_order_deliveries_update_columns (db/05)
  CHECK (true);

-- UPDATE for confirm_order: it fixes the price (the guard lets only the price change)
CREATE POLICY order_deliveries_update_owner ON cartlify.order_deliveries
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  -- the columns an update may change: trg_order_deliveries_update_columns (db/05)
  CHECK (true);

-- DELETE: none; a row goes with its order (the foreign key cascade)

----------------------------------------
-- ORDER SHIPMENTS
----------------------------------------
-- The times an order was sent with a carrier outside the app, one row each; a send that was rolled
-- back stays, marked. Written and corrected by admin/root. The buyer of the order can read the row
-- (the server gives the buyer the carrier and the number, never the cost). What an update may
-- change: trg_order_shipments_update_columns.
ALTER TABLE cartlify.order_shipments ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.order_shipments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_shipments_select ON cartlify.order_shipments;

DROP POLICY IF EXISTS order_shipments_select_owner ON cartlify.order_shipments;

DROP POLICY IF EXISTS order_shipments_insert ON cartlify.order_shipments;

DROP POLICY IF EXISTS order_shipments_update ON cartlify.order_shipments;

-- No delete policy is created for this table; this line only removes one that a draft of this
-- script may have left on a database.
DROP POLICY IF EXISTS order_shipments_delete ON cartlify.order_shipments;

-- SELECT: through the parent order (the buyer, admin/root)
CREATE POLICY order_shipments_select ON cartlify.order_shipments FOR
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

-- SELECT for the system functions
CREATE POLICY order_shipments_select_owner ON cartlify.order_shipments FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT: admin/root, for a shipped order; a new send is not rolled back and its cost counts
-- (expense)
CREATE POLICY order_shipments_insert ON cartlify.order_shipments FOR INSERT
WITH
  CHECK (
    cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
    AND "rolledBackAt" IS NULL
    AND "expense" = true
    AND EXISTS (
      SELECT
        1
      FROM
        cartlify.orders o
      WHERE
        o.id = "orderId"
        AND o.status = 'shipped'
    )
  );

-- UPDATE: admin/root. A send that was rolled back is history: the guard lets only its cost and
-- the mark of the cost change.
CREATE POLICY order_shipments_update ON cartlify.order_shipments
FOR UPDATE
  USING (cartlify.current_actor_role () IN ('ADMIN', 'ROOT'))
WITH
  -- the columns an update may change: trg_order_shipments_update_columns (db/05)
  CHECK (true);

-- DELETE: none, the history stays

----------------------------------------
-- ORDER ITEMS
----------------------------------------
-- The lines of an order. Read: through the parent order (the buyer, admin/root). A USER changes
-- the lines of an own order only while it is not confirmed. The unit price, the name and the total
-- of a line come from the product (order_items_before_ins_upd), never from the caller.
ALTER TABLE cartlify.order_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.order_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_items_select ON cartlify.order_items;

DROP POLICY IF EXISTS order_items_select_owner ON cartlify.order_items;

DROP POLICY IF EXISTS order_items_insert ON cartlify.order_items;

DROP POLICY IF EXISTS order_items_update ON cartlify.order_items;

DROP POLICY IF EXISTS order_items_update_owner ON cartlify.order_items;

DROP POLICY IF EXISTS order_items_delete ON cartlify.order_items;

-- SELECT: through the parent order (the buyer, admin/root)
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

-- SELECT for the system functions
CREATE POLICY order_items_select_owner ON cartlify.order_items FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT: a USER, into an own order that is not confirmed
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

-- UPDATE: the same as INSERT
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

-- UPDATE for the system functions, to lock rows only: the steps that lock all items of an order
-- (confirm, cancel the payment, unconfirm, pay, expire) reach the rows through it with
-- FOR UPDATE. CHECK (false): no change goes through this policy.
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

-- DELETE: a USER, from an own order that is not confirmed
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
-- A conversation of a user or a guest with the bot or with an admin. Read: the user (or the guest
-- by guestId) and admin/root. A chat keeps its user or guest (a guest chat moves to the user at
-- sign-in), and a closed chat stays closed (trg_chat_threads_update_columns, db/05). Only the two
-- clean-up functions delete a chat, besides the cascade of a deleted user row. When a guest signs in, migrate_guest_data_to_user makes the guest's chats the user's.
ALTER TABLE cartlify.chat_threads ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.chat_threads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_threads_select ON cartlify.chat_threads;

DROP POLICY IF EXISTS chat_threads_insert ON cartlify.chat_threads;

DROP POLICY IF EXISTS chat_threads_update ON cartlify.chat_threads;

DROP POLICY IF EXISTS chat_threads_delete ON cartlify.chat_threads;

DROP POLICY IF EXISTS chat_threads_delete_owner ON cartlify.chat_threads;

DROP POLICY IF EXISTS chat_threads_select_owner ON cartlify.chat_threads;

DROP POLICY IF EXISTS chat_threads_update_owner ON cartlify.chat_threads;

CREATE POLICY chat_threads_select ON cartlify.chat_threads FOR
SELECT
  USING (
    cartlify.is_owner_or_admin ("userId")
    OR (
      cartlify.current_actor_role () = 'GUEST'
      AND "guestId" = cartlify.current_guest_id ()
    )
  );

-- SELECT for migrate_guest_data_to_user: the guest threads it moves
CREATE POLICY chat_threads_select_owner ON cartlify.chat_threads FOR
SELECT
  TO cartlify_owner USING ("userId" IS NULL);

-- INSERT: the owner (a user or admin/root for themselves, a guest for their guestId). A chat that
-- asks for an admin at once asks now: the admin queue goes by adminRequestedAt, and an earlier
-- time would put the chat before the ones that waited longer (a minute is left for the clock of
-- the server).
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

-- UPDATE (who): the owner, admin/root, or the guest by guestId. The guard: a chat keeps its user
-- or guest (a guest chat moves to a user through chat_threads_update_owner), a closed chat stays
-- closed, and a new adminRequestedAt is made now, never earlier.
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
  -- the columns an update may change: trg_chat_threads_update_columns (db/05)
  CHECK (true);

-- UPDATE for migrate_guest_data_to_user: a guest thread may only become a user thread
CREATE POLICY chat_threads_update_owner ON cartlify.chat_threads
FOR UPDATE
  TO cartlify_owner USING ("userId" IS NULL)
WITH
  -- the columns an update may change: trg_chat_threads_update_columns (db/05)
  CHECK (true);

-- DELETE: denied to every role; the policy for the clean-up functions follows
CREATE POLICY chat_threads_delete ON cartlify.chat_threads FOR DELETE USING (false);

-- DELETE for cleanup_guest_data and cleanup_deleted_accounts_chats: the chat of a guest or of a
-- deleted account; its messages go with it
CREATE POLICY chat_threads_delete_owner ON cartlify.chat_threads FOR DELETE TO cartlify_owner USING (
  "userId" IS NULL
  OR EXISTS (
    SELECT
      1
    FROM
      cartlify.users AS u
    WHERE
      u.id = chat_threads."userId"
      AND u."deletedAt" IS NOT NULL
  )
);

----------------------------------------
-- CHAT MESSAGES
----------------------------------------
-- The messages of a chat. Read: through the parent thread (its owner, admin/root). Written only in
-- an open thread, by a sender that matches the actor. A message changes only by its read flag and
-- is never deleted by hand (it goes with its chat).
ALTER TABLE cartlify.chat_messages ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.chat_messages FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_messages_select ON cartlify.chat_messages;

DROP POLICY IF EXISTS chat_messages_insert ON cartlify.chat_messages;

DROP POLICY IF EXISTS chat_messages_update ON cartlify.chat_messages;

DROP POLICY IF EXISTS chat_messages_delete ON cartlify.chat_messages;

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

-- INSERT: through the parent thread, which must be open; the sender must match the actor:
-- - a user writes as 'user' with the own id, in the own thread
-- - a guest writes as 'guest', in the own bot thread
-- - admin/root writes as 'admin' with the own id, in an admin thread only
-- - the messages of the bot are stored by the server in the context of the customer, in a bot
--   thread only
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

-- UPDATE: the reader marks messages as read. Admin/root: the messages of users and guests in an
-- admin thread. A user: the messages of the bot and of admins in the own threads. A guest: the
-- messages of the bot in the own bot thread. CHECK demands isRead = true, and
-- trg_chat_messages_before_update refuses a change of any other column.
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

-- DELETE: denied to every role
CREATE POLICY chat_messages_delete ON cartlify.chat_messages FOR DELETE USING (false);

----------------------------------------
-- PRODUCT PRICE CHANGE LOGS
----------------------------------------
-- The history of the price changes of products. Read: admin/root. Written only by
-- log_product_price_change; no role changes or removes a line.
ALTER TABLE cartlify.product_price_change_logs ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.product_price_change_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ppcl_select ON cartlify.product_price_change_logs;

DROP POLICY IF EXISTS ppcl_insert ON cartlify.product_price_change_logs;

DROP POLICY IF EXISTS ppcl_insert_owner ON cartlify.product_price_change_logs;

DROP POLICY IF EXISTS ppcl_update_deny ON cartlify.product_price_change_logs;

DROP POLICY IF EXISTS ppcl_delete_deny ON cartlify.product_price_change_logs;

CREATE POLICY ppcl_select ON cartlify.product_price_change_logs FOR
SELECT
  USING (cartlify.is_admin ());

-- INSERT: denied to the app, which writes no line straight into the table; the policy below
-- lets log_product_price_change through
CREATE POLICY ppcl_insert ON cartlify.product_price_change_logs FOR INSERT
WITH
  CHECK (false);

-- INSERT for log_product_price_change: the line of a signed-in admin, in their name. The system
-- has no user id, so it cannot write a line.
CREATE POLICY ppcl_insert_owner ON cartlify.product_price_change_logs FOR INSERT TO cartlify_owner
WITH
  CHECK (
    cartlify.is_admin ()
    AND "actorId" = cartlify.current_actor_id ()
  );

-- UPDATE: denied to every role
CREATE POLICY ppcl_update_deny ON cartlify.product_price_change_logs
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- DELETE: denied to every role
CREATE POLICY ppcl_delete_deny ON cartlify.product_price_change_logs FOR DELETE USING (false);

----------------------------------------
-- ADMIN ALERT SETTINGS
----------------------------------------
-- The settings of the kinds of alerts of an admin or root: on or off, and the threshold. Each one
-- sees, adds, changes and removes only their own rows. An update may change only the on/off flag
-- and the threshold (trg_admin_alert_settings_update_columns, db/05).
ALTER TABLE cartlify.admin_alert_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.admin_alert_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_alert_settings_select ON cartlify.admin_alert_settings;

DROP POLICY IF EXISTS admin_alert_settings_insert ON cartlify.admin_alert_settings;

DROP POLICY IF EXISTS admin_alert_settings_update ON cartlify.admin_alert_settings;

DROP POLICY IF EXISTS admin_alert_settings_delete ON cartlify.admin_alert_settings;

CREATE POLICY admin_alert_settings_select ON cartlify.admin_alert_settings FOR
SELECT
  USING (
    cartlify.is_admin ()
    AND "userId" = cartlify.current_actor_id ()
  );

CREATE POLICY admin_alert_settings_insert ON cartlify.admin_alert_settings FOR INSERT
WITH
  CHECK (
    cartlify.is_admin ()
    AND "userId" = cartlify.current_actor_id ()
  );

CREATE POLICY admin_alert_settings_update ON cartlify.admin_alert_settings
FOR UPDATE
  USING (
    cartlify.is_admin ()
    AND "userId" = cartlify.current_actor_id ()
  )
WITH
  -- the columns an update may change: trg_admin_alert_settings_update_columns (db/05)
  CHECK (true);

CREATE POLICY admin_alert_settings_delete ON cartlify.admin_alert_settings FOR DELETE USING (
  cartlify.is_admin ()
  AND "userId" = cartlify.current_actor_id ()
);

----------------------------------------
-- LEGAL DOCUMENTS
----------------------------------------
-- The versions of the terms and of the contract. Everybody reads them, a guest too, before
-- accepting them. Only root publishes a version, in their own name. A version is never changed or
-- removed. The version number and the sha256 come from trg_legal_documents_before_insert (db/05).
ALTER TABLE cartlify.legal_documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.legal_documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS legal_documents_select ON cartlify.legal_documents;

DROP POLICY IF EXISTS legal_documents_insert ON cartlify.legal_documents;

DROP POLICY IF EXISTS legal_documents_update_deny ON cartlify.legal_documents;

DROP POLICY IF EXISTS legal_documents_delete_deny ON cartlify.legal_documents;

CREATE POLICY legal_documents_select ON cartlify.legal_documents FOR
SELECT
  USING (true);

CREATE POLICY legal_documents_insert ON cartlify.legal_documents FOR INSERT
WITH
  CHECK (
    cartlify.is_root ()
    AND "publishedById" = cartlify.current_actor_id ()
  );

-- UPDATE: denied to every role
CREATE POLICY legal_documents_update_deny ON cartlify.legal_documents
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- DELETE: denied to every role
CREATE POLICY legal_documents_delete_deny ON cartlify.legal_documents FOR DELETE USING (false);

----------------------------------------
-- LEGAL ACCEPTANCES
----------------------------------------
-- The log of consents: which version of a document a customer accepted, alone or with an order.
-- A USER adds a line for themselves, with no order or with an order of their own, and reads their
-- own lines; admin/root read every line. A line is never changed or removed, besides the lines of an
-- unconfirmed order, which go with it (cascade). The version in force
-- and the address of the request come from trg_legal_acceptances_before_insert (db/05).
ALTER TABLE cartlify.legal_acceptances ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.legal_acceptances FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS legal_acceptances_select ON cartlify.legal_acceptances;

DROP POLICY IF EXISTS legal_acceptances_insert ON cartlify.legal_acceptances;

DROP POLICY IF EXISTS legal_acceptances_update_deny ON cartlify.legal_acceptances;

DROP POLICY IF EXISTS legal_acceptances_delete_deny ON cartlify.legal_acceptances;

CREATE POLICY legal_acceptances_select ON cartlify.legal_acceptances FOR
SELECT
  USING (cartlify.is_owner_or_admin ("userId"));

CREATE POLICY legal_acceptances_insert ON cartlify.legal_acceptances FOR INSERT
WITH
  CHECK (
    cartlify.is_owner ("userId")
    AND cartlify.current_actor_role () = 'USER'
    AND (
      "orderId" IS NULL
      OR EXISTS (
        SELECT
          1
        FROM
          cartlify.orders AS o
        WHERE
          o.id = "orderId"
          AND o."userId" = legal_acceptances."userId"
      )
    )
  );

-- UPDATE: denied to every role
CREATE POLICY legal_acceptances_update_deny ON cartlify.legal_acceptances
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- DELETE: denied to every role
CREATE POLICY legal_acceptances_delete_deny ON cartlify.legal_acceptances FOR DELETE USING (false);

----------------------------------------
-- ADMIN AUDIT LOG
----------------------------------------
-- The log of what admins and root do (and of what the system does for a customer). Read:
-- admin/root. A line is never changed or removed.
ALTER TABLE cartlify.admin_audit_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.admin_audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aal_select ON cartlify.admin_audit_log;

DROP POLICY IF EXISTS aal_insert ON cartlify.admin_audit_log;

DROP POLICY IF EXISTS aal_update_deny ON cartlify.admin_audit_log;

DROP POLICY IF EXISTS aal_delete_deny ON cartlify.admin_audit_log;

CREATE POLICY aal_select ON cartlify.admin_audit_log FOR
SELECT
  USING (cartlify.is_admin ());

-- INSERT: a line names who did it. A signed-in admin writes in their own name and with their own
-- role. The system (the admin context without a user id) writes what nobody signed in did, such
-- as the refund of a late payment, in the name of the one it concerns.
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

-- UPDATE: denied to every role
CREATE POLICY aal_update_deny ON cartlify.admin_audit_log
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- DELETE: denied to every role
CREATE POLICY aal_delete_deny ON cartlify.admin_audit_log FOR DELETE USING (false);

COMMIT;