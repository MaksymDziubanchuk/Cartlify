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
      -- the right of an admin to run the newsletters: the staff keep their accounts as they are, and
      -- a flag names no one
      ('users', 'canManageNewsletters'),
      -- the right of an admin to handle the money: a flag as well
      ('users', 'canManageMoney'),
      ('user_tokens', 'id'), ('user_tokens', 'userId'), ('user_tokens', 'type'),
      ('user_tokens', 'token'), ('user_tokens', 'expiresAt'), ('user_tokens', 'usedAt'),
      ('user_tokens', 'createdAt'), ('user_tokens', 'revokedAt'), ('user_tokens', 'sessionId'),
      ('user_tokens', 'userAgent'),
      ('login_logs', 'id'), ('login_logs', 'userId'), ('login_logs', 'email'),
      ('login_logs', 'role'), ('login_logs', 'ipAddress'), ('login_logs', 'userAgent'),
      ('login_logs', 'event'), ('login_logs', 'createdAt'),
      ('legal_acceptances', 'id'), ('legal_acceptances', 'userId'),
      ('legal_acceptances', 'documentId'), ('legal_acceptances', 'orderId'),
      ('legal_acceptances', 'ip'), ('legal_acceptances', 'userAgent'),
      ('legal_acceptances', 'event'), ('legal_acceptances', 'createdAt'),
      ('orders', 'id'), ('orders', 'userId'), ('orders', 'status'), ('orders', 'total'),
      ('orders', 'createdAt'), ('orders', 'updatedAt'), ('orders', 'confirmed'),
      ('orders', 'reservationExpiresAt'), ('orders', 'paymentId'), ('orders', 'paymentProvider'),
      ('orders', 'cancelledAt'), ('orders', 'paidAt'), ('orders', 'deliveredAt'),
      ('orders', 'withdrawalDays'), ('orders', 'returnShippingPaidBy'), ('orders', 'returnStatus'),
      ('orders', 'holds'), ('orders', 'fraudWarnedAt'),
      -- the number and the link of a parcel (a send of the order, a parcel of a statement) lead to
      -- the person it goes to or comes from, they change below; what the buyer paid the carrier is
      -- a sum, no personal data
      ('order_shipments', 'id'), ('order_shipments', 'orderId'), ('order_shipments', 'returnId'),
      ('order_shipments', 'direction'), ('order_shipments', 'carrier'),
      ('order_shipments', 'trackingNumber'), ('order_shipments', 'trackingUrl'),
      ('order_shipments', 'expense'), ('order_shipments', 'shippedAt'),
      ('order_shipments', 'rolledBackAt'), ('order_shipments', 'recordedById'),
      ('order_shipments', 'confirmedAt'), ('order_shipments', 'confirmedById'),
      ('order_shipments', 'buyerPaid'), ('order_shipments', 'createdAt'),
      ('order_shipments', 'updatedAt'),
      ('order_deliveries', 'orderId'), ('order_deliveries', 'method'),
      ('order_deliveries', 'recipientFirstName'), ('order_deliveries', 'recipientLastName'),
      ('order_deliveries', 'recipientPhone'), ('order_deliveries', 'country'),
      ('order_deliveries', 'postalCode'), ('order_deliveries', 'city'),
      ('order_deliveries', 'street'), ('order_deliveries', 'house'),
      ('order_deliveries', 'apartment'), ('order_deliveries', 'note'),
      ('order_deliveries', 'price'), ('order_deliveries', 'createdAt'),
      ('order_deliveries', 'updatedAt'),
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
      ('admin_audit_log', 'action'), ('admin_audit_log', 'event'), ('admin_audit_log', 'meta'),
      ('admin_audit_log', 'ip'),
      ('admin_audit_log', 'userAgent'), ('admin_audit_log', 'createdAt'),
      -- the stock log is the admin log of the stock: the address and the browser of the request go
      ('stock_log', 'id'), ('stock_log', 'actorId'), ('stock_log', 'actorRole'),
      ('stock_log', 'productId'), ('stock_log', 'variantId'), ('stock_log', 'event'),
      ('stock_log', 'quantityChange'), ('stock_log', 'stockAfter'), ('stock_log', 'meta'),
      ('stock_log', 'deliveryId'), ('stock_log', 'writeOffId'), ('stock_log', 'orderId'),
      ('stock_log', 'returnItemId'), ('stock_log', 'ip'), ('stock_log', 'userAgent'), ('stock_log', 'createdAt'),
      -- the money journal: the address and the browser of the request, the words of the provider
      -- and the notes of root go below; the rest is money, ids and states
      ('money_log', 'id'), ('money_log', 'actorId'), ('money_log', 'actorRole'),
      ('money_log', 'event'), ('money_log', 'purpose'), ('money_log', 'part'),
      ('money_log', 'amount'), ('money_log', 'currency'), ('money_log', 'orderId'),
      ('money_log', 'userId'), ('money_log', 'returnId'),
      ('money_log', 'orderShipmentId'), ('money_log', 'disputeId'), ('money_log', 'coversId'),
      ('money_log', 'provider'), ('money_log', 'paymentId'), ('money_log', 'refundId'),
      ('money_log', 'transferKey'), ('money_log', 'stripeTxId'), ('money_log', 'bankReference'),
      ('money_log', 'byDashboard'), ('money_log', 'state'), ('money_log', 'stateAt'),
      ('money_log', 'failure'), ('money_log', 'failureText'), ('money_log', 'method'),
      ('money_log', 'note'), ('money_log', 'happenedAt'), ('money_log', 'moneyUse'),
      ('money_log', 'meta'), ('money_log', 'ip'), ('money_log', 'userAgent'),
      ('money_log', 'createdAt'),
      -- a statement of return keeps the name and the email of whoever made it, the words of the
      -- buyer, and the address and the browser of the request: they change below; the rows hold
      -- the goods and the money, no personal data
      ('returns', 'id'), ('returns', 'orderId'), ('returns', 'extendsId'), ('returns', 'statedAt'),
      ('returns', 'source'), ('returns', 'createdById'), ('returns', 'basis'),
      ('returns', 'reason'), ('returns', 'description'), ('returns', 'contactName'),
      ('returns', 'contactEmail'), ('returns', 'ip'), ('returns', 'userAgent'),
      ('returns', 'splitFromId'),
      -- the number of the statement in its order, and when and by which admin it was accepted: the
      -- work of the shop, no personal data
      ('returns', 'number'), ('returns', 'acceptedAt'), ('returns', 'acceptedById'),
      ('returns', 'closedAt'), ('returns', 'closedById'),
      ('returns', 'closeCode'), ('returns', 'closeNote'),
      ('returns', 'refundedTotal'),
      ('returns', 'createdAt'), ('returns', 'updatedAt'),
      ('return_items', 'id'), ('return_items', 'returnId'), ('return_items', 'orderItemId'),
      ('return_items', 'quantity'), ('return_items', 'goods'),
      ('return_items', 'notAcceptedReason'), ('return_items', 'money'), ('return_items', 'amount'),
      ('return_items', 'goodsSetAt'), ('return_items', 'goodsSetById'),
      ('return_items', 'amountNote'), ('return_items', 'refusedCode'), ('return_items', 'moneyLogId'),
      ('return_items', 'backShipmentId'),
      ('return_items', 'createdAt'), ('return_items', 'updatedAt'),
      -- a review is public: the shop shows it with its author, whose name changes above
      ('reviews', 'id'), ('reviews', 'productId'), ('reviews', 'userId'), ('reviews', 'rating'),
      ('reviews', 'comment'), ('reviews', 'createdAt'), ('reviews', 'downVotes'),
      ('reviews', 'upVotes'), ('reviews', 'updatedAt'),
      -- a subscription to the newsletters keeps the address of whoever asked, the hashes of the links
      -- of the mails it was sent (they open the page of the subscription and the unsubscribe) and the
      -- HMAC of the address
      -- (a pseudonym of it, made with a secret the copy does not hold, the key of the blocklist); the
      -- journal of a subscription keeps the address and the browser of each request. They change
      -- below
      ('newsletter_subscriptions', 'id'), ('newsletter_subscriptions', 'email'),
      ('newsletter_subscriptions', 'emailHmac'), ('newsletter_subscriptions', 'userId'),
      ('newsletter_subscriptions', 'source'), ('newsletter_subscriptions', 'locale'),
      ('newsletter_subscriptions', 'status'), ('newsletter_subscriptions', 'confirmHash'),
      ('newsletter_subscriptions', 'confirmExpiresAt'), ('newsletter_subscriptions', 'manageSalt'),
      ('newsletter_subscriptions', 'manageHash'), ('newsletter_subscriptions', 'lastConfirmMailAt'),
      ('newsletter_subscriptions', 'lastAlreadyMailAt'), ('newsletter_subscriptions', 'createdAt'),
      ('newsletter_subscriptions', 'confirmedAt'), ('newsletter_subscriptions', 'endedAt'),
      ('newsletter_subscriptions', 'endReason'), ('newsletter_subscriptions', 'updatedAt'),
      ('newsletter_subscriptions', 'unsubscribeHash'), ('newsletter_subscriptions', 'endedUserId'),
      ('newsletter_subscription_events', 'id'), ('newsletter_subscription_events', 'subscriptionId'),
      ('newsletter_subscription_events', 'event'), ('newsletter_subscription_events', 'place'),
      ('newsletter_subscription_events', 'ip'), ('newsletter_subscription_events', 'userAgent'),
      ('newsletter_subscription_events', 'locale'), ('newsletter_subscription_events', 'campaignId'),
      ('newsletter_subscription_events', 'privacyVersion'), ('newsletter_subscription_events', 'actorId'),
      ('newsletter_subscription_events', 'createdAt'),
      -- tables with no personal data: the catalog, the stock, the money, what links them
      ('_prisma_migrations', '*'), ('admin_alert_settings', '*'), ('categories', '*'),
      ('legal_documents', '*'),
      -- the manufacturers and the persons responsible in the EU: business data the card of a product shows
      ('parties', '*'),
      -- the documents of products and the directory of characteristics: catalog data
      ('documents', '*'), ('product_documents', '*'),
      ('attribute_groups', '*'), ('attributes', '*'), ('attribute_options', '*'),
      ('category_attributes', '*'),
      -- the variants of the products and the pictures each one shows: catalog data
      ('product_variants', '*'), ('variant_images', '*'), ('variant_attribute_values', '*'),
      ('favorites', '*'), ('order_batch_allocations', '*'), ('order_items', '*'),
      ('product_batches', '*'), ('product_images', '*'), ('product_price_change_logs', '*'),
      ('products', '*'), ('review_votes', '*'),
      -- the campaigns of the newsletters are the shop's own text, made by its staff; a mail of a
      -- campaign is a row of ids and a state, with no address; the blocklist holds only the HMACs of
      -- addresses, who blocked them and why, and stays as it is (a copy without the secret cannot
      -- tell whose they are)
      ('newsletter_campaigns', '*'), ('newsletter_recipients', '*'),
      ('newsletter_form_blocklist', '*'),
      -- the disputes of the payments: ids, states and dates
      ('payment_disputes', '*'),
      -- the data of the shop (its name, its contacts, the languages): the shop's, not a person's
      ('shop_settings', '*')
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

-- a subscription to the newsletters: the address of a subscription of an account is the address its
-- account has now (made up above for a buyer; the profile finds the subscription by it), the address
-- of a subscription of the form becomes newsletter+<id>@example.com - lower case, one at sign, and
-- one for each subscription, so the unique index of the live addresses and the check of the table
-- hold. The hashes of the links (the confirmation, the page of the subscription and the unsubscribe
-- button of the mail clients) are of tokens that sit in mails prod sent: the copy gets the hashes of
-- random values nobody holds, so such a link opens nothing on dev. The HMAC of the address stays, as
-- in the blocklist: it names no one without the secret of prod (a subscription an admin erased has
-- none, and stays without). The account that ended a subscription of the form (endedUserId) is an id
-- of an account of the copy, which names no one. The language, the state, the dates stay.
UPDATE cartlify.newsletter_subscriptions AS s
SET
  email = CASE
    WHEN s."userId" IS NOT NULL THEN (
      SELECT lower(btrim(u.email))
      FROM cartlify.users AS u
      WHERE u.id = s."userId"
    )
    ELSE 'newsletter+' || s.id || '@example.com'
  END,
  "confirmHash" = CASE
    WHEN s."confirmHash" IS NOT NULL THEN encode(
      sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'
    )
  END,
  "manageHash" = encode(
    sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'
  ),
  "unsubscribeHash" = encode(
    sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'
  );

-- the journal of a subscription keeps what happened and when, not where and from what browser
UPDATE cartlify.newsletter_subscription_events
SET
  ip = NULL,
  "userAgent" = NULL;

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

-- a consent keeps what was accepted and when, not where and from what browser
UPDATE cartlify.legal_acceptances
SET
  ip = NULL,
  "userAgent" = NULL;

------------------------------------------------------------
-- 3. ORDERS
------------------------------------------------------------
-- the recipient and the address of an order are made up (the method and the country stay: they
-- name no one; the check of the table needs the whole address of a manual delivery); the note of
-- the buyer goes
UPDATE cartlify.order_deliveries
SET
  "recipientFirstName" = 'Recipient',
  "recipientLastName" = 'Customer',
  "recipientPhone" = '+10000000000',
  "postalCode" = CASE WHEN "postalCode" IS NOT NULL THEN '00000' END,
  city = CASE WHEN city IS NOT NULL THEN 'City' END,
  street = CASE WHEN street IS NOT NULL THEN 'Street of order ' || "orderId" END,
  house = CASE WHEN house IS NOT NULL THEN '1' END,
  apartment = NULL,
  note = NULL;

-- a statement of return: the name and the email are made up like the recipient of an order, the
-- words of the buyer and the address and the browser of the request go; the moments, the reason, the
-- source, the goods and the money stay
UPDATE cartlify.returns
SET
  "contactName" = 'Recipient Customer',
  "contactEmail" = 'return+' || id || '@example.com',
  description = NULL,
  ip = NULL,
  "userAgent" = NULL,
  "closeNote" = CASE WHEN "closeNote" IS NOT NULL THEN 'Closed by the shop' END;

-- the note of root on a row of a statement goes (the money of the row is in the money journal)
UPDATE cartlify.return_items
SET
  "amountNote" = CASE WHEN "amountNote" IS NOT NULL THEN 'Lowered by the shop' END;

-- the number and the link of a parcel are made up: they lead to the person the parcel goes to
UPDATE cartlify.order_shipments
SET
  "trackingNumber" = CASE WHEN "trackingNumber" IS NOT NULL THEN 'TRACK' || id END,
  "trackingUrl" = CASE WHEN "trackingUrl" IS NOT NULL THEN 'https://example.com/track/' || id END;


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
    WHEN a."entityType" IN ('user', 'review', 'order') AND jsonb_typeof(a.meta) = 'array' THEN (
      SELECT jsonb_agg(
        CASE
          WHEN x.change ->> 'field' IN (
            'avatar', 'comment', 'email', 'name', 'phone', 'contactName', 'contactEmail', 'description',
            -- an order: the person and the address of the delivery, the note, the send with its
            -- number and link
            'recipientFirstName', 'recipientLastName', 'recipientPhone', 'postalCode', 'city',
            'street', 'house', 'apartment', 'note', 'shipment', 'trackingNumber', 'trackingUrl'
          )
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
    a."entityType" IN ('user', 'review', 'order')
    AND jsonb_typeof(a.meta) = 'array'
    AND jsonb_array_length(a.meta) > 0
  );

-- the money journal: the address and the browser of the request go, the words of the provider
-- (failureText) go, and the note of root becomes the made-up text the retention cleanup writes; the
-- sums, the ids and the states are the money of the shop and stay
UPDATE cartlify.money_log
SET
  ip = NULL,
  "userAgent" = NULL,
  "failureText" = NULL,
  note = CASE
    WHEN note IS NULL THEN NULL
    WHEN event = 'money.received' THEN 'Received outside the app'
    ELSE 'Sent outside the app'
  END
WHERE ip IS NOT NULL
  OR "userAgent" IS NOT NULL
  OR "failureText" IS NOT NULL
  OR note IS NOT NULL;

-- the stock log: the address and the browser of the request go, the rest is the work of the shop
-- (the suppliers and the invoices of its deliveries are business data)
UPDATE cartlify.stock_log
SET
  ip = NULL,
  "userAgent" = NULL
WHERE ip IS NOT NULL
  OR "userAgent" IS NOT NULL;

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
    SELECT 'legal_acceptances'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.legal_acceptances
      WHERE ip IS NOT NULL OR "userAgent" IS NOT NULL
    )
    UNION ALL
    SELECT 'newsletter_subscriptions'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.newsletter_subscriptions AS s
      WHERE (s."userId" IS NULL AND s.email <> 'newsletter+' || s.id || '@example.com')
        OR (
          s."userId" IS NOT NULL
          AND s.email IS DISTINCT FROM (
            SELECT lower(btrim(u.email))
            FROM cartlify.users AS u
            WHERE u.id = s."userId"
          )
        )
    )
    UNION ALL
    SELECT 'newsletter_subscription_events'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.newsletter_subscription_events
      WHERE ip IS NOT NULL OR "userAgent" IS NOT NULL
    )
    UNION ALL
    SELECT 'returns'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.returns
      WHERE description IS NOT NULL
        OR ip IS NOT NULL
        OR "userAgent" IS NOT NULL
        OR ("closeNote" IS NOT NULL AND "closeNote" <> 'Closed by the shop')
        OR "contactName" <> 'Recipient Customer'
        OR "contactEmail" <> 'return+' || id || '@example.com'
    )
    UNION ALL
    SELECT 'return_items'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.return_items
      WHERE "amountNote" IS NOT NULL AND "amountNote" <> 'Lowered by the shop'
    )
    UNION ALL
    SELECT 'order_deliveries'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.order_deliveries
      WHERE note IS NOT NULL
        OR apartment IS NOT NULL
        OR street <> 'Street of order ' || "orderId"
        OR "recipientPhone" <> '+10000000000'
    )
    UNION ALL
    SELECT 'order_shipments'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.order_shipments
      WHERE ("trackingNumber" IS NOT NULL AND "trackingNumber" <> 'TRACK' || id)
        OR ("trackingUrl" IS NOT NULL AND "trackingUrl" <> 'https://example.com/track/' || id)
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
    UNION ALL
    SELECT 'money_log'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.money_log
      WHERE ip IS NOT NULL OR "userAgent" IS NOT NULL OR "failureText" IS NOT NULL
    )
    UNION ALL
    SELECT 'stock_log'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.stock_log
      WHERE ip IS NOT NULL OR "userAgent" IS NOT NULL
    )
    UNION ALL
    SELECT 'admin_audit_log changes of orders'
    WHERE EXISTS (
      SELECT 1
      FROM cartlify.admin_audit_log AS a,
        jsonb_array_elements(CASE WHEN jsonb_typeof(a.meta) = 'array' THEN a.meta ELSE '[]'::jsonb END) AS ch
      WHERE a."entityType" = 'order'
        AND ch ->> 'field' IN (
          'recipientFirstName', 'recipientLastName', 'recipientPhone', 'postalCode', 'city',
          'street', 'house', 'apartment', 'note', 'shipment', 'trackingNumber', 'trackingUrl'
        )
        AND (
          coalesce(ch -> 'old', 'null'::jsonb) NOT IN ('null'::jsonb, '"anonymized"'::jsonb)
          OR coalesce(ch -> 'new', 'null'::jsonb) NOT IN ('null'::jsonb, '"anonymized"'::jsonb)
        )
    )
  ) AS missed;

  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ANONYMIZE_INCOMPLETE: %', v_left;
  END IF;
END
$$;

COMMIT;
