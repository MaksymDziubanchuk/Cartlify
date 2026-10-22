-- everything below is created and owned by cartlify_owner, whoever runs the script
SET ROLE cartlify_owner;

----------------------------------------
-- REVIEWS: rating + votes
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reviews_rating_1_5'
  ) THEN
    ALTER TABLE cartlify.reviews
      ADD CONSTRAINT reviews_rating_1_5
      CHECK (rating BETWEEN 1 AND 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reviews_votes_non_negative'
  ) THEN
    ALTER TABLE cartlify.reviews
      ADD CONSTRAINT reviews_votes_non_negative
      CHECK ("upVotes" >= 0 AND "downVotes" >= 0);
  END IF;
END $$;

----------------------------------------
-- PRODUCTS: price + counters
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_price_non_negative'
  ) THEN
    ALTER TABLE cartlify.products
      ADD CONSTRAINT products_price_non_negative
      CHECK (price >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_counters_non_negative'
  ) THEN
    ALTER TABLE cartlify.products
      ADD CONSTRAINT products_counters_non_negative
      CHECK (
        views >= 0
        AND popularity >= 0
        AND "reviewsCount" >= 0
        AND "avgRating" >= 0
        AND "avgRating" <= 5
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_pop_override_non_negative'
  ) THEN
    ALTER TABLE cartlify.products
      ADD CONSTRAINT products_pop_override_non_negative
      CHECK ("popularityOverride" IS NULL OR "popularityOverride" >= 0);
  END IF;

  -- a sale has a price and an end, or neither; its price is 0 (free) or more and below the price.
  -- A price down to the sale price or below empties the sale before this check (db/05)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_sale_chk'
  ) THEN
    ALTER TABLE cartlify.products
      ADD CONSTRAINT products_sale_chk
      CHECK (
        ("salePrice" IS NULL AND "saleEndsAt" IS NULL)
        OR (
          "salePrice" IS NOT NULL
          AND "saleEndsAt" IS NOT NULL
          AND "salePrice" >= 0
          AND "salePrice" < price
        )
      );
  END IF;
END $$;

----------------------------------------
-- FAVORITES / CHAT_THREADS: ownership + chat state
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'favorites_actor_xor_chk'
  ) THEN
    ALTER TABLE cartlify.favorites
      ADD CONSTRAINT favorites_actor_xor_chk
      CHECK (("userId" IS NULL) <> ("guestId" IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_threads_actor_xor_chk'
  ) THEN
    ALTER TABLE cartlify.chat_threads
      ADD CONSTRAINT chat_threads_actor_xor_chk
      CHECK (("userId" IS NULL) <> ("guestId" IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_threads_unread_non_negative'
  ) THEN
    ALTER TABLE cartlify.chat_threads
      ADD CONSTRAINT chat_threads_unread_non_negative
      CHECK ("unreadCount" >= 0);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_threads_admin_state_chk'
  ) THEN
    ALTER TABLE cartlify.chat_threads
      DROP CONSTRAINT chat_threads_admin_state_chk;
  END IF;

  ALTER TABLE cartlify.chat_threads
  ADD CONSTRAINT chat_threads_admin_state_chk
  CHECK (
    (
      type = 'bot'
      AND "adminRequestedAt" IS NULL
      AND "adminUnreadSince" IS NULL
    )
    OR (
      type = 'admin'
      AND (
        (
          status = 'closed'
          AND "adminRequestedAt" IS NULL
          AND "adminUnreadSince" IS NULL
        )
        OR (
          status = 'open'
          AND (
            "adminRequestedAt" IS NOT NULL
            OR "adminUnreadSince" IS NOT NULL
          )
        )
      )
    )
  );
END $$;

----------------------------------------
-- ORDERS / ORDER_ITEMS: totals >= 0, qty > 0
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_total_non_negative'
  ) THEN
    ALTER TABLE cartlify.orders
      ADD CONSTRAINT orders_total_non_negative
      CHECK (total >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_qty_positive'
  ) THEN
    ALTER TABLE cartlify.order_items
      ADD CONSTRAINT order_items_qty_positive
      CHECK (quantity > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_prices_non_negative'
  ) THEN
    ALTER TABLE cartlify.order_items
      ADD CONSTRAINT order_items_prices_non_negative
      CHECK ("unitPrice" >= 0 AND "totalPrice" >= 0);
  END IF;
END $$;

----------------------------------------
-- ORDERS: status must match confirmed / reservation / payment fields
----------------------------------------
-- NOT VALID: the rule applies to new and updated rows, rows written before it are not rechecked
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_state_consistency_chk'
  ) THEN
    ALTER TABLE cartlify.orders
      DROP CONSTRAINT orders_state_consistency_chk;
  END IF;

  ALTER TABLE cartlify.orders
    ADD CONSTRAINT orders_state_consistency_chk
    CHECK (
      (
        status IN ('pending', 'unconfirmed')
        AND confirmed = false
        AND "reservationExpiresAt" IS NULL
        AND "paymentId" IS NULL
      )
      OR (
        status = 'waiting'
        AND confirmed = true
        AND "reservationExpiresAt" IS NOT NULL
        AND "paymentId" IS NULL
      )
      OR (
        status = 'paid'
        AND confirmed = true
        AND "reservationExpiresAt" IS NULL
        AND "paymentId" IS NOT NULL
      )
      OR (
        status IN ('shipped', 'delivered', 'cancelled')
        AND confirmed = true
      )
    ) NOT VALID;
END $$;

----------------------------------------
-- ORDERS: a payment always names who took it
----------------------------------------
-- the payment id and the provider are both empty or both set; pay_order sets them together,
-- the migration that brought the provider marked the payments recorded before it as stripe
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_provider_chk'
  ) THEN
    ALTER TABLE cartlify.orders
      DROP CONSTRAINT orders_payment_provider_chk;
  END IF;

  ALTER TABLE cartlify.orders
    ADD CONSTRAINT orders_payment_provider_chk
    CHECK (("paymentId" IS NULL) = ("paymentProvider" IS NULL));
END $$;

----------------------------------------
-- ORDERS: recipient fields keep the form the server writes
----------------------------------------
-- names are trimmed, 1-100 characters, without digits; the server also needs a letter in them,
-- the database does not check letters: what is a letter depends on the database locale
-- the phone is a plus and 8-15 digits, the first is not zero, the same as the profile phone
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_recipient_first_name_chk'
  ) THEN
    ALTER TABLE cartlify.orders
      DROP CONSTRAINT orders_recipient_first_name_chk;
  END IF;

  ALTER TABLE cartlify.orders
    ADD CONSTRAINT orders_recipient_first_name_chk
    CHECK (
      "recipientFirstName" IS NULL
      OR (
        char_length("recipientFirstName") BETWEEN 1 AND 100
        AND "recipientFirstName" = btrim("recipientFirstName")
        AND "recipientFirstName" !~ '[0-9]'
      )
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_recipient_last_name_chk'
  ) THEN
    ALTER TABLE cartlify.orders
      DROP CONSTRAINT orders_recipient_last_name_chk;
  END IF;

  ALTER TABLE cartlify.orders
    ADD CONSTRAINT orders_recipient_last_name_chk
    CHECK (
      "recipientLastName" IS NULL
      OR (
        char_length("recipientLastName") BETWEEN 1 AND 100
        AND "recipientLastName" = btrim("recipientLastName")
        AND "recipientLastName" !~ '[0-9]'
      )
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_recipient_phone_chk'
  ) THEN
    ALTER TABLE cartlify.orders
      DROP CONSTRAINT orders_recipient_phone_chk;
  END IF;

  ALTER TABLE cartlify.orders
    ADD CONSTRAINT orders_recipient_phone_chk
    CHECK (
      "recipientPhone" IS NULL
      OR "recipientPhone" ~ '^\+[1-9][0-9]{7,14}$'
    );
END $$;

----------------------------------------
-- ORDERS: a confirmed order has the whole shipping data
----------------------------------------
-- the confirm trigger refuses a confirm without it; this rule holds it for any other write
-- NOT VALID: rows confirmed before the recipient fields existed are not rechecked
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_confirmed_shipping_chk'
  ) THEN
    ALTER TABLE cartlify.orders
      DROP CONSTRAINT orders_confirmed_shipping_chk;
  END IF;

  ALTER TABLE cartlify.orders
    ADD CONSTRAINT orders_confirmed_shipping_chk
    CHECK (
      confirmed = false
      OR (
        "shippingAddress" IS NOT NULL
        AND btrim("shippingAddress") <> ''
        AND "recipientFirstName" IS NOT NULL
        AND "recipientLastName" IS NOT NULL
        AND "recipientPhone" IS NOT NULL
      )
    ) NOT VALID;
END $$;

----------------------------------------
-- USER_TOKENS: expires must be after created
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_tokens_expires_after_created'
  ) THEN
    ALTER TABLE cartlify.user_tokens
      ADD CONSTRAINT user_tokens_expires_after_created
      CHECK ("expiresAt" > "createdAt");
  END IF;
END $$;

----------------------------------------
-- PRICE CHANGE LOG: prices >= 0, the start of a sale goes down
----------------------------------------
DO $$
BEGIN
  -- the check that kept the value from going below 0 too (21.10.2026): a change down has a
  -- negative value; a temporary line, it goes once dev and prod match the reference
  ALTER TABLE cartlify.product_price_change_logs
    DROP CONSTRAINT IF EXISTS price_change_non_negative;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_change_prices_non_negative'
  ) THEN
    ALTER TABLE cartlify.product_price_change_logs
      ADD CONSTRAINT price_change_prices_non_negative
      CHECK ("oldPrice" >= 0 AND "newPrice" >= 0);
  END IF;

  -- a line with an end is the start of a sale: from the price down to the sale price
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_change_sale_below_price'
  ) THEN
    ALTER TABLE cartlify.product_price_change_logs
      ADD CONSTRAINT price_change_sale_below_price
      CHECK ("endsAt" IS NULL OR "newPrice" < "oldPrice");
  END IF;
END $$;

----------------------------------------
-- REVIEWS: require rating OR comment (cannot be both empty)
----------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reviews_rating_or_comment_required'
  ) THEN
    ALTER TABLE cartlify.reviews
      DROP CONSTRAINT reviews_rating_or_comment_required;
  END IF;

  ALTER TABLE cartlify.reviews
    ADD CONSTRAINT reviews_rating_or_comment_required
    CHECK (
      "rating" IS NOT NULL
      OR ("comment" IS NOT NULL AND btrim("comment") <> '')
    );
END $$;

----------------------------------------
-- PRODUCTS: stock non-negative, reserved stock within stock
----------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_stock_non_negative'
  ) THEN
    ALTER TABLE cartlify.products
      DROP CONSTRAINT products_stock_non_negative;
  END IF;

  ALTER TABLE cartlify.products
    ADD CONSTRAINT products_stock_non_negative
    CHECK ("stock" >= 0);

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_reserved_stock_within_stock'
  ) THEN
    ALTER TABLE cartlify.products
      DROP CONSTRAINT products_reserved_stock_within_stock;
  END IF;

  ALTER TABLE cartlify.products
    ADD CONSTRAINT products_reserved_stock_within_stock
    CHECK ("reservedStock" >= 0 AND "reservedStock" <= "stock");
END $$;

----------------------------------------
-- CHAT_MESSAGES: sender consistency + content
----------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_sender_consistency_chk'
  ) THEN
    ALTER TABLE cartlify.chat_messages
      DROP CONSTRAINT chat_messages_sender_consistency_chk;
  END IF;

  ALTER TABLE cartlify.chat_messages
    ADD CONSTRAINT chat_messages_sender_consistency_chk
    CHECK (
      (
        "senderType" IN ('user', 'admin')
        AND "senderId" IS NOT NULL
      )
      OR (
        "senderType" IN ('bot', 'guest')
        AND "senderId" IS NULL
      )
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_content_not_blank_chk'
  ) THEN
    ALTER TABLE cartlify.chat_messages
      DROP CONSTRAINT chat_messages_content_not_blank_chk;
  END IF;

  ALTER TABLE cartlify.chat_messages
    ADD CONSTRAINT chat_messages_content_not_blank_chk
    CHECK (length(btrim(content)) > 0);
END $$;

----------------------------------------
-- PRODUCT_IMAGES: one primary image per product
----------------------------------------
-- the cart, the orders and the lists show the primary image of a product; an image update deletes
-- the old images before it writes the new ones. Rows written before this rule are not cleaned:
-- if a product has two primary images already, the index stops this script until one goes by hand
CREATE UNIQUE INDEX IF NOT EXISTS product_images_one_primary_idx ON cartlify.product_images ("productId")
WHERE
  "isPrimary";

----------------------------------------
-- CHAT_THREADS: one open thread per actor
----------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_one_open_user_idx ON cartlify.chat_threads ("userId")
WHERE
  status = 'open'
  AND "userId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_one_open_guest_idx ON cartlify.chat_threads ("guestId")
WHERE
  status = 'open'
  AND "guestId" IS NOT NULL;

----------------------------------------
-- CHAT_THREADS: admin queues
----------------------------------------
DROP INDEX IF EXISTS cartlify.chat_threads_admin_waiting_queue_idx;

DROP INDEX IF EXISTS cartlify.chat_threads_admin_active_queue_idx;

CREATE INDEX chat_threads_admin_waiting_queue_idx ON cartlify.chat_threads ("adminRequestedAt" ASC, "lastMessageAt" DESC)
WHERE
  status = 'open'
  AND type = 'admin'
  AND "adminRequestedAt" IS NOT NULL
  AND "adminUnreadSince" IS NOT NULL;

CREATE INDEX chat_threads_admin_active_queue_idx ON cartlify.chat_threads ("adminUnreadSince" DESC, "lastMessageAt" DESC)
WHERE
  status = 'open'
  AND type = 'admin'
  AND "adminRequestedAt" IS NULL
  AND "adminUnreadSince" IS NOT NULL;

----------------------------------------
-- CHAT_THREADS: admin previous closed threads
----------------------------------------
CREATE INDEX IF NOT EXISTS chat_threads_closed_admin_user_history_idx ON cartlify.chat_threads ("userId", "lastMessageAt" DESC)
WHERE
  status = 'closed'
  AND type = 'admin'
  AND "userId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_threads_closed_admin_guest_history_idx ON cartlify.chat_threads ("guestId", "lastMessageAt" DESC)
WHERE
  status = 'closed'
  AND type = 'admin'
  AND "guestId" IS NOT NULL;

----------------------------------------
-- CHAT_MESSAGES: history and read updates
----------------------------------------
CREATE INDEX IF NOT EXISTS chat_messages_thread_created_idx ON cartlify.chat_messages ("threadId", "createdAt" ASC);

CREATE INDEX IF NOT EXISTS chat_messages_unread_by_thread_sender_idx ON cartlify.chat_messages ("threadId", "senderType")
WHERE
  "isRead" = false;

----------------------------------------
-- USERS: admin search by a part of the email
----------------------------------------
-- emails are stored in lower case (trg_users_before_write_email); the list of users looks for a
-- part of an address with ILIKE, a trigram index serves it from 3 characters on
CREATE INDEX IF NOT EXISTS users_email_trgm_idx ON cartlify.users USING gin (email cartlify.gin_trgm_ops);