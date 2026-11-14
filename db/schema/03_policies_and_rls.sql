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
-- PARTIES
----------------------------------------
-- The manufacturers and the persons responsible in the EU a product names. The product card shows
-- them to everybody (GPSR), so everybody reads; admin/root write. A party a product names cannot be
-- deleted: the foreign keys of products refuse it.
ALTER TABLE cartlify.parties ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.parties FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS parties_select ON cartlify.parties;

DROP POLICY IF EXISTS parties_insert ON cartlify.parties;

DROP POLICY IF EXISTS parties_update ON cartlify.parties;

DROP POLICY IF EXISTS parties_delete ON cartlify.parties;

CREATE POLICY parties_select ON cartlify.parties FOR
SELECT
  USING (true);

CREATE POLICY parties_insert ON cartlify.parties FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY parties_update ON cartlify.parties
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY parties_delete ON cartlify.parties FOR DELETE USING (cartlify.is_admin ());

----------------------------------------
-- DOCUMENTS AND THE DOCUMENTS OF PRODUCTS
----------------------------------------
-- The directory of the documents (instructions, certificates) and the documents a product names.
-- The card of a product shows them to everybody, so everybody reads; admin/root write. A document
-- changes its title and kind (db/05 guard); the documents of a product are written whole, a row
-- is made or deleted, never changed, so there is no UPDATE policy on product_documents.
ALTER TABLE cartlify.documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS documents_select ON cartlify.documents;

DROP POLICY IF EXISTS documents_insert ON cartlify.documents;

DROP POLICY IF EXISTS documents_update ON cartlify.documents;

DROP POLICY IF EXISTS documents_delete ON cartlify.documents;

CREATE POLICY documents_select ON cartlify.documents FOR
SELECT
  USING (true);

CREATE POLICY documents_insert ON cartlify.documents FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY documents_update ON cartlify.documents
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY documents_delete ON cartlify.documents FOR DELETE USING (cartlify.is_admin ());

ALTER TABLE cartlify.product_documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.product_documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_documents_select ON cartlify.product_documents;

DROP POLICY IF EXISTS product_documents_insert ON cartlify.product_documents;

DROP POLICY IF EXISTS product_documents_delete ON cartlify.product_documents;

CREATE POLICY product_documents_select ON cartlify.product_documents FOR
SELECT
  USING (true);

CREATE POLICY product_documents_insert ON cartlify.product_documents FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY product_documents_delete ON cartlify.product_documents FOR DELETE USING (cartlify.is_admin ());

----------------------------------------
-- CHARACTERISTICS: groups, characteristics, values of a choice, the characteristics of categories
----------------------------------------
-- The directory a variant of a product is described by. The card and the panel of filters show it
-- to everybody, so everybody reads; admin/root write. What a row may change is the business of the
-- guards (db/05); the characteristics of a category are written whole, a row is made or deleted,
-- never changed, so there is no UPDATE policy on category_attributes.

ALTER TABLE cartlify.attribute_groups ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.attribute_groups FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attribute_groups_select ON cartlify.attribute_groups;

DROP POLICY IF EXISTS attribute_groups_insert ON cartlify.attribute_groups;

DROP POLICY IF EXISTS attribute_groups_update ON cartlify.attribute_groups;

DROP POLICY IF EXISTS attribute_groups_delete ON cartlify.attribute_groups;

CREATE POLICY attribute_groups_select ON cartlify.attribute_groups FOR
SELECT
  USING (true);

CREATE POLICY attribute_groups_insert ON cartlify.attribute_groups FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY attribute_groups_update ON cartlify.attribute_groups
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY attribute_groups_delete ON cartlify.attribute_groups FOR DELETE USING (cartlify.is_admin ());

ALTER TABLE cartlify.attributes ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.attributes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attributes_select ON cartlify.attributes;

DROP POLICY IF EXISTS attributes_insert ON cartlify.attributes;

DROP POLICY IF EXISTS attributes_update ON cartlify.attributes;

DROP POLICY IF EXISTS attributes_delete ON cartlify.attributes;

CREATE POLICY attributes_select ON cartlify.attributes FOR
SELECT
  USING (true);

CREATE POLICY attributes_insert ON cartlify.attributes FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY attributes_update ON cartlify.attributes
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY attributes_delete ON cartlify.attributes FOR DELETE USING (cartlify.is_admin ());

ALTER TABLE cartlify.attribute_options ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.attribute_options FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attribute_options_select ON cartlify.attribute_options;

DROP POLICY IF EXISTS attribute_options_insert ON cartlify.attribute_options;

DROP POLICY IF EXISTS attribute_options_update ON cartlify.attribute_options;

DROP POLICY IF EXISTS attribute_options_delete ON cartlify.attribute_options;

CREATE POLICY attribute_options_select ON cartlify.attribute_options FOR
SELECT
  USING (true);

CREATE POLICY attribute_options_insert ON cartlify.attribute_options FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY attribute_options_update ON cartlify.attribute_options
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY attribute_options_delete ON cartlify.attribute_options FOR DELETE USING (cartlify.is_admin ());

ALTER TABLE cartlify.category_attributes ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.category_attributes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS category_attributes_select ON cartlify.category_attributes;

DROP POLICY IF EXISTS category_attributes_insert ON cartlify.category_attributes;

DROP POLICY IF EXISTS category_attributes_delete ON cartlify.category_attributes;

CREATE POLICY category_attributes_select ON cartlify.category_attributes FOR
SELECT
  USING (true);

CREATE POLICY category_attributes_insert ON cartlify.category_attributes FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY category_attributes_delete ON cartlify.category_attributes FOR DELETE USING (cartlify.is_admin ());

----------------------------------------
-- PRODUCTS
----------------------------------------
-- Read by everybody. Written by admin/root, except the numbers the database keeps itself:
-- avgRating, reviewsCount and popularity move only through system functions and triggers, and a
-- view of the product adds one to views. Which columns each role may change:
-- trg_products_update_columns. The price, the sale and the stock are the variant's (PRODUCT
-- VARIANTS below).
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

-- INSERT: admin/root. A new product starts with no rating, reviews, popularity or views: the
-- database counts them from what happens to it.
CREATE POLICY products_insert ON cartlify.products FOR INSERT
WITH
  CHECK (
    cartlify.is_admin ()
    AND "avgRating" = 0
    AND "reviewsCount" = 0
    AND popularity = 0
    AND views = 0
  );

-- UPDATE (who): admin/root. The guard leaves out what the database counts: avgRating and
-- reviewsCount (the reviews), popularity (what people do; an admin sets popularityOverride
-- instead). views may grow by one, as for anybody.
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
-- and reviews, popularity, and the removal of a product with its variants)
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
-- admin/root read them. Only the functions of the database write them: receive_variant_batch
-- brings a batch in; a sale, write_off_variant_stock and a cancel of an order change what is left.
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
-- writes the lines (through consume_variant_stock), nobody changes or removes them, a cancel of
-- the order leaves them too. Read: admin/root.
ALTER TABLE cartlify.order_batch_allocations ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.order_batch_allocations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_batch_allocations_select ON cartlify.order_batch_allocations;

DROP POLICY IF EXISTS order_batch_allocations_select_owner ON cartlify.order_batch_allocations;

DROP POLICY IF EXISTS order_batch_allocations_insert_owner ON cartlify.order_batch_allocations;

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

DROP POLICY IF EXISTS order_batch_allocations_update_owner ON cartlify.order_batch_allocations;

-- UPDATE for the system functions only: the units that came back with a statement of return
-- (receive_return_items); the columns an update may change: trg_order_batch_allocations_update_columns
-- (db/05). Denied to every other role
CREATE POLICY order_batch_allocations_update_owner ON cartlify.order_batch_allocations
FOR UPDATE TO cartlify_owner
  USING (true)
WITH
  CHECK (true);

-- DELETE: denied to every role
CREATE POLICY order_batch_allocations_delete_deny ON cartlify.order_batch_allocations FOR DELETE USING (false);

----------------------------------------
-- RETURNS AND RETURN_ITEMS
----------------------------------------
-- A statement of withdrawal or of return and its rows. Read by the buyer of the order and by admin
-- and root, written only by the system functions that run as the owner (create_return,
-- receive_return_items, confirm_return_proof, refresh_return_state, db/05); the columns an update
-- may change: trg_returns_update_columns, trg_return_items_update_columns (db/05). Never deleted.
ALTER TABLE cartlify.returns ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.returns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS returns_select ON cartlify.returns;

DROP POLICY IF EXISTS returns_select_owner ON cartlify.returns;

DROP POLICY IF EXISTS returns_insert_owner ON cartlify.returns;

DROP POLICY IF EXISTS returns_update_owner ON cartlify.returns;

DROP POLICY IF EXISTS returns_delete_deny ON cartlify.returns;

CREATE POLICY returns_select ON cartlify.returns FOR
SELECT
  USING (
    cartlify.is_owner_or_admin (
      (
        SELECT
          o."userId"
        FROM
          cartlify.orders AS o
        WHERE
          o.id = returns."orderId"
      )
    )
  );

CREATE POLICY returns_select_owner ON cartlify.returns FOR
SELECT
  TO cartlify_owner USING (true);

CREATE POLICY returns_insert_owner ON cartlify.returns FOR INSERT TO cartlify_owner
WITH
  CHECK (true);

CREATE POLICY returns_update_owner ON cartlify.returns
FOR UPDATE TO cartlify_owner
  USING (true)
WITH
  CHECK (true);

CREATE POLICY returns_delete_deny ON cartlify.returns FOR DELETE USING (false);

ALTER TABLE cartlify.return_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.return_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS return_items_select ON cartlify.return_items;

DROP POLICY IF EXISTS return_items_select_owner ON cartlify.return_items;

DROP POLICY IF EXISTS return_items_insert_owner ON cartlify.return_items;

DROP POLICY IF EXISTS return_items_update_owner ON cartlify.return_items;

DROP POLICY IF EXISTS return_items_delete_deny ON cartlify.return_items;

-- the rows of the statements the reader sees
CREATE POLICY return_items_select ON cartlify.return_items FOR
SELECT
  USING (
    EXISTS (
      SELECT
        1
      FROM
        cartlify.returns AS r
      WHERE
        r.id = return_items."returnId"
    )
  );

CREATE POLICY return_items_select_owner ON cartlify.return_items FOR
SELECT
  TO cartlify_owner USING (true);

CREATE POLICY return_items_insert_owner ON cartlify.return_items FOR INSERT TO cartlify_owner
WITH
  CHECK (true);

CREATE POLICY return_items_update_owner ON cartlify.return_items
FOR UPDATE TO cartlify_owner
  USING (true)
WITH
  CHECK (true);

CREATE POLICY return_items_delete_deny ON cartlify.return_items FOR DELETE USING (false);

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
-- PRODUCT VARIANTS
----------------------------------------
-- Read by everybody (what a buyer sees of a deleted variant is decided by the server). Written by
-- admin/root, except the numbers the database keeps itself: stock and reservedStock move only
-- through system functions (a delivery, a sale, a write-off, a cancel, a reservation). Which
-- columns each role may change: trg_product_variants_update_columns.
ALTER TABLE cartlify.product_variants ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.product_variants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_variants_select ON cartlify.product_variants;

DROP POLICY IF EXISTS product_variants_insert ON cartlify.product_variants;

DROP POLICY IF EXISTS product_variants_update_admin ON cartlify.product_variants;

DROP POLICY IF EXISTS product_variants_update_owner ON cartlify.product_variants;

DROP POLICY IF EXISTS product_variants_delete ON cartlify.product_variants;

CREATE POLICY product_variants_select ON cartlify.product_variants FOR
SELECT
  USING (true);

-- INSERT: admin/root. A new variant starts with no stock and no reserve (the stock comes with the
-- batches of a delivery, receive_variant_batch). It starts with no sale either: a sale is set on a
-- variant that is in the catalog (the check of the end of a sale in db/05 runs on UPDATE only).
CREATE POLICY product_variants_insert ON cartlify.product_variants FOR INSERT
WITH
  CHECK (
    cartlify.is_admin ()
    AND "stock" = 0
    AND "reservedStock" = 0
    AND "salePrice" IS NULL
    AND "saleEndsAt" IS NULL
  );

-- UPDATE (who): admin/root. The guard leaves out what the database counts: stock (what the
-- batches have left: a delivery, a sale, a write-off, a cancel) and reservedStock (what the waiting
-- orders hold).
CREATE POLICY product_variants_update_admin ON cartlify.product_variants
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  -- the columns an update may change: trg_product_variants_update_columns (db/05)
  CHECK (true);

-- UPDATE for the system functions: stock and reserve, and the removal of the variants of a
-- product that is removed
CREATE POLICY product_variants_update_owner ON cartlify.product_variants
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  -- the columns an update may change: trg_product_variants_update_columns (db/05)
  CHECK (true);

CREATE POLICY product_variants_delete ON cartlify.product_variants FOR DELETE USING (cartlify.is_admin ());

----------------------------------------
-- VARIANT IMAGES
----------------------------------------
-- The pictures of the gallery a variant shows, with their places. Read by everybody, written by
-- admin/root.
ALTER TABLE cartlify.variant_images ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.variant_images FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS variant_images_select ON cartlify.variant_images;

DROP POLICY IF EXISTS variant_images_insert ON cartlify.variant_images;

DROP POLICY IF EXISTS variant_images_update ON cartlify.variant_images;

DROP POLICY IF EXISTS variant_images_delete ON cartlify.variant_images;

CREATE POLICY variant_images_select ON cartlify.variant_images FOR
SELECT
  USING (true);

CREATE POLICY variant_images_insert ON cartlify.variant_images FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY variant_images_update ON cartlify.variant_images
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY variant_images_delete ON cartlify.variant_images FOR DELETE USING (cartlify.is_admin ());

----------------------------------------
-- VALUES OF CHARACTERISTICS OF VARIANTS
----------------------------------------
-- What a variant has of each characteristic of the directory (a text, a number, yes/no, one or
-- several values of a list), one row for a value. The card, the name of a variant and the panel of
-- filters show it to everybody, so everybody reads; admin/root write. A value stays within the type
-- of its characteristic and a row changes only its value (trg_variant_attribute_values_before_write
-- and trg_variant_attribute_values_update_columns, db/05).
ALTER TABLE cartlify.variant_attribute_values ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.variant_attribute_values FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS variant_attribute_values_select ON cartlify.variant_attribute_values;

DROP POLICY IF EXISTS variant_attribute_values_insert ON cartlify.variant_attribute_values;

DROP POLICY IF EXISTS variant_attribute_values_update ON cartlify.variant_attribute_values;

DROP POLICY IF EXISTS variant_attribute_values_delete ON cartlify.variant_attribute_values;

CREATE POLICY variant_attribute_values_select ON cartlify.variant_attribute_values FOR
SELECT
  USING (true);

CREATE POLICY variant_attribute_values_insert ON cartlify.variant_attribute_values FOR INSERT
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY variant_attribute_values_update ON cartlify.variant_attribute_values
FOR UPDATE
  USING (cartlify.is_admin ())
WITH
  CHECK (cartlify.is_admin ());

CREATE POLICY variant_attribute_values_delete ON cartlify.variant_attribute_values FOR DELETE USING (cartlify.is_admin ());

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

DROP POLICY IF EXISTS orders_update_owner_returns ON cartlify.orders;

DROP POLICY IF EXISTS orders_delete ON cartlify.orders;

CREATE POLICY orders_select ON cartlify.orders FOR
SELECT
  USING (cartlify.is_owner_or_admin ("userId"));

-- SELECT for the system functions
CREATE POLICY orders_select_owner ON cartlify.orders FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT: a USER, a new cart of their own: not confirmed, no reservation, payment, dates or
-- statements of return
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
    AND "returnStatus" = 'none'
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
-- here: the order is cancelled by its statements of return (refresh_return_state), which return the stock.
CREATE POLICY orders_update_admin_shipping_status ON cartlify.orders
FOR UPDATE
  USING (
    cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
    AND status IN ('paid', 'shipped', 'delivered')
  )
WITH
  -- the columns an update may change: trg_orders_update_columns (db/05)
  CHECK (true);

-- UPDATE for the statements of return: the system functions that make and settle them lock a
-- confirmed order and set the state of the order as to its statements (refresh_return_state). The
-- guard lets that update change returnStatus, and the cancel it brings (status and cancelledAt),
-- and nothing else (trg_orders_update_columns, db/05).
CREATE POLICY orders_update_owner_returns ON cartlify.orders
FOR UPDATE
  TO cartlify_owner USING (confirmed = true)
WITH
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
-- The parcels of an order: the times the order was sent with a carrier outside the app, one row
-- each (a send that was rolled back stays, marked), written and corrected by admin/root; and the
-- parcels of its statements (the goods back to the shop, the goods not accepted back to the buyer),
-- written and changed only by the system functions that run as the owner (record_return_shipment,
-- provide_return_proof, confirm_return_proof, db/05). The buyer of the order can read the rows (the
-- server gives the buyer what is theirs to see; what a parcel cost the shop is a line of the money
-- journal). What an update may change: trg_order_shipments_update_columns.
ALTER TABLE cartlify.order_shipments ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.order_shipments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_shipments_select ON cartlify.order_shipments;

DROP POLICY IF EXISTS order_shipments_select_owner ON cartlify.order_shipments;

DROP POLICY IF EXISTS order_shipments_insert ON cartlify.order_shipments;

DROP POLICY IF EXISTS order_shipments_update ON cartlify.order_shipments;

DROP POLICY IF EXISTS order_shipments_insert_owner ON cartlify.order_shipments;

DROP POLICY IF EXISTS order_shipments_update_owner ON cartlify.order_shipments;

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

-- INSERT: admin/root, a send of a shipped order; a new send is not rolled back and the shop owes
-- the carrier for it (expense). A parcel of a statement only by the functions of the owner (below)
CREATE POLICY order_shipments_insert ON cartlify.order_shipments FOR INSERT
WITH
  CHECK (
    cartlify.current_actor_role () IN ('ADMIN', 'ROOT')
    AND "returnId" IS NULL
    AND direction = 'to_buyer'
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

-- UPDATE: admin/root, a send of the order. A send that was rolled back is history: the guard lets
-- only the mark of what the shop owes for it change.
CREATE POLICY order_shipments_update ON cartlify.order_shipments
FOR UPDATE
  USING (cartlify.current_actor_role () IN ('ADMIN', 'ROOT') AND "returnId" IS NULL)
WITH
  -- the columns an update may change: trg_order_shipments_update_columns (db/05)
  CHECK ("returnId" IS NULL);

-- the parcels of the statements: the system functions write and change them, for whoever they work
-- (the buyer of an account telling of the parcel, an admin recording or confirming one)
CREATE POLICY order_shipments_insert_owner ON cartlify.order_shipments FOR INSERT TO cartlify_owner
WITH
  CHECK (true);

CREATE POLICY order_shipments_update_owner ON cartlify.order_shipments
FOR UPDATE TO cartlify_owner
  USING (true)
WITH
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
-- log_variant_price_change; no role changes or removes a line.
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
-- lets log_variant_price_change through
CREATE POLICY ppcl_insert ON cartlify.product_price_change_logs FOR INSERT
WITH
  CHECK (false);

-- INSERT for log_variant_price_change: the line of a signed-in admin, in their name. The system
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
-- admin/root. A line is never removed or changed, but by the cleanup of the retention terms (the
-- owner): it empties the address and the browser of a line the buyer caused
-- (trg_admin_audit_log_update_columns says which columns, db/05).
ALTER TABLE cartlify.admin_audit_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.admin_audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aal_select ON cartlify.admin_audit_log;

DROP POLICY IF EXISTS aal_insert ON cartlify.admin_audit_log;

DROP POLICY IF EXISTS aal_update_deny ON cartlify.admin_audit_log;

DROP POLICY IF EXISTS aal_update_owner ON cartlify.admin_audit_log;

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

-- UPDATE: denied to every role but the owner (the cleanup of the retention terms)
CREATE POLICY aal_update_deny ON cartlify.admin_audit_log
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

CREATE POLICY aal_update_owner ON cartlify.admin_audit_log
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  CHECK (true);

-- DELETE: denied to every role
CREATE POLICY aal_delete_deny ON cartlify.admin_audit_log FOR DELETE USING (false);

----------------------------------------
-- STOCK LOG
----------------------------------------
-- The journal of the stock: a line for every change of the quantity of a variant. Read: admin/root.
-- A line is written by the system functions that move the stock (cartlify.log_stock_change, called
-- from receive_variant_batch, write_off_variant_stock, consume_variant_stock and
-- return_units_to_batches, which run as the owner) and never changed or removed.
ALTER TABLE cartlify.stock_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.stock_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_log_select ON cartlify.stock_log;

DROP POLICY IF EXISTS stock_log_insert_owner ON cartlify.stock_log;

DROP POLICY IF EXISTS stock_log_update_deny ON cartlify.stock_log;

DROP POLICY IF EXISTS stock_log_update_owner ON cartlify.stock_log;

DROP POLICY IF EXISTS stock_log_delete_deny ON cartlify.stock_log;

CREATE POLICY stock_log_select ON cartlify.stock_log FOR
SELECT
  USING (cartlify.is_admin ());

-- INSERT for the system functions: a line names who did it. A signed-in admin or root is named
-- with their own role; the system (the admin context without a user id, the payment webhook) has
-- no actor and no role; a buyer is named on the lines of the units that came back with their own
-- statement of withdrawal of a paid order (stock.return, create_return), which name the row of the
-- statement. The app role has no insert policy: it writes nothing here.
CREATE POLICY stock_log_insert_owner ON cartlify.stock_log FOR INSERT TO cartlify_owner
WITH
  CHECK (
    (
      cartlify.is_system ()
      AND "actorId" IS NULL
      AND "actorRole" IS NULL
    )
    OR (
      cartlify.is_admin ()
      AND "actorId" = cartlify.current_actor_id ()
      AND "actorRole" = cartlify.current_actor_role ()
    )
    OR (
      cartlify.current_actor_role () = 'USER'
      AND event IN ('stock.return', 'stock.return_write_off')
      AND "actorId" = cartlify.current_actor_id ()
      AND "actorRole" = 'USER'
      AND EXISTS (
        SELECT 1
        FROM cartlify.return_items AS ri
        JOIN cartlify.returns AS rr ON rr.id = ri."returnId"
        WHERE ri.id = "returnItemId" AND rr."createdById" = cartlify.current_actor_id ()
      )
    )
  );

-- UPDATE: denied to every role but the owner (the cleanup of the retention terms empties the
-- address and the browser of a line, trg_stock_log_append_only says so, db/05)
CREATE POLICY stock_log_update_deny ON cartlify.stock_log
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

CREATE POLICY stock_log_update_owner ON cartlify.stock_log
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  CHECK (true);

-- DELETE: denied to every role
CREATE POLICY stock_log_delete_deny ON cartlify.stock_log FOR DELETE USING (false);

----------------------------------------
-- MONEY LOG
----------------------------------------
-- The journal of the money: a line for every movement of money. Read: admin/root, and a buyer reads
-- the lines of their own money (the app gives a buyer only the safe fields). A line is written by
-- the system functions that move the money (cartlify.log_money_change, called from pay_order,
-- begin_return_refund, settle_money_refund and the others, which run as the owner) and never
-- changed or removed, except the few once-written fields db/05 names (money_log_append_only).
ALTER TABLE cartlify.money_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.money_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS money_log_select ON cartlify.money_log;

DROP POLICY IF EXISTS money_log_insert_owner ON cartlify.money_log;

DROP POLICY IF EXISTS money_log_update_deny ON cartlify.money_log;

DROP POLICY IF EXISTS money_log_update_owner ON cartlify.money_log;

DROP POLICY IF EXISTS money_log_delete_deny ON cartlify.money_log;

CREATE POLICY money_log_select ON cartlify.money_log FOR
SELECT
  USING (
    cartlify.is_admin ()
    OR (
      cartlify.current_actor_role () = 'USER'
      AND "userId" IS NOT NULL
      AND "userId" = cartlify.current_actor_id ()
    )
  );

-- INSERT for the system functions: a line names who did it. A signed-in admin or root is named
-- with their own role; the system (the admin context without a user id: the webhook, the worker)
-- has no actor and no role. The app role has no insert policy: it writes nothing here.
CREATE POLICY money_log_insert_owner ON cartlify.money_log FOR INSERT TO cartlify_owner
WITH
  CHECK (
    (
      cartlify.is_system ()
      AND "actorId" IS NULL
      AND "actorRole" IS NULL
    )
    OR (
      cartlify.is_admin ()
      AND "actorId" = cartlify.current_actor_id ()
      AND "actorRole" = cartlify.current_actor_role ()
    )
  );

-- UPDATE: denied to every role but the owner (the functions of the database write the few fields
-- of a line that are written once, the cleanup of the retention terms empties the notes, the
-- address and the browser; trg_money_log_append_only, db/05, says what is allowed)
CREATE POLICY money_log_update_deny ON cartlify.money_log
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

CREATE POLICY money_log_update_owner ON cartlify.money_log
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  CHECK (true);

-- DELETE: denied to every role
CREATE POLICY money_log_delete_deny ON cartlify.money_log FOR DELETE USING (false);

----------------------------------------
-- PAYMENT DISPUTES
----------------------------------------
-- A dispute of a payment at the bank: its description and where it stands. Read: admin/root. It is
-- written only by the function that follows the provider (sync_payment_dispute, run as the owner)
-- and never removed.
ALTER TABLE cartlify.payment_disputes ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.payment_disputes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_disputes_select ON cartlify.payment_disputes;

DROP POLICY IF EXISTS payment_disputes_insert_owner ON cartlify.payment_disputes;

DROP POLICY IF EXISTS payment_disputes_update_deny ON cartlify.payment_disputes;

DROP POLICY IF EXISTS payment_disputes_update_owner ON cartlify.payment_disputes;

DROP POLICY IF EXISTS payment_disputes_delete_deny ON cartlify.payment_disputes;

CREATE POLICY payment_disputes_select ON cartlify.payment_disputes FOR
SELECT
  USING (cartlify.is_admin ());

CREATE POLICY payment_disputes_insert_owner ON cartlify.payment_disputes FOR INSERT TO cartlify_owner
WITH
  CHECK (cartlify.is_system ());

CREATE POLICY payment_disputes_update_deny ON cartlify.payment_disputes
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

CREATE POLICY payment_disputes_update_owner ON cartlify.payment_disputes
FOR UPDATE
  TO cartlify_owner USING (cartlify.is_system ())
WITH
  CHECK (cartlify.is_system ());

CREATE POLICY payment_disputes_delete_deny ON cartlify.payment_disputes FOR DELETE USING (false);

----------------------------------------
-- SHOP SETTINGS
----------------------------------------
-- The data of the shop (delivery, brand, reservation, moderation, withdrawal, languages, the
-- seller the shop names, the logo): a row is one setting and the value it took, added, never
-- changed or removed; the current value of a setting is its latest row. The app reads the rows
-- under the system context, at the start of the server and inside every write, to fill its own
-- cache (the public settings and the ones guest/user never see are both in the cache, the routes
-- decide which ones a role is shown, docs/shop-settings.md); root reads every row (the history).
-- A row is written by root, in their own name, or by the server under the system context (the
-- admin context with no user id, cartlify.is_system), which fills in the server's own default
-- of a setting that has no row yet.
ALTER TABLE cartlify.shop_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.shop_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shop_settings_select ON cartlify.shop_settings;

DROP POLICY IF EXISTS shop_settings_insert ON cartlify.shop_settings;

DROP POLICY IF EXISTS shop_settings_update_deny ON cartlify.shop_settings;

DROP POLICY IF EXISTS shop_settings_delete_deny ON cartlify.shop_settings;

-- Every row is open to admin/root at this level (a self-querying USING clause, such as "the
-- latest row of each key", makes Postgres recurse into the same policy and refuse the query);
-- the app shows root every row (GET /api/root/shop-settings/history) and admin only the current
-- values (GET /api/admin/shop-settings, docs/shop-settings.md).
CREATE POLICY shop_settings_select ON cartlify.shop_settings FOR
SELECT
  USING (cartlify.is_admin ());

-- INSERT: root writes a setting in their own name; the system writes one with no author, only to
-- fill in the default of a setting that has no row yet.
CREATE POLICY shop_settings_insert ON cartlify.shop_settings FOR INSERT
WITH
  CHECK (
    (
      cartlify.is_root ()
      AND "setById" = cartlify.current_actor_id ()
    )
    OR (
      cartlify.is_system ()
      AND "setById" IS NULL
    )
  );

-- UPDATE: denied to every role
CREATE POLICY shop_settings_update_deny ON cartlify.shop_settings
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- DELETE: denied to every role
CREATE POLICY shop_settings_delete_deny ON cartlify.shop_settings FOR DELETE USING (false);

----------------------------------------
-- NEWSLETTER SUBSCRIPTIONS
----------------------------------------
-- The present state of one address: whether it waits for the confirmation, is in force, was paused
-- by a complaint, stopped by a bounce or ended. Read: the one who runs the newsletters
-- (cartlify.newsletter_manager: root, or an admin root allowed), the system, and the account a
-- subscription belongs to. Nobody writes it with a statement of the app: the functions of the
-- database do (TO cartlify_owner: the guest who asks on the form, the person who follows the link
-- of a mail, the account that subscribes, the webhook that reports a bounce), and the guard
-- trg_newsletter_subscriptions_update_columns (db/05) says what they may change. The rows of the
-- tables below are read by the functions the same way; no policy lets a guest reach one.
ALTER TABLE cartlify.newsletter_subscriptions ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.newsletter_subscriptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS newsletter_subscriptions_select ON cartlify.newsletter_subscriptions;

DROP POLICY IF EXISTS newsletter_subscriptions_select_owner ON cartlify.newsletter_subscriptions;

DROP POLICY IF EXISTS newsletter_subscriptions_insert_owner ON cartlify.newsletter_subscriptions;

DROP POLICY IF EXISTS newsletter_subscriptions_update_owner ON cartlify.newsletter_subscriptions;

DROP POLICY IF EXISTS newsletter_subscriptions_delete_owner ON cartlify.newsletter_subscriptions;

CREATE POLICY newsletter_subscriptions_select ON cartlify.newsletter_subscriptions FOR
SELECT
  USING (
    (SELECT cartlify.newsletter_manager ())
    OR cartlify.is_system ()
    OR ("userId" IS NOT NULL AND cartlify.is_owner ("userId"))
  );

-- the functions read any row (they find a subscription by the hash of a link, or by an address)
CREATE POLICY newsletter_subscriptions_select_owner ON cartlify.newsletter_subscriptions FOR
SELECT
  TO cartlify_owner USING (true);

CREATE POLICY newsletter_subscriptions_insert_owner ON cartlify.newsletter_subscriptions FOR INSERT TO cartlify_owner
WITH
  CHECK (true);

CREATE POLICY newsletter_subscriptions_update_owner ON cartlify.newsletter_subscriptions
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  -- the columns an update may change: trg_newsletter_subscriptions_update_columns (db/05)
  CHECK (true);

-- DELETE for the functions: a request that was not confirmed, a subscriber an admin removes, an
-- ended subscription whose term of keeping has passed (the guard of the journal lets the lines go
-- with an ended one)
CREATE POLICY newsletter_subscriptions_delete_owner ON cartlify.newsletter_subscriptions FOR DELETE TO cartlify_owner USING (true);

----------------------------------------
-- NEWSLETTER SUBSCRIPTION EVENTS
----------------------------------------
-- The journal of a subscription: what happened, when, from which address and browser, and the
-- version of the privacy policy on the events of consent. Read: the one who runs the newsletters.
-- Written by the functions of the database, never changed (UPDATE denied to every role, the owner
-- too, but for one step: when an admin erases an address, the owner empties the address and the
-- browser of the lines of the subscription that has become anonymous), removed only by the owner,
-- and only with an ended subscription: the guard trg_newsletter_subscription_events_append_only
-- (db/05) says so a second time.
ALTER TABLE cartlify.newsletter_subscription_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.newsletter_subscription_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS newsletter_subscription_events_select ON cartlify.newsletter_subscription_events;

DROP POLICY IF EXISTS newsletter_subscription_events_select_owner ON cartlify.newsletter_subscription_events;

DROP POLICY IF EXISTS newsletter_subscription_events_insert_owner ON cartlify.newsletter_subscription_events;

DROP POLICY IF EXISTS newsletter_subscription_events_update_deny ON cartlify.newsletter_subscription_events;

DROP POLICY IF EXISTS newsletter_subscription_events_update_owner ON cartlify.newsletter_subscription_events;

DROP POLICY IF EXISTS newsletter_subscription_events_delete_owner ON cartlify.newsletter_subscription_events;

CREATE POLICY newsletter_subscription_events_select ON cartlify.newsletter_subscription_events FOR
SELECT
  USING ((SELECT cartlify.newsletter_manager ()));

-- the functions read the journal of a subscription (the export of the person, the removal)
CREATE POLICY newsletter_subscription_events_select_owner ON cartlify.newsletter_subscription_events FOR
SELECT
  TO cartlify_owner USING (true);

CREATE POLICY newsletter_subscription_events_insert_owner ON cartlify.newsletter_subscription_events FOR INSERT TO cartlify_owner
WITH
  CHECK (true);

-- UPDATE: denied to every role
CREATE POLICY newsletter_subscription_events_update_deny ON cartlify.newsletter_subscription_events
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- ... but for the owner, on the lines of a subscription an admin erased (it ended or stopped, and has
-- the placeholder of its id in the place of the address), who empties the address and the browser of
-- a line: the new row must have neither. The columns that may not change: the guard
CREATE POLICY newsletter_subscription_events_update_owner ON cartlify.newsletter_subscription_events
FOR UPDATE
  TO cartlify_owner USING (
    EXISTS (
      SELECT 1
      FROM cartlify.newsletter_subscriptions AS s
      WHERE s.id = "subscriptionId"
        AND s.status IN ('ended', 'stopped_bounce')
        AND s.email = cartlify.newsletter_erased_email (s.id)
    )
  )
WITH
  CHECK (ip IS NULL AND "userAgent" IS NULL);

-- DELETE: the owner only; the guard lets it remove the lines of an ended subscription
CREATE POLICY newsletter_subscription_events_delete_owner ON cartlify.newsletter_subscription_events FOR DELETE TO cartlify_owner USING (true);

----------------------------------------
-- NEWSLETTER CAMPAIGNS
----------------------------------------
-- A newsletter, from the draft to the end of the sending. Read: the one who runs the newsletters
-- and the system. Written by the one who runs them (a draft, in their own name), moved along by
-- the system (it starts and finishes a campaign) and by the functions of the database (the totals).
-- Which columns and which moves: trg_newsletter_campaigns_update_columns (db/05). Deleted by a
-- manager while it is a draft; what was scheduled or sent is kept.
ALTER TABLE cartlify.newsletter_campaigns ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.newsletter_campaigns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS newsletter_campaigns_select ON cartlify.newsletter_campaigns;

DROP POLICY IF EXISTS newsletter_campaigns_select_owner ON cartlify.newsletter_campaigns;

DROP POLICY IF EXISTS newsletter_campaigns_insert ON cartlify.newsletter_campaigns;

DROP POLICY IF EXISTS newsletter_campaigns_update ON cartlify.newsletter_campaigns;

DROP POLICY IF EXISTS newsletter_campaigns_update_owner ON cartlify.newsletter_campaigns;

DROP POLICY IF EXISTS newsletter_campaigns_delete ON cartlify.newsletter_campaigns;

CREATE POLICY newsletter_campaigns_select ON cartlify.newsletter_campaigns FOR
SELECT
  USING (
    (SELECT cartlify.newsletter_manager ())
    OR cartlify.is_system ()
  );

-- the functions read any campaign (an unsubscribe by the link of a mail counts it, a guest asks)
CREATE POLICY newsletter_campaigns_select_owner ON cartlify.newsletter_campaigns FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT: a manager makes a draft in their own name (the maker and the editor are the one who
-- inserts it; a draft has no start, no totals and no data of products, db/06)
CREATE POLICY newsletter_campaigns_insert ON cartlify.newsletter_campaigns FOR INSERT
WITH
  CHECK (
    (SELECT cartlify.newsletter_manager ())
    AND status = 'draft'
    AND "createdById" = cartlify.current_actor_id ()
    AND "updatedById" = cartlify.current_actor_id ()
  );

-- UPDATE (who): a manager and the system; (what): the guard
CREATE POLICY newsletter_campaigns_update ON cartlify.newsletter_campaigns
FOR UPDATE
  USING (
    (SELECT cartlify.newsletter_manager ())
    OR cartlify.is_system ()
  )
WITH
  -- the columns an update may change: trg_newsletter_campaigns_update_columns (db/05)
  CHECK (true);

-- UPDATE for the functions of the database: the totals of a campaign (an unsubscribe, a bounce, a
-- complaint) and the link to an original that was deleted
CREATE POLICY newsletter_campaigns_update_owner ON cartlify.newsletter_campaigns
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  -- the columns an update may change: trg_newsletter_campaigns_update_columns (db/05)
  CHECK (true);

-- DELETE: a manager, while the campaign is a draft
CREATE POLICY newsletter_campaigns_delete ON cartlify.newsletter_campaigns FOR DELETE USING (
  (SELECT cartlify.newsletter_manager ())
  AND status = 'draft'
);

----------------------------------------
-- NEWSLETTER RECIPIENTS
----------------------------------------
-- One mail of a campaign, a row for each subscriber it goes to, made when the campaign starts.
-- Read: the one who runs the newsletters and the system. Added by the functions of the database
-- (as a mail that waits), changed by the system and by them (the status, the tries, the id of the
-- mail), removed with the campaign or the subscription. A row keeps its campaign, its subscription
-- and its language: trg_newsletter_recipients_update_columns (db/05).
ALTER TABLE cartlify.newsletter_recipients ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.newsletter_recipients FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS newsletter_recipients_select ON cartlify.newsletter_recipients;

DROP POLICY IF EXISTS newsletter_recipients_select_owner ON cartlify.newsletter_recipients;

DROP POLICY IF EXISTS newsletter_recipients_insert_owner ON cartlify.newsletter_recipients;

DROP POLICY IF EXISTS newsletter_recipients_update ON cartlify.newsletter_recipients;

DROP POLICY IF EXISTS newsletter_recipients_update_owner ON cartlify.newsletter_recipients;

DROP POLICY IF EXISTS newsletter_recipients_delete_owner ON cartlify.newsletter_recipients;

CREATE POLICY newsletter_recipients_select ON cartlify.newsletter_recipients FOR
SELECT
  USING (
    (SELECT cartlify.newsletter_manager ())
    OR cartlify.is_system ()
  );

CREATE POLICY newsletter_recipients_select_owner ON cartlify.newsletter_recipients FOR
SELECT
  TO cartlify_owner USING (true);

-- INSERT for the function that starts a campaign: a mail that waits, not tried, not sent
CREATE POLICY newsletter_recipients_insert_owner ON cartlify.newsletter_recipients FOR INSERT TO cartlify_owner
WITH
  CHECK (
    status = 'queued'
    AND attempts = 0
    AND "providerMessageId" IS NULL
    AND "sentAt" IS NULL
  );

-- UPDATE (who): the system, which sends the mails and records how it went
CREATE POLICY newsletter_recipients_update ON cartlify.newsletter_recipients
FOR UPDATE
  USING (cartlify.is_system ())
WITH
  -- the columns an update may change: trg_newsletter_recipients_update_columns (db/05)
  CHECK (true);

-- UPDATE for the functions of the database: the events of the provider (a bounce, a complaint)
CREATE POLICY newsletter_recipients_update_owner ON cartlify.newsletter_recipients
FOR UPDATE
  TO cartlify_owner USING (true)
WITH
  -- the columns an update may change: trg_newsletter_recipients_update_columns (db/05)
  CHECK (true);

CREATE POLICY newsletter_recipients_delete_owner ON cartlify.newsletter_recipients FOR DELETE TO cartlify_owner USING (true);

----------------------------------------
-- NEWSLETTER FORM BLOCKLIST
----------------------------------------
-- The addresses blocked for the public form, kept as the HMAC of the address (a table that lists
-- no address). Read: the one who runs the newsletters, who finds an entry by the HMAC of the
-- address a person gives, and removes it on their word. Added by the functions of the database
-- (an admin blocks an address, or the person does with the button of a mail). Never changed.
ALTER TABLE cartlify.newsletter_form_blocklist ENABLE ROW LEVEL SECURITY;

ALTER TABLE cartlify.newsletter_form_blocklist FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS newsletter_form_blocklist_select ON cartlify.newsletter_form_blocklist;

DROP POLICY IF EXISTS newsletter_form_blocklist_select_owner ON cartlify.newsletter_form_blocklist;

DROP POLICY IF EXISTS newsletter_form_blocklist_insert_owner ON cartlify.newsletter_form_blocklist;

DROP POLICY IF EXISTS newsletter_form_blocklist_update_deny ON cartlify.newsletter_form_blocklist;

DROP POLICY IF EXISTS newsletter_form_blocklist_delete ON cartlify.newsletter_form_blocklist;

DROP POLICY IF EXISTS newsletter_form_blocklist_delete_owner ON cartlify.newsletter_form_blocklist;

CREATE POLICY newsletter_form_blocklist_select ON cartlify.newsletter_form_blocklist FOR
SELECT
  USING ((SELECT cartlify.newsletter_manager ()));

-- the functions look an address up (the form of a guest asks whether it is blocked)
CREATE POLICY newsletter_form_blocklist_select_owner ON cartlify.newsletter_form_blocklist FOR
SELECT
  TO cartlify_owner USING (true);

CREATE POLICY newsletter_form_blocklist_insert_owner ON cartlify.newsletter_form_blocklist FOR INSERT TO cartlify_owner
WITH
  CHECK (true);

-- UPDATE: denied to every role
CREATE POLICY newsletter_form_blocklist_update_deny ON cartlify.newsletter_form_blocklist
FOR UPDATE
  USING (false)
WITH
  CHECK (false);

-- DELETE: a manager takes an address off the list
CREATE POLICY newsletter_form_blocklist_delete ON cartlify.newsletter_form_blocklist FOR DELETE USING ((SELECT cartlify.newsletter_manager ()));

CREATE POLICY newsletter_form_blocklist_delete_owner ON cartlify.newsletter_form_blocklist FOR DELETE TO cartlify_owner USING (true);

COMMIT;