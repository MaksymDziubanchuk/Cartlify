-- anonymization of a copy of prod before it goes to dev (db/tools/dev_restore_from_prod.mjs):
-- runs as superuser in the throwaway database the copy is loaded into, before the copy is dumped,
-- so neither the dump nor dev holds the people of the shop. The catalog, the stock, the money and
-- the history of the orders stay as they are. The staff (ADMIN, ROOT, not deleted) keep their
-- accounts, so dev can be entered; their sessions go with all the others.
-- psql variable password_hash: the bcrypt hash every buyer who had a password gets, set by the
-- tool before this file; empty - no buyer logs in with a password
\set ON_ERROR_STOP on
\if :{?password_hash}
\else
\set password_hash ''
\endif

BEGIN;

-- the rows are taken as they are and only their personal columns change: the triggers would
-- refuse it (a confirmed order keeps its shipping, the logs are history) or change more
-- (updatedAt, the email); the checks of the tables still hold
SET LOCAL session_replication_role = replica;

------------------------------------------------------------
-- 1. WHAT THIS FILE KNOWS
------------------------------------------------------------
-- every column of the tables of people and the tables with no personal data: a table this file
-- does not know, or a new column of a table of people, stops the copy before anything is dumped
DO $$
DECLARE
  v_unknown text;
BEGIN
  WITH known (table_name, column_name) AS (
    VALUES
      -- tables of people, the personal columns change below
      ('users', 'id'), ('users', 'email'), ('users', 'role'), ('users', 'isVerified'),
      ('users', 'createdAt'), ('users', 'updatedAt'), ('users', 'name'), ('users', 'avatarUrl'),
      ('users', 'locale'), ('users', 'phone'), ('users', 'passwordHash'),
      ('users', 'authProvider'), ('users', 'providerSub'), ('users', 'publicId'),
      ('users', 'deletedAt'),
      ('user_tokens', 'id'), ('user_tokens', 'userId'), ('user_tokens', 'type'),
      ('user_tokens', 'token'), ('user_tokens', 'expiresAt'), ('user_tokens', 'usedAt'),
      ('user_tokens', 'createdAt'), ('user_tokens', 'revokedAt'), ('user_tokens', 'sessionId'),
      ('user_tokens', 'userAgent'),
      ('login_logs', 'id'), ('login_logs', 'userId'), ('login_logs', 'email'),
      ('login_logs', 'role'), ('login_logs', 'ipAddress'), ('login_logs', 'userAgent'),
      ('login_logs', 'createdAt'),
      ('orders', 'id'), ('orders', 'userId'), ('orders', 'status'), ('orders', 'total'),
      ('orders', 'shippingAddress'), ('orders', 'note'), ('orders', 'createdAt'),
      ('orders', 'updatedAt'), ('orders', 'confirmed'), ('orders', 'reservationExpiresAt'),
      ('orders', 'recipientFirstName'), ('orders', 'recipientLastName'),
      ('orders', 'recipientPhone'), ('orders', 'paymentId'), ('orders', 'paymentProvider'),
      ('orders', 'cancelledAt'), ('orders', 'paidAt'),
      ('chat_threads', 'id'), ('chat_threads', 'userId'), ('chat_threads', 'type'),
      ('chat_threads', 'status'), ('chat_threads', 'lastMessageAt'),
      ('chat_threads', 'unreadCount'), ('chat_threads', 'lastMessagePreview'),
      ('chat_threads', 'createdAt'), ('chat_threads', 'updatedAt'), ('chat_threads', 'guestId'),
      ('chat_threads', 'adminUnreadSince'), ('chat_threads', 'adminRequestedAt'),
      ('chat_messages', 'id'), ('chat_messages', 'threadId'), ('chat_messages', 'senderId'),
      ('chat_messages', 'senderType'), ('chat_messages', 'content'), ('chat_messages', 'isRead'),
      ('chat_messages', 'createdAt'),
      ('admin_audit_log', 'id'), ('admin_audit_log', 'actorId'), ('admin_audit_log', 'actorRole'),
      ('admin_audit_log', 'entityType'), ('admin_audit_log', 'entityId'),
      ('admin_audit_log', 'action'), ('admin_audit_log', 'meta'), ('admin_audit_log', 'ip'),
      ('admin_audit_log', 'userAgent'), ('admin_audit_log', 'createdAt'),
      -- a review is public: the shop shows it with its author, whose name changes above
      ('reviews', 'id'), ('reviews', 'productId'), ('reviews', 'userId'), ('reviews', 'rating'),
      ('reviews', 'comment'), ('reviews', 'createdAt'), ('reviews', 'downVotes'),
      ('reviews', 'upVotes'), ('reviews', 'updatedAt'),
      -- tables with no personal data: the catalog, the stock, the money, what links them
      ('_prisma_migrations', '*'), ('admin_alert_mutes', '*'), ('categories', '*'),
      ('favorites', '*'), ('order_batch_allocations', '*'), ('order_items', '*'),
      ('product_batches', '*'), ('product_images', '*'), ('product_price_change_logs', '*'),
      ('products', '*'), ('review_votes', '*')
  )
  SELECT string_agg(c.table_name || '.' || c.column_name, ', ' ORDER BY c.table_name, c.column_name)
  INTO v_unknown
  FROM information_schema.columns AS c
  JOIN information_schema.tables AS t
    ON t.table_schema = c.table_schema
    AND t.table_name = c.table_name
    AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'cartlify'
    AND NOT EXISTS (
      SELECT 1
      FROM known AS k
      WHERE k.table_name = c.table_name
        AND k.column_name IN (c.column_name, '*')
    );

  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'ANONYMIZE_UNKNOWN_DATA: %', v_unknown
      USING HINT = 'decide whether it holds personal data and name it in db/tools/anonymize_prod_copy.sql';
  END IF;
END
$$;

------------------------------------------------------------
-- 2. PEOPLE
------------------------------------------------------------
-- a buyer, and a deleted account of the staff, becomes user+<id>@example.com: the domain is
-- reserved, a mail to it reaches nobody. A deleted account keeps its name (Guest), a name of a
-- person becomes User <id>; no phone, no photo; an account of a provider stays one, under an id
-- no provider gives
UPDATE cartlify.users
SET
  email = 'user+' || id || '@example.com',
  name = CASE
    WHEN name IS NULL OR "deletedAt" IS NOT NULL THEN name
    ELSE 'User ' || id
  END,
  phone = NULL,
  "avatarUrl" = NULL,
  "publicId" = NULL,
  "passwordHash" = CASE
    WHEN "passwordHash" IS NULL THEN NULL
    ELSE nullif(:'password_hash', '')
  END,
  "providerSub" = CASE
    WHEN "providerSub" IS NULL THEN NULL
    ELSE 'anonymized-' || id
  END
WHERE NOT (
  role IN ('ADMIN', 'ROOT')
  AND "deletedAt" IS NULL
);

-- the sessions and the links of prod: their hashes are secrets, and no session of prod is one of dev
DELETE FROM cartlify.user_tokens;

-- a login keeps the email of its account, not where and from what browser it came
UPDATE cartlify.login_logs AS l
SET
  email = (
    SELECT u.email
    FROM cartlify.users AS u
    WHERE u.id = l."userId"
  ),
  "ipAddress" = NULL,
  "userAgent" = NULL;

------------------------------------------------------------
-- 3. ORDERS
------------------------------------------------------------
-- the address and the recipient of an order are made up, a confirmed order has all four
-- (orders_confirmed_shipping_chk); the note of the buyer goes
UPDATE cartlify.orders
SET
  "shippingAddress" = CASE
    WHEN confirmed OR "shippingAddress" IS NOT NULL THEN 'Address of order ' || id
  END,
  "recipientFirstName" = CASE
    WHEN confirmed OR "recipientFirstName" IS NOT NULL THEN 'Recipient'
  END,
  "recipientLastName" = CASE
    WHEN confirmed OR "recipientLastName" IS NOT NULL THEN 'Customer'
  END,
  "recipientPhone" = CASE
    WHEN confirmed OR "recipientPhone" IS NOT NULL THEN '+10000000000'
  END,
  note = NULL
WHERE confirmed
  OR "shippingAddress" IS NOT NULL
  OR "recipientFirstName" IS NOT NULL
  OR "recipientLastName" IS NOT NULL
  OR "recipientPhone" IS NOT NULL
  OR note IS NOT NULL;

------------------------------------------------------------
-- 4. CHATS
------------------------------------------------------------
-- every message, of the bot and of an admin too: an answer quotes what the person wrote
UPDATE cartlify.chat_messages
SET
  content = 'Message ' || id;

UPDATE cartlify.chat_threads AS t
SET
  "lastMessagePreview" = (
    SELECT m.content
    FROM cartlify.chat_messages AS m
    WHERE m."threadId" = t.id
    ORDER BY m."createdAt" DESC, m.id DESC
    LIMIT 1
  )
WHERE "lastMessagePreview" IS NOT NULL;

------------------------------------------------------------
-- 5. THE ADMIN LOG
------------------------------------------------------------
-- the address and the browser of each request go; of the changes, the photo, the contacts and the
-- text of a review taken down are the person's, the rest is the work of the shop
CREATE FUNCTION pg_temp.anonymized (p_change jsonb, p_key text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_change ? p_key AND jsonb_typeof(p_change -> p_key) <> 'null'
      THEN jsonb_set(p_change, ARRAY[p_key], '"anonymized"')
    ELSE p_change
  END
$$;

UPDATE cartlify.admin_audit_log AS a
SET
  ip = NULL,
  "userAgent" = NULL,
  meta = CASE
    WHEN a."entityType" IN ('user', 'review') AND jsonb_typeof(a.meta) = 'array' THEN (
      SELECT jsonb_agg(
        CASE
          WHEN x.change ->> 'field' IN ('avatar', 'comment', 'email', 'name', 'phone')
            THEN pg_temp.anonymized(pg_temp.anonymized(x.change, 'old'), 'new')
          ELSE x.change
        END
        ORDER BY x.n
      )
      FROM jsonb_array_elements(a.meta) WITH ORDINALITY AS x (change, n)
    )
    ELSE a.meta
  END
WHERE a.ip IS NOT NULL
  OR a."userAgent" IS NOT NULL
  OR (
    a."entityType" IN ('user', 'review')
    AND jsonb_typeof(a.meta) = 'array'
    AND jsonb_array_length(a.meta) > 0
  );

------------------------------------------------------------
-- 6. CHECK
------------------------------------------------------------
-- nothing of a person is left: a miss stops the copy before anything is dumped
DO $$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(what, ', ')
  INTO v_left
  FROM (
    SELECT 'users' AS what
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.users
      WHERE NOT (role IN ('ADMIN', 'ROOT') AND "deletedAt" IS NULL)
        AND (
          email <> 'user+' || id || '@example.com'
          OR phone IS NOT NULL
          OR "avatarUrl" IS NOT NULL
          OR "publicId" IS NOT NULL
        )
    )
    UNION ALL
    SELECT 'user_tokens'
    WHERE EXISTS (SELECT 1 FROM cartlify.user_tokens)
    UNION ALL
    SELECT 'login_logs'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.login_logs
      WHERE "ipAddress" IS NOT NULL OR "userAgent" IS NOT NULL
    )
    UNION ALL
    SELECT 'orders'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.orders
      WHERE note IS NOT NULL
        OR "shippingAddress" <> 'Address of order ' || id
        OR "recipientPhone" <> '+10000000000'
    )
    UNION ALL
    SELECT 'chat_messages'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.chat_messages
      WHERE content <> 'Message ' || id
    )
    UNION ALL
    SELECT 'admin_audit_log'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.admin_audit_log
      WHERE ip IS NOT NULL OR "userAgent" IS NOT NULL
    )
  ) AS missed;

  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ANONYMIZE_INCOMPLETE: %', v_left;
  END IF;
END
$$;

COMMIT;
