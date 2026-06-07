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
            AND NOT (
              "adminRequestedAt" IS NOT NULL
              AND "adminUnreadSince" IS NOT NULL
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
-- PRICE CHANGE LOG: prices/value >= 0
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_change_non_negative'
  ) THEN
    ALTER TABLE cartlify.product_price_change_logs
      ADD CONSTRAINT price_change_non_negative
      CHECK ("oldPrice" >= 0 AND "newPrice" >= 0 AND value >= 0);
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
-- PRODUCTS: stock non-negative
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
CREATE INDEX IF NOT EXISTS chat_threads_admin_waiting_queue_idx ON cartlify.chat_threads ("adminUnreadSince" ASC, "lastMessageAt" DESC)
WHERE
  status = 'open'
  AND type = 'admin'
  AND "adminUnreadSince" IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_threads_admin_active_queue_idx ON cartlify.chat_threads ("lastMessageAt" DESC)
WHERE
  status = 'open'
  AND type = 'admin'
  AND "adminRequestedAt" IS NULL
  AND "adminUnreadSince" IS NULL;

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